"""Initialize a NEW, dedicated production database with the first trap and admin.

This is an operator-run tool, not an API. It does not deploy resources, enable
SAM3, migrate an existing database, or touch files or volumes. It refuses to
run against a nonempty database. DATABASE_URL stays in the process environment;
the operator enters the administrator password at a non-echoing prompt.
"""

from __future__ import annotations

import argparse
import getpass
import os
import re
import sys
import warnings
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from .main import _verify_production_schema
from .models import AuditRecord, Base, Deployment, Operator, Trap, TrapGrant, utcnow
from .security import hash_password


class BootstrapError(ValueError):
    """An operator-correctable setup problem without credential details."""


@dataclass(frozen=True)
class InitialRegistry:
    trap_id: str
    district_code: str
    site_id: str
    placement: str
    deployed_at: datetime
    username: str
    display_name: str


def _required(value: str, field: str, limit: int) -> str:
    value = value.strip()
    if not value or len(value) > limit:
        raise BootstrapError(f"{field} must contain 1–{limit} characters")
    return value


def validate_trap_id(value: str) -> str:
    trap_id = _required(value, "Trap ID", 40)
    if not re.fullmatch(r"[A-Z0-9][A-Z0-9-]{1,39}", trap_id):
        raise BootstrapError("Trap ID must match the printed label: 2–40 uppercase letters, digits or hyphens")
    return trap_id


def validate_username(value: str) -> str:
    username = _required(value, "Username", 64)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{1,63}", username):
        raise BootstrapError("Username must use 2–64 letters, digits, dots, underscores or hyphens")
    return username


def validate_registry(record: InitialRegistry, now: datetime | None = None) -> InitialRegistry:
    trap_id = validate_trap_id(record.trap_id)
    username = validate_username(record.username)
    deployed = record.deployed_at
    if deployed.tzinfo is None or deployed.utcoffset() is None:
        raise BootstrapError("Deployment time must include a UTC offset, for example +07:00")
    deployed = deployed.astimezone(timezone.utc)
    if deployed > (now or utcnow()) + timedelta(minutes=5):
        raise BootstrapError("Deployment time cannot be in the future")
    return InitialRegistry(
        trap_id=trap_id,
        district_code=_required(record.district_code, "District code", 32),
        site_id=_required(record.site_id, "Site ID", 64),
        placement=_required(record.placement, "Placement", 255),
        deployed_at=deployed,
        username=username,
        display_name=_required(record.display_name, "Display name", 120),
    )


def validate_password(password: str) -> None:
    if len(password) < 12 or len(password) > 256 or password.strip().lower() in {
        "password", "changeme", "password1234", "123456789012", "administrator",
    }:
        raise BootstrapError("Use a unique administrator password of 12–256 characters")


def _create_empty_schema(connection) -> None:
    inspector = inspect(connection)
    objects = inspector.get_table_names() + inspector.get_view_names()
    if connection.dialect.name == "postgresql":
        objects += inspector.get_sequence_names() + inspector.get_materialized_view_names()
    if objects:
        raise BootstrapError("Default schema is not empty; initialization refused. No tables were changed.")
    Base.metadata.create_all(connection)
    _verify_production_schema(connection)


def initialize_placeholder_database(engine: Engine, trap_id: str) -> None:
    """Initialize one empty database with a clearly test-only QR placeholder.

    No installation, deployment, operator, sample, image or job is invented.
    The test-only marker must remain until an explicit real registry operation.
    """
    trap_id = validate_trap_id(trap_id)
    with engine.begin() as connection:
        _create_empty_schema(connection)
        with Session(bind=connection) as db:
            db.add(Trap(
                trap_id=trap_id,
                district_code="TEST",
                site_id="TEST-PLACEHOLDER",
                placement="QR test only; not installed",
                is_test_fixture=True,
            ))
            db.add(AuditRecord(
                entity_type="trap", entity_id=trap_id, action="placeholder_created",
                detail={"note": "QR test only; no real deployment or location is registered"},
            ))
            db.flush()


def initialize_first_admin(engine: Engine, username: str, display_name: str, password: str) -> None:
    """Create one administrator only when the initialized database has none."""
    username = validate_username(username)
    display_name = _required(display_name, "Display name", 120)
    validate_password(password)
    password_hash = hash_password(password)
    with engine.begin() as connection:
        _verify_production_schema(connection)
        if connection.dialect.name == "postgresql":
            # An empty operator table has no row to lock. Serialize concurrent
            # first-admin attempts within this transaction instead.
            connection.execute(text("SELECT pg_advisory_xact_lock(835974120)"))
        with Session(bind=connection) as db:
            if db.query(Operator).first() is not None:
                raise BootstrapError("An operator already exists; first-admin creation refused.")
            operator = Operator(username=username, display_name=display_name, role="admin",
                                password_hash=password_hash, is_test_identity=False)
            db.add(operator)
            db.flush()
            db.add(AuditRecord(entity_type="operator", entity_id=str(operator.id),
                               action="first_admin_created", actor_id=operator.id, detail={}))
            db.flush()


