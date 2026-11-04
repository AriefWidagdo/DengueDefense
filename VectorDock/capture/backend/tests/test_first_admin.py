"""First-admin prompt stays private; SQLite fixture, no Neon or Modal calls."""
from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app import first_admin
from app.bootstrap import initialize_placeholder_database
from app.models import Deployment, Operator, Sample
from app.security import verify_password


ARGS = ["--neon-project-id", "test-project", "--database-name", "vectordock", "--role-name", "test-owner"]


def test_operator_creates_admin_without_exposing_credentials(tmp_path, monkeypatch, capsys):
    engine = create_engine(f"sqlite:///{tmp_path / 'admin.sqlite3'}")
    initialize_placeholder_database(engine, "BUCK1")
    fake_db_password = "fake-secret-never-print-db-894"
    fake_admin_password = "fake-admin-password-8942"
    monkeypatch.setattr(first_admin.sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr(first_admin.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(
        stdout=f"postgresql://test-owner:{fake_db_password}@db.invalid/vectordock?sslmode=require"))
    monkeypatch.setattr(first_admin.getpass, "getpass", lambda prompt: fake_admin_password)
    monkeypatch.setattr(first_admin, "create_engine", lambda *args, **kwargs: engine)
    assert first_admin.main(ARGS) == 0
    output = capsys.readouterr()
    assert fake_db_password not in output.out + output.err
    assert fake_admin_password not in output.out + output.err
    with Session(engine) as db:
        op = db.query(Operator).one()
        assert op.username == "operator" and op.role == "admin"
        assert verify_password(fake_admin_password, op.password_hash)
        assert db.query(Deployment).count() == db.query(Sample).count() == 0
    assert first_admin.main(ARGS) == 2
    assert "already exists" in capsys.readouterr().err
    engine.dispose()


def test_refuses_noninteractive_terminal_before_contact(monkeypatch, capsys):
    monkeypatch.setattr(first_admin.sys.stdin, "isatty", lambda: False)
    monkeypatch.setattr(first_admin.subprocess, "run", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("must not run")))
    assert first_admin.main(ARGS) == 2
    assert "interactive terminal" in capsys.readouterr().err
