from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import Company, User
from ..schemas import LoginIn, RegisterIn, TokenOut, UserOut
from ..security import audit, create_token, current_user, hash_password, verify_password
from ..services import integrations
from ..services.integrations import SourceUnavailable

router = APIRouter(prefix="/auth", tags=["Auth"])

DEMO_ACCOUNTS = [
    {"email": "bakery@demo.ru", "password": "Demo123!", "role": "CLIENT", "title": "ООО «Хлебный Дом»", "hint": "пекарня, сильный профиль → автоодобрение"},
    {"email": "smirnov@demo.ru", "password": "Demo123!", "role": "CLIENT", "title": "ИП Смирнов А. В.", "hint": "грузоперевозки → встречное предложение"},
    {"email": "stroy@demo.ru", "password": "Demo123!", "role": "CLIENT", "title": "ООО «СтройМонтаж Плюс»", "hint": "просрочки, отметки ФНС → ручное рассмотрение"},
    {"email": "romashka@demo.ru", "password": "Demo123!", "role": "CLIENT", "title": "ООО «Ромашка Трейд»", "hint": "стоп-факторы → отказ с объяснением"},
    {"email": "analyst@bank.ru", "password": "Analyst123!", "role": "ANALYST", "title": "Кредитный аналитик", "hint": "очередь ручного рассмотрения"},
    {"email": "risk@bank.ru", "password": "Risk123!", "role": "RISK_MANAGER", "title": "Риск-менеджер", "hint": "согласование крупных сумм"},
    {"email": "admin@bank.ru", "password": "Admin123!", "role": "ADMIN", "title": "Администратор", "hint": "управление лентой новостей"},
]


@router.post("/login", response_model=TokenOut, summary="Вход по e-mail и паролю")
def login(body: LoginIn, request: Request, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.email == body.email.lower()))
    if not user or not verify_password(body.password, user.password_hash):
        audit(db, request, None, "LOGIN_FAILED", details={"email": body.email})
        db.commit()
        raise HTTPException(401, "Неверный e-mail или пароль")
    audit(db, request, user, "LOGIN")
    db.commit()
    return TokenOut(access_token=create_token(user), user=UserOut.model_validate(user))


@router.post("/register", response_model=TokenOut, status_code=201,
             summary="Регистрация предпринимателя по ИНН (данные компании подтягиваются из ЕГРЮЛ)")
def register(body: RegisterIn, request: Request, db: Session = Depends(get_db)):
    if db.scalar(select(User).where(User.email == body.email.lower())):
        raise HTTPException(409, "Пользователь с таким e-mail уже зарегистрирован")
    company = db.scalar(select(Company).where(Company.inn == body.inn))
    if not company:
        try:
            eg = integrations.egrul(body.inn)
        except SourceUnavailable:
            raise HTTPException(503, "Сервис ЕГРЮЛ временно недоступен, попробуйте позже")
        if not eg.get("found"):
            raise HTTPException(404, "Компания с таким ИНН не найдена в ЕГРЮЛ/ЕГРИП")
        company = Company(
            inn=body.inn, ogrn=eg.get("ogrn"), name=eg["short_name"], legal_form=eg["legal_form"],
            okved=eg["okved_main"]["code"], okved_name=eg["okved_main"]["name"], region=eg.get("region"),
            address=eg.get("address"), director_name=(eg.get("director") or {}).get("name"),
            registration_date=date.fromisoformat(eg["registration_date"]), segment=eg.get("msp_category", "micro"),
            employees=eg.get("employees"),
        )
        db.add(company)
        db.flush()
    user = User(email=body.email.lower(), password_hash=hash_password(body.password), full_name=body.full_name,
                position=body.position, role="CLIENT", company_id=company.id)
    db.add(user)
    db.flush()
    audit(db, request, user, "REGISTER", "company", company.id)
    db.commit()
    db.refresh(user)
    return TokenOut(access_token=create_token(user), user=UserOut.model_validate(user))


@router.get("/me", response_model=UserOut, summary="Текущий пользователь")
def me(user: User = Depends(current_user)):
    return UserOut.model_validate(user)


@router.get("/demo-accounts", summary="Тестовые учётные записи (только в демо-режиме)")
def demo_accounts():
    return DEMO_ACCOUNTS if get_settings().seed_demo_data else []
