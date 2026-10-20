"""Общая логика работы с заявками: сериализация, доступ, пост-коммит запуск конвейера."""
from __future__ import annotations

import secrets
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import SessionLocal
from ..models import Application, User
from ..schemas import ApplicationOut, ApplicationShort, CompanyOut, DocumentOut, EventOut, ProductOut
from ..state_machine import STATUS_INFO
from ..state_machine import Status as S
from .pipeline import drain, required_documents

NEXT_ACTION = {
    S.DRAFT: "Заполните и отправьте заявку",
    S.INFO_REQUESTED: "Ответьте на запрос банка",
    S.APPROVED: "Примите предложение банка",
    S.COUNTER_OFFER: "Выберите подходящий вариант предложения",
    S.SIGNING: "Подпишите кредитный договор",
}


def new_number() -> str:
    return f"CF-{datetime.now(UTC):%y%m%d}-{secrets.token_hex(2).upper()}"


def get_client_app(db: Session, user: User, app_id: str) -> Application:
    app = db.get(Application, app_id)
    if not app or app.company_id != user.company_id:
        raise HTTPException(404, "Заявка не найдена")
    return app


def get_any_app(db: Session, app_id: str) -> Application:
    app = db.get(Application, app_id)
    if not app:
        raise HTTPException(404, "Заявка не найдена")
    return app


def sla_minutes(app: Application) -> int | None:
    if app.status not in (S.MANUAL_REVIEW, S.COMMITTEE_REVIEW):
        return None
    entered = max((e.created_at for e in app.events if e.to_status == app.status), default=app.updated_at)
    if entered.tzinfo is None:
        entered = entered.replace(tzinfo=UTC)
    return int((datetime.now(UTC) - entered).total_seconds() // 60)


def to_short(app: Application) -> ApplicationShort:
    out = ApplicationShort.model_validate(app)
    out.status_label = STATUS_INFO[app.status]["label"]
    out.company_name = app.company.name
    out.company_inn = app.company.inn
    out.grade = (app.scoring or {}).get("grade")
    out.score = (app.scoring or {}).get("score")
    out.sla_minutes = sla_minutes(app)
    return out


def to_full(app: Application, employee: bool) -> ApplicationOut:
    base = to_short(app).model_dump()
    info = STATUS_INFO[app.status]
    events = [e for e in app.events if employee or e.visible_to_client]
    docs = [d for d in app.documents]
    decision = dict(app.decision or {})
    if not employee:
        decision.pop("proposal", None)
        decision.pop("comment_internal", None)
    out = ApplicationOut(
        **base,
        purpose_comment=app.purpose_comment,
        form_data=app.form_data or {},
        consents=app.consents or {},
        validation=app.validation or {},
        info_request=app.info_request or {},
        offer=app.offer or {},
        decision=decision,
        loan=app.loan or {},
        status_hint=info["client_hint"],
        stage=info["stage"],
        next_action=NEXT_ACTION.get(app.status),
        required_documents=required_documents(app),
        documents=[DocumentOut.model_validate(d) for d in docs],
        events=[EventOut.model_validate(e) for e in events],
        product=ProductOut.model_validate(app.product),
        company=CompanyOut.model_validate(app.company),
    )
    if employee:
        out.enrichment = app.enrichment or {}
        out.scoring = app.scoring or {}
    else:
        # клиенту показываем объяснимые факторы решения, но не внутренние баллы и сырые данные бюро
        sc = app.scoring or {}
        if sc:
            out.scoring = {
                "factors": [{"label": f["label"], "value": f["value"], "impact": "positive" if f["points"] > 0 else "negative" if f["points"] < 0 else "neutral", "hint": f["hint"]} for f in sc.get("factors", [])],
                "affordability": {k: sc["affordability"][k] for k in ("monthly_cash_flow", "max_payment", "max_amount_for_term")},
                "improvement_tips": sc.get("decision", {}).get("improvement_tips", []),
            }
    return out


def after_commit() -> None:
    """В режиме RUN_PIPELINE_INLINE этапы конвейера выполняются сразу (без отдельного воркера)."""
    if get_settings().run_pipeline_inline:
        drain(SessionLocal)
