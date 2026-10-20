from datetime import UTC, datetime, timedelta

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from .config import get_settings
from .db import get_db
from .models import AuditLog, User

ALGO = "HS256"
EMPLOYEE_ROLES = {"ANALYST", "RISK_MANAGER", "ADMIN"}
bearer = HTTPBearer(auto_error=False)


def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt(rounds=10)).decode()


def verify_password(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode(), hashed.encode())
    except ValueError:
        return False


def create_token(user: User) -> str:
    s = get_settings()
    now = datetime.now(UTC)
    payload = {"sub": user.id, "role": user.role, "iat": now, "exp": now + timedelta(minutes=s.jwt_ttl_minutes)}
    return jwt.encode(payload, s.jwt_secret, algorithm=ALGO)


def current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer), db: Session = Depends(get_db)
) -> User:
    if not creds:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Требуется авторизация")
    try:
        payload = jwt.decode(creds.credentials, get_settings().jwt_secret, algorithms=[ALGO])
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Недействительный или просроченный токен")
    user = db.get(User, payload["sub"])
    if not user or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Пользователь не найден")
    return user


def require_roles(*roles: str):
    def dep(user: User = Depends(current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Недостаточно прав")
        return user

    return dep


require_client = require_roles("CLIENT")
require_employee = require_roles(*EMPLOYEE_ROLES)


def audit(db: Session, request: Request | None, user: User | None, action: str, entity: str | None = None,
          entity_id: str | None = None, details: dict | None = None) -> None:
    db.add(AuditLog(
        actor_id=user.id if user else None, actor_email=user.email if user else None, action=action, entity=entity,
        entity_id=entity_id, ip=request.client.host if request and request.client else None, details=details or {},
    ))