def initialize_empty_database(engine: Engine, record: InitialRegistry, password: str) -> None:
    """Create schema + first registry atomically in an empty default schema.

    The caller must confirm a new, dedicated PostgreSQL database. Tests call
    this core with an isolated SQLite database and synthetic identities.
    """
    record = validate_registry(record)
    validate_password(password)
    password_hash = hash_password(password)
    with engine.begin() as connection:
        _create_empty_schema(connection)
        with Session(bind=connection) as db:
            operator = Operator(
                username=record.username,
                display_name=record.display_name,
                role="admin",
                password_hash=password_hash,
                is_test_identity=False,
            )
            trap = Trap(
                trap_id=record.trap_id,
                district_code=record.district_code,
                site_id=record.site_id,
                placement=record.placement,
                is_test_fixture=False,
            )
            db.add_all([operator, trap])
            db.flush()
            deployment = Deployment(
                trap_id=record.trap_id,
                district_code=record.district_code,
                site_id=record.site_id,
                location_note=record.placement,
                start_at=record.deployed_at,
            )
            db.add_all([
                deployment,
                TrapGrant(operator_id=operator.id, trap_id=record.trap_id),
                AuditRecord(
                    entity_type="trap", entity_id=record.trap_id,
                    action="initial_registry_created", actor_id=operator.id,
                    detail={"site_id": record.site_id, "district_code": record.district_code},
                ),
            ])
            db.flush()
            # The surrounding engine.begin() owns and commits the transaction.


def _database_url():
    """Validate only non-secret URL properties; never print the URL."""
    if os.environ.get("CAPTURE_ENV", "").strip().lower() != "production":
        raise BootstrapError("Set CAPTURE_ENV=production before initializing a production database")
    raw = os.environ.get("DATABASE_URL", "").strip()
    if not raw:
        raise BootstrapError("Set DATABASE_URL privately in the environment; do not put it in chat")
    try:
        url = make_url(raw)
    except Exception as error:
        raise BootstrapError("DATABASE_URL is not a valid database URL") from error
    if url.drivername not in {"postgresql", "postgresql+psycopg"}:
        raise BootstrapError("The production bootstrap requires PostgreSQL with the psycopg driver")
    if url.query.get("sslmode") not in {"require", "verify-ca", "verify-full"}:
        raise BootstrapError("DATABASE_URL must require TLS using sslmode=require, verify-ca or verify-full")
    if not url.database or not url.host:
        raise BootstrapError("DATABASE_URL must name a host and a dedicated database")
    # The production image installs psycopg 3, not psycopg2. Neon commonly
    # returns the generic postgresql:// form, whose SQLAlchemy default differs.
    return url.set(drivername="postgresql+psycopg")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--confirm-new-empty-database", action="store_true",
                        help="Confirm this is a dedicated empty database; existing tables are refused")
    parser.add_argument("--trap-id", required=True, help="ID printed in the container QR")
    parser.add_argument("--district-code", required=True)
    parser.add_argument("--site-id", required=True)
    parser.add_argument("--placement", required=True, help="Actual placement, not a QR snapshot")
    parser.add_argument("--deployed-at", required=True, help="Actual ISO 8601 deployment time with UTC offset")
    parser.add_argument("--username", required=True, help="Initial administrator username")
    parser.add_argument("--display-name", required=True)
    args = parser.parse_args(argv)
    try:
        if not args.confirm_new_empty_database:
            raise BootstrapError("Pass --confirm-new-empty-database only for a new, dedicated database")
        url = _database_url()
        try:
            deployed_at = datetime.fromisoformat(args.deployed_at.replace("Z", "+00:00"))
        except ValueError as error:
            raise BootstrapError("Deployment time must be ISO 8601 with a UTC offset") from error
        record = validate_registry(InitialRegistry(
            trap_id=args.trap_id, district_code=args.district_code, site_id=args.site_id,
            placement=args.placement, deployed_at=deployed_at, username=args.username,
            display_name=args.display_name,
        ))
        if not sys.stdin.isatty():
            raise BootstrapError("Run this command in an interactive terminal for the non-echoing password prompt")
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", getpass.GetPassWarning)
                password = getpass.getpass("New administrator password: ")
                confirmation = getpass.getpass("Confirm administrator password: ")
        except getpass.GetPassWarning as error:
            raise BootstrapError("Cannot hide password input in this terminal; initialization refused") from error
        if password != confirmation:
            raise BootstrapError("Passwords do not match; initialization refused")
        validate_password(password)
        engine = create_engine(url, future=True)
        try:
            initialize_empty_database(engine, record, password)
        finally:
            engine.dispose()
        print(f"New database initialized. Registered trap {record.trap_id} and administrator {record.username}.")
        print("No sample, photo, model job, or inference was created.")
        return 0
    except BootstrapError as error:
        print(f"Setup refused: {error}", file=sys.stderr)
        return 2
    except (SQLAlchemyError, OSError):
        # Provider/driver errors may contain connection details. Do not print
        # the raw exception or DATABASE_URL into a terminal log or chat.
        print("Database setup failed. Check connectivity, TLS, privileges and the database driver privately.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
