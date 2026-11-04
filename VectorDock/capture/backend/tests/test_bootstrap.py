"""Offline preparation for one new dedicated database; no cloud calls."""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import Session

from app.bootstrap import (BootstrapError, InitialRegistry, _database_url, initialize_empty_database,
                           initialize_first_admin, initialize_placeholder_database, main)
from app.config import ConfigError, load_settings
from app.main import create_app
from app.models import AuditRecord, Deployment, Operator, Sample, Trap, TrapGrant
from app.security import verify_password


TEST_PASSWORD = "test-only strong password 8942"


def registry(**changes):
    values = dict(
        trap_id="VD-PRINT-01", district_code="TEST-DISTRICT", site_id="TEST-SITE",
        placement="TEST placement", deployed_at=datetime.now(timezone.utc) - timedelta(days=1),
        username="test-admin", display_name="Test Admin",
    )
    values.update(changes)
    return InitialRegistry(**values)


def test_new_empty_database_bootstrap_and_real_api_login(tmp_path, monkeypatch):
    db_file = tmp_path / "new.sqlite3"
    engine = create_engine(f"sqlite:///{db_file}")
    initialize_empty_database(engine, registry(), TEST_PASSWORD)
    with Session(engine) as db:
        operator = db.query(Operator).one()
        assert operator.username == "test-admin" and operator.role == "admin"
        assert operator.is_test_identity is False
        assert operator.password_hash != TEST_PASSWORD and verify_password(TEST_PASSWORD, operator.password_hash)
        trap = db.get(Trap, "VD-PRINT-01")
        assert trap.site_id == "TEST-SITE" and trap.placement == "TEST placement"
        deployment = db.query(Deployment).one()
        assert deployment.trap_id == trap.trap_id and deployment.location_note == "TEST placement"
        assert deployment.end_at is None
        assert db.query(TrapGrant).one().operator_id == operator.id
        audit = db.query(AuditRecord).one()
        assert audit.actor_id == operator.id and audit.action == "initial_registry_created"
        assert TEST_PASSWORD not in str(audit.detail)
        assert db.query(Sample).count() == 0
    engine.dispose()
    for key, value in {
        "CAPTURE_ENV": "test", "DATABASE_URL": f"sqlite:///{db_file}",
        "CAPTURE_STORAGE_DIR": str(tmp_path / "storage"), "CAPTURE_MODAL_ENABLED": "0",
    }.items():
        monkeypatch.setenv(key, value)
    application = create_app(load_settings())
    with TestClient(application) as client:
        assert client.post("/api/auth/login", json={"username": "test-admin", "password": TEST_PASSWORD}).status_code == 200
        response = client.get("/api/traps/VD-PRINT-01")
        assert response.status_code == 200
        assert response.json()["trap_id"] == "VD-PRINT-01"
        assert response.json()["active_deployment"]["location_note"] == "TEST placement"
        assert response.json()["samples"] == []
    application.state.capture.session_factory.kw["bind"].dispose()


def test_placeholder_has_no_deployment_and_admin_is_created_separately(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'placeholder.sqlite3'}")
    initialize_placeholder_database(engine, "BUCK1")
    with Session(engine) as db:
        trap = db.get(Trap, "BUCK1")
        assert trap.is_test_fixture is True
        assert trap.district_code == "TEST" and trap.site_id == "TEST-PLACEHOLDER"
        assert trap.placement == "QR test only; not installed"
        assert db.query(Deployment).count() == db.query(Sample).count() == db.query(Operator).count() == 0
    initialize_first_admin(engine, "operator", "Operator", TEST_PASSWORD)
    with Session(engine) as db:
        operator = db.query(Operator).one()
        assert operator.role == "admin" and verify_password(TEST_PASSWORD, operator.password_hash)
        assert db.query(Deployment).count() == db.query(Sample).count() == 0
    with pytest.raises(BootstrapError, match="already exists"):
        initialize_first_admin(engine, "other", "Other", "different-password-123")
    with pytest.raises(BootstrapError, match="not empty"):
        initialize_placeholder_database(engine, "BUCK1")
    engine.dispose()


