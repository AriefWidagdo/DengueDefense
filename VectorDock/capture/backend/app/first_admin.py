"""Create the first administrator privately for an initialized Neon database.

This operator-run tool reads Neon credentials into memory and prompts for a
new password without echo. It never accepts a password on the command line,
prints connection details, or creates a trap deployment, sample, or image.
"""
from __future__ import annotations

import argparse
import getpass
import os
import subprocess
import sys
import warnings

from sqlalchemy import create_engine

from .bootstrap import BootstrapError, _database_url, initialize_first_admin, validate_username


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--neon-project-id", required=True)
    parser.add_argument("--database-name", required=True)
    parser.add_argument("--role-name", required=True)
    parser.add_argument("--username", default="operator")
    args = parser.parse_args(argv)
    try:
        username = validate_username(args.username)
        if not sys.stdin.isatty():
            raise BootstrapError("Use an interactive terminal for the hidden password prompt")
        executable = "npx.cmd" if os.name == "nt" else "npx"
        result = subprocess.run(
            [executable, "--yes", "neonctl@8.16.0", "connection-string",
             "--project-id", args.neon_project_id, "--database-name", args.database_name,
             "--role-name", args.role_name, "--no-color"],
            capture_output=True, text=True, timeout=60, check=True,
        )
        os.environ["CAPTURE_ENV"] = "production"
        os.environ["DATABASE_URL"] = result.stdout.strip()
        url = _database_url()
        if url.database != args.database_name or url.username != args.role_name:
            raise BootstrapError("Neon returned a different database or role; setup refused")
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", getpass.GetPassWarning)
                password = getpass.getpass(f"Create a password for {username} (12 characters minimum): ")
                confirmation = getpass.getpass("Confirm password: ")
        except getpass.GetPassWarning as error:
            raise BootstrapError("This terminal cannot hide the password; setup refused") from error
        if password != confirmation:
            raise BootstrapError("Passwords do not match; setup refused")
        engine = create_engine(url, future=True, connect_args={"connect_timeout": 20})
        try:
            initialize_first_admin(engine, username, username, password)
        finally:
            engine.dispose()
        print(f"Administrator {username} created. No trap deployment, sample, image, or job was created.")
        return 0
    except BootstrapError as error:
        print(f"Setup refused: {error}", file=sys.stderr)
        return 2
    except (Exception, KeyboardInterrupt):
        # Database and provider exceptions can contain credentials.
        print("Setup did not complete. Check Neon login, connectivity, and database state privately.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
