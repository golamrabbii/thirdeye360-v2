"""Admin permission gating for ThirdEye360.

Login itself happens against Barikoi's central auth API, so this module
never handles passwords. It verifies a caller's Barikoi bearer token,
maps it to a barikoi_id, and checks the local `admin_users` table.

Everything fails closed: a missing/invalid token, an unknown user, or a
DB error all deny access rather than grant it.
"""

import logging

import httpx
from fastapi import Depends, HTTPException, Request

from functions import get_db_connection

logger = logging.getLogger(__name__)

BARIKOI_AUTH_BASE_URL = "https://api.admin.barikoi.com/api/v2"


def create_admin_users_table():
    """Create the admin_users table if it does not exist (idempotent)."""
    conn = get_db_connection()
    if not conn:
        return False
    cur = conn.cursor()
    try:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS admin_users (
                id         SERIAL PRIMARY KEY,
                barikoi_id BIGINT NOT NULL UNIQUE,
                is_admin   BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        conn.commit()
        return True
    except Exception as e:
        logger.error(f"Error creating admin_users table: {e}")
        conn.rollback()
        return False
    finally:
        conn.close()


def is_admin(barikoi_id):
    """Look up admin status in the local table. Fails closed."""
    conn = get_db_connection()
    if not conn:
        logger.error("Admin check: no DB connection, denying access")
        return False
    cur = conn.cursor()
    try:
        cur.execute(
            "SELECT is_admin FROM admin_users WHERE barikoi_id = %s",
            (barikoi_id,),
        )
        row = cur.fetchone()
        return bool(row and row[0])
    except Exception as e:
        logger.error(f"Admin check failed for barikoi_id={barikoi_id}: {e}")
        return False
    finally:
        conn.close()


async def verify_barikoi_token(request: Request) -> dict:
    """FastAPI dependency: validate the Authorization bearer token against
    Barikoi's /auth/user endpoint and return the verified identity.

    Returns a dict with barikoi_id, email and name. Raises 401 when the
    token is missing or rejected, 502 when Barikoi cannot be reached or
    returns an unparseable payload (fail closed either way).
    """
    auth_header = request.headers.get("Authorization") or ""
    if not auth_header.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = auth_header[7:].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Missing bearer token")

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{BARIKOI_AUTH_BASE_URL}/auth/user",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/json",
                },
            )
    except httpx.HTTPError as e:
        logger.error(f"Barikoi auth service unreachable: {e}")
        raise HTTPException(status_code=502, detail="Auth service unavailable")

    if resp.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    payload = resp.json()
    user = payload.get("user") if isinstance(payload, dict) and isinstance(payload.get("user"), dict) else payload
    if not isinstance(user, dict):
        logger.error(f"Unexpected Barikoi /auth/user payload type: {type(payload)}")
        raise HTTPException(status_code=502, detail="Unexpected auth service response")

    raw_id = user.get("id") or user.get("user_id")
    if raw_id is None:
        # Fail closed, but log the shape so a field-name mismatch is easy
        # to diagnose on first contact with the real API.
        logger.error(
            f"Barikoi /auth/user response has no id field. Keys: {list(user.keys())}"
        )
        raise HTTPException(status_code=502, detail="Unexpected auth service response")

    try:
        barikoi_id = int(raw_id)
    except (TypeError, ValueError):
        logger.error(f"Barikoi user id is not numeric: {raw_id!r}")
        raise HTTPException(status_code=502, detail="Unexpected auth service response")

    return {
        "barikoi_id": barikoi_id,
        "email": user.get("email"),
        "name": user.get("name"),
    }


async def require_admin(user: dict = Depends(verify_barikoi_token)) -> dict:
    """Dependency for admin-only endpoints: verify the Barikoi token, then
    check the admin_users table. Returns the verified identity on success.
    """
    if not is_admin(user["barikoi_id"]):
        raise HTTPException(status_code=403, detail="Admin permission required")
    return user