def test_placeholder_validation_and_first_admin_schema_gate(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'blank.sqlite3'}")
    with pytest.raises(BootstrapError):
        initialize_placeholder_database(engine, "bad trap")
    assert inspect(engine).get_table_names() == []
    with pytest.raises(ConfigError, match="schema is incomplete"):
        initialize_first_admin(engine, "operator", "Operator", TEST_PASSWORD)
    assert inspect(engine).get_table_names() == []
    engine.dispose()


def test_refuses_nonempty_schema_without_touching_existing_data(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'existing.sqlite3'}")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE unrelated (value TEXT NOT NULL)"))
        connection.execute(text("INSERT INTO unrelated VALUES ('preserve')"))
    with pytest.raises(BootstrapError, match="not empty"):
        initialize_empty_database(engine, registry(), TEST_PASSWORD)
    with engine.connect() as connection:
        assert connection.execute(text("SELECT value FROM unrelated")).scalar_one() == "preserve"
    assert inspect(engine).get_table_names() == ["unrelated"]
    engine.dispose()


def test_refuses_second_initialization_without_changing_first_registry(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'once.sqlite3'}")
    initialize_empty_database(engine, registry(), TEST_PASSWORD)
    with pytest.raises(BootstrapError, match="not empty"):
        initialize_empty_database(engine, registry(trap_id="VD-OTHER"), "different-password-123")
    with Session(engine) as db:
        assert db.query(Trap).count() == 1 and db.get(Trap, "VD-PRINT-01")
        assert db.query(Operator).count() == 1
        assert verify_password(TEST_PASSWORD, db.query(Operator).one().password_hash)
    engine.dispose()


@pytest.mark.parametrize("changes", [
    {"trap_id": "lowercase"}, {"trap_id": "A"}, {"trap_id": "VD 1"},
    {"district_code": ""}, {"site_id": " "}, {"placement": ""},
    {"username": "bad user"}, {"display_name": ""},
    {"deployed_at": datetime(2020, 1, 1)},
    {"deployed_at": datetime.now(timezone.utc) + timedelta(days=1)},
])
def test_invalid_real_registry_data_is_refused_before_schema_write(tmp_path, changes):
    engine = create_engine(f"sqlite:///{tmp_path / 'invalid.sqlite3'}")
    with pytest.raises(BootstrapError):
        initialize_empty_database(engine, registry(**changes), TEST_PASSWORD)
    assert inspect(engine).get_table_names() == []
    engine.dispose()


def test_weak_password_is_refused_before_schema_write(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'invalid-password.sqlite3'}")
    with pytest.raises(BootstrapError):
        initialize_empty_database(engine, registry(), "password")
    assert inspect(engine).get_table_names() == []
    engine.dispose()


def test_cli_requires_production_postgresql_tls_and_no_url_in_errors(monkeypatch, capsys):
    secret = "fake-password-do-not-print-147258"
    monkeypatch.setenv("CAPTURE_ENV", "test")
    monkeypatch.setenv("DATABASE_URL", f"postgresql://test:{secret}@db.example/vd?sslmode=require")
    with pytest.raises(BootstrapError, match="CAPTURE_ENV"):
        _database_url()
    monkeypatch.setenv("CAPTURE_ENV", "production")
    monkeypatch.setenv("DATABASE_URL", "sqlite:///should-not-be-created.sqlite3")
    with pytest.raises(BootstrapError, match="PostgreSQL"):
        _database_url()
    monkeypatch.setenv("DATABASE_URL", f"postgresql://test:{secret}@db.example/vd")
    with pytest.raises(BootstrapError, match="TLS"):
        _database_url()
    monkeypatch.setenv("DATABASE_URL", f"postgresql+psycopg://test:{secret}@db.example/vd?sslmode=require")
    assert _database_url().drivername == "postgresql+psycopg"
    monkeypatch.setenv("DATABASE_URL", f"postgresql://test:{secret}@db.example/vd?sslmode=require")
    assert _database_url().drivername == "postgresql+psycopg"
    # Missing explicit confirmation refuses before any terminal prompt or DB connection.
    exit_code = main(["--trap-id", "VD-01", "--district-code", "T", "--site-id", "T", "--placement", "test",
                      "--deployed-at", "2020-01-01T00:00:00+00:00", "--username", "test-admin", "--display-name", "Test"])
    assert exit_code == 2
    captured = capsys.readouterr()
    assert secret not in captured.out + captured.err
