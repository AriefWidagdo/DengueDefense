"""Password hashing, session tokens, CSRF and identity resolution.

- Passwords use hashlib.scrypt with a per-operator salt.
- Session cookies are HttpOnly; the CSRF token is returned in the login
  response body and must be sent back as the X-CSRF-Token header on
  cookie-authenticated writes.
- The relay credential authenticates the server-to-server transport only. It
  never grants an end-user identity: relayed requests still need the
  operator's session cookie forwarded by the same-origin proxy.
- Identity-assertion headers from clients are rejected (forged identity).
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import timedelta

from fastapi import HTTPException, Request, status
from sqlalchemy.orm import Session

from .config import FORBIDDEN_IDENTITY_HEADERS, Settings
from .models import Operator, SessionRecord, TrapGrant, utcnow

SESSION_COOKIE = "vd_session"
CSRF_HEADER = "x-csrf-token"
SESSION_TTL = timedelta(hours=12)

_SCRYPT_N = 2**14
_SCRYPT_R = 8
_SCRYPT_P = 1


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P)
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt_hex, digest_hex = stored.split("$")
        if scheme != "scrypt":
            return False
        digest = hashlib.scrypt(
            password.encode("utf-8"), salt=bytes.fromhex(salt_hex), n=int(n), r=int(r), p=int(p)
        )
        return hmac.compare_digest(digest.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def new_csrf_token() -> str:
    return secrets.token_urlsafe(24)


def constant_time_equals(left: str, right: str) -> bool:
    return hmac.compare_digest(left.encode("utf-8"), right.encode("utf-8"))


@dataclass(frozen=True)
class AuthContext:
    operator: Operator
    session: SessionRecord | None
    via_relay: bool

    @property
    def is_reviewer(self) -> bool:
        return self.operator.role in {"reviewer", "admin"}

    @property
    def is_admin(self) -> bool:
        return self.operator.role == "admin"


def check_identity_headers(request: Request) -> None:
    """Reject requests that assert an identity through spoofable headers."""
    present = [name for name in FORBIDDEN_IDENTITY_HEADERS if request.headers.get(name)]
    if present:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Identity assertion headers are not accepted: {', '.join(present)}",
        )


def check_relay_token(request: Request, settings: Settings) -> bool:
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        return False
    token = header.split(" ", 1)[1].strip()
    if not settings.relay_token or not constant_time_equals(token, settings.relay_token):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid relay credential")
    return True


def resolve_session(db: Session, request: Request) -> tuple[Operator, SessionRecord] | tuple[None, None]:
    raw_token = request.cookies.get(SESSION_COOKIE, "")
    if not raw_token:
        return None, None
    record = db.query(SessionRecord).filter(SessionRecord.token_hash == hash_token(raw_token)).one_or_none()
    if record is None or record.revoked_at is not None or record.expires_at < utcnow():
        return None, None
    operator = db.get(Operator, record.operator_id)
    if operator is None or not operator.is_active:
        return None, None
    return operator, record


def resolve_auth(db: Session, request: Request, settings: Settings) -> AuthContext:
    """Resolve the caller identity: browser session cookie, optionally relayed."""
    via_relay = check_relay_token(request, settings)
    operator, session = resolve_session(db, request)
    if operator is None or session is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required (session cookie; the relay credential is not an end-user identity)",
        )
    return AuthContext(operator=operator, session=session, via_relay=via_relay)


def require_csrf(request: Request, auth: AuthContext) -> None:
    """Cookie-authenticated writes must present the session CSRF token.

    Relayed server-to-server calls are not browser flows and are exempt, but
    they still carry the operator session cookie forwarded by the same-origin
    proxy.
    """
    if auth.via_relay:
        return
    presented = request.headers.get(CSRF_HEADER, "")
    if not presented or not auth.session or not constant_time_equals(presented, auth.session.csrf_token):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Missing or invalid CSRF token")


def check_origin(request: Request, settings: Settings) -> None:
    """Reject cross-site browser requests against cookie-authenticated flows."""
    origin = request.headers.get("origin")
    if origin is None:
        return
    if origin not in settings.allowed_origins:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Untrusted Origin")


def grant_trap_ids(db: Session, operator_id: int) -> set[str]:
    return {row[0] for row in db.query(TrapGrant.trap_id).filter(TrapGrant.operator_id == operator_id).all()}


def require_trap_access(db: Session, auth: AuthContext, trap_id: str) -> None:
    if trap_id not in grant_trap_ids(db, auth.operator.id) and not auth.is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No access grant for this trap")