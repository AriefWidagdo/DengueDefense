"""FastAPI dependencies wiring settings, database, storage and auth."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session, sessionmaker

from .adapter import CounterAdapter
from .config import Settings
from .security import (
    AuthContext,
    check_identity_headers,
    check_origin,
    require_csrf,
    resolve_auth,
)
from .storage import FileStorage

UNSAFE_METHODS = {"POST", "PATCH", "PUT", "DELETE"}


@dataclass
class AppState:
    settings: Settings
    session_factory: sessionmaker[Session]
    storage: FileStorage
    adapter: CounterAdapter


def get_state(request: Request) -> AppState:
    return request.app.state.capture


def get_db(state: AppState = Depends(get_state)) -> Iterator[Session]:
    session = state.session_factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def require_user(
    request: Request,
    db: Session = Depends(get_db),
    state: AppState = Depends(get_state),
) -> AuthContext:
    """Identity resolution plus browser-flow protections.

    - forged identity headers are rejected before anything else
    - browser origins must be in the allowlist for unsafe methods
    - cookie-authenticated writes need the session CSRF token
    """
    check_identity_headers(request)
    if request.method in UNSAFE_METHODS:
        check_origin(request, state.settings)
    auth = resolve_auth(db, request, state.settings)
    if request.method in UNSAFE_METHODS:
        require_csrf(request, auth)
    return auth


def require_admin(auth: AuthContext = Depends(require_user)) -> AuthContext:
    if not auth.is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Administrator role required")
    return auth