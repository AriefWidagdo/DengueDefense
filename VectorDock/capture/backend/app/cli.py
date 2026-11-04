"""Command-line utilities for the VectorDock capture backend.

Subcommands:
- seed-fixtures: create test-only registry fixtures and test identities.
- add-operator / grant: operator and trap-grant management.
- qr: generate a QR label for one trap from a configurable capture base URL.
- export-openapi: write the versioned OpenAPI contract to openapi.json.

The seed command refuses to run against a production configuration and labels
every created trap, deployment, sample and identity as a test fixture. It
invents no real trap location: district and site values are TEST placeholders.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import secrets
import sys
from datetime import datetime, timezone

from .config import ConfigError, load_settings
from .db import create_db_engine, create_session_factory
from .models import (
    AuditRecord,
    Base,
    Deployment,
    Operator,
    Sample,
    Trap,
    TrapGrant,
)
from .security import hash_password

WEAK_PASSWORDS = {"password", "changeme", "12345678", "admin", "test", "qwerty"}


def _engine_and_session(args: argparse.Namespace):
    settings = load_settings()
    if settings.is_production:
        raise ConfigError("Refusing to mutate a production configuration from the CLI")
    if args.db:
        os.environ["DATABASE_URL"] = args.db
        settings = load_settings()
    engine = create_db_engine(settings)
    Base.metadata.create_all(engine)
    return settings, engine, create_session_factory(engine)


def _read_password(args: argparse.Namespace, prompt: str) -> str:
    if args.password_env:
        value = os.environ.get(args.password_env, "")
        if not value:
            raise ConfigError(f"Environment variable {args.password_env} is empty")
        return value
    value = getpass.getpass(prompt)
    if not value or value.strip().lower() in WEAK_PASSWORDS or len(value) < 10:
        raise ConfigError("Password must be at least 10 characters and not a common default")
    return value


def _add_operator(db, username: str, display_name: str, role: str, password: str, test_identity: bool) -> Operator:
    existing = db.query(Operator).filter(Operator.username == username).one_or_none()
    if existing is not None:
        print(f"Operator already exists: {username}")
        return existing
    operator = Operator(
        username=username,
        display_name=display_name,
        role=role,
        password_hash=hash_password(password),
        is_test_identity=test_identity,
    )
    db.add(operator)
    db.commit()
    return operator


def cmd_seed_fixtures(args: argparse.Namespace) -> int:
    settings, engine, factory = _engine_and_session(args)
    with factory() as db:
        worker_password = args.worker_password or ("test-only-" + secrets.token_urlsafe(12))
        reviewer_password = args.reviewer_password or ("test-only-" + secrets.token_urlsafe(12))
        worker = _add_operator(db, "test-worker", "Test Worker", "worker", worker_password, True)
        reviewer = _add_operator(db, "test-reviewer", "Test Reviewer", "reviewer", reviewer_password, True)
        trap = db.get(Trap, "VD-TEST-001")
        if trap is None:
            trap = Trap(
                trap_id="VD-TEST-001",
                district_code="TEST",
                site_id="TEST-SITE",
                placement="test fixture - not a real trap location",
                trap_design_version="test-v1",
                lure_version="test-lure",
                surface_protocol="test protocol only",
                is_test_fixture=True,
            )
            db.add(trap)
        deployment = (
            db.query(Deployment).filter(Deployment.trap_id == "VD-TEST-001", Deployment.end_at.is_(None)).one_or_none()
        )
        if deployment is None:
            deployment = Deployment(
                trap_id="VD-TEST-001",
                district_code="TEST",
                site_id="TEST-SITE",
                location_note="test fixture - not a real trap location",
                start_at=datetime.now(timezone.utc),
            )
            db.add(deployment)
            db.flush()
            db.add(
                Sample(
                    trap_id="VD-TEST-001",
                    deployment_id=deployment.deployment_id,
                    sample_type="adult_card",
                    cartridge_id="TEST-CARD-001",
                    installed_at=datetime.now(timezone.utc),
                    installed_at_offset="+00:00",
                    condition_notes="test fixture sample",
                    is_test_fixture=True,
                    created_by=worker.id,
                )
            )
        for operator in (worker, reviewer):
            if not db.query(TrapGrant).filter_by(operator_id=operator.id, trap_id="VD-TEST-001").one_or_none():
                db.add(TrapGrant(operator_id=operator.id, trap_id="VD-TEST-001"))
        db.add(
            AuditRecord(
                entity_type="registry",
                entity_id="VD-TEST-001",
                action="seeded_test_fixtures",
                detail={"note": "TEST-ONLY data; district and site are placeholders, not real locations"},
            )
        )
        db.commit()
    if args.show_passwords:
        print(f"worker: test-worker / {worker_password}")
        print(f"reviewer: test-reviewer / {reviewer_password}")
    print("Test-only fixtures created: trap VD-TEST-001, deployment, one test sample, two test identities.")
    print("All records are labeled is_test_fixture=True and use TEST district/site placeholders.")
    return 0


def cmd_add_operator(args: argparse.Namespace) -> int:
    _settings, _engine, factory = _engine_and_session(args)
    password = _read_password(args, "Password for the new operator: ")
    with factory() as db:
        _add_operator(db, args.username, args.display_name or args.username, args.role, password, False)
    print(f"Operator created: {args.username} (role={args.role})")
    return 0


def cmd_grant(args: argparse.Namespace) -> int:
    _settings, _engine, factory = _engine_and_session(args)
    with factory() as db:
        operator = db.query(Operator).filter(Operator.username == args.username).one_or_none()
        if operator is None:
            raise ConfigError(f"Unknown operator: {args.username}")
        trap = db.get(Trap, args.trap_id)
        if trap is None:
            raise ConfigError(f"Unknown trap: {args.trap_id}")
        if not db.query(TrapGrant).filter_by(operator_id=operator.id, trap_id=trap.trap_id).one_or_none():
            db.add(TrapGrant(operator_id=operator.id, trap_id=trap.trap_id))
            db.commit()
    print(f"Granted {args.username} access to {args.trap_id}")
    return 0


def cmd_qr(args: argparse.Namespace) -> int:
    import segno

    base_url = args.base_url or os.environ.get("CAPTURE_PUBLIC_BASE_URL", "").strip().rstrip("/")
    if not base_url:
        raise ConfigError("Provide --base-url or set CAPTURE_PUBLIC_BASE_URL; no public host is hardcoded")
    settings = load_settings()
    if settings.is_production and not base_url.startswith("https://"):
        raise ConfigError("CAPTURE_PUBLIC_BASE_URL must be https in production")
    if base_url.startswith("http://") and not base_url.startswith(("http://localhost", "http://127.0.0.1")):
        raise ConfigError("Refusing plain-http base URL other than localhost")
    trap_id = args.trap_id
    url = f"{base_url}/capture?trap={trap_id}"
    out = args.out or f"labels/{trap_id}.png"
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    qr = segno.make(url, error="m")
    if out.endswith(".svg"):
        qr.save(out, scale=8, border=2)
    else:
        qr.save(out, scale=8, border=2, kind="png")
    print(f"QR label written: {out} ({url})")
    print("The QR contains the capture URL and trap identifier only; it is identification, not authentication.")
    return 0


def cmd_export_openapi(args: argparse.Namespace) -> int:
    from .main import create_app

    settings = load_settings()
    if settings.is_production:
        raise ConfigError("Contract export uses test/development settings")
    os.environ.setdefault("CAPTURE_ENV", "test")
    app = create_app(load_settings())
    spec = app.openapi()
    out = args.out or "openapi.json"
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(spec, handle, indent=2)
        handle.write("\n")
    print(f"OpenAPI contract written: {out}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--db", default=None, help="Override DATABASE_URL for this command")
    sub = parser.add_subparsers(dest="command", required=True)

    seed = sub.add_parser("seed-fixtures", parents=[common], help="Create test-only registry fixtures")
    seed.add_argument("--worker-password", default=None)
    seed.add_argument("--reviewer-password", default=None)
    seed.add_argument("--show-passwords", action="store_true")
    seed.set_defaults(func=cmd_seed_fixtures)

    add_op = sub.add_parser("add-operator", parents=[common], help="Create a named operator")
    add_op.add_argument("--username", required=True)
    add_op.add_argument("--display-name", default=None)
    add_op.add_argument("--role", choices=["worker", "reviewer", "admin"], default="worker")
    add_op.add_argument("--password-env", default=None, help="Read the password from this environment variable")
    add_op.set_defaults(func=cmd_add_operator)

    grant = sub.add_parser("grant", parents=[common], help="Grant an operator access to a trap")
    grant.add_argument("--username", required=True)
    grant.add_argument("--trap-id", required=True)
    grant.set_defaults(func=cmd_grant)

    qr = sub.add_parser("qr", parents=[common], help="Generate a QR label for one trap")
    qr.add_argument("--trap-id", required=True)
    qr.add_argument("--base-url", default=None)
    qr.add_argument("--out", default=None)
    qr.set_defaults(func=cmd_qr)

    export = sub.add_parser("export-openapi", parents=[common], help="Export the OpenAPI contract")
    export.add_argument("--out", default=None)
    export.set_defaults(func=cmd_export_openapi)
    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except ConfigError as error:
        print(f"Configuration error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())