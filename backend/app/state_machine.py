"""Конечный автомат статусов кредитной заявки.

Единственное место, где разрешено менять Application.status. Каждый переход:
  * проверяется по таблице допустимых переходов;
  * фиксируется в журнале событий (ApplicationEvent) — аудит и таймлайн клиента;
  * порождает уведомление клиенту внутри продукта (если событие клиентское);
  * при необходимости ставит задачу автоматическому этапу конвейера (PipelineTask).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy.orm import Session

from .models import Application, ApplicationEvent, Notification, PipelineTask


class Status:
    DRAFT = "DRAFT"
    SUBMITTED = "SUBMITTED"
    VALIDATION = "VALIDATION"
    INFO_REQUESTED = "INFO_REQUESTED"
    ENRICHMENT = "ENRICHMENT"
    SCORING = "SCORING"
    MANUAL_REVIEW = "MANUAL_REVIEW"
    COMMITTEE_REVIEW = "COMMITTEE_REVIEW"
    APPROVED = "APPROVED"
    COUNTER_OFFER = "COUNTER_OFFER"
    REJECTED = "REJECTED"
    OFFER_ACCEPTED = "OFFER_ACCEPTED"
    SIGNING = "SIGNING"
    SIGNED = "SIGNED"
    DISBURSED = "DISBURSED"
    CANCELLED = "CANCELLED"


S = Status

TRANSITIONS: dict[str, set[str]] = {
    S.DRAFT: {S.SUBMITTED, S.CANCELLED},
    S.SUBMITTED: {S.VALIDATION, S.CANCELLED},
    S.VALIDATION: {S.ENRICHMENT, S.INFO_REQUESTED, S.REJECTED, S.CANCELLED},
    S.INFO_REQUESTED: {S.SUBMITTED, S.CANCELLED},
    S.ENRICHMENT: {S.SCORING, S.INFO_REQUESTED, S.MANUAL_REVIEW, S.CANCELLED},
    S.SCORING: {S.APPROVED, S.COUNTER_OFFER, S.REJECTED, S.MANUAL_REVIEW, S.CANCELLED},
    S.MANUAL_REVIEW: {S.APPROVED, S.COUNTER_OFFER, S.REJECTED, S.INFO_REQUESTED, S.COMMITTEE_REVIEW, S.CANCELLED},
    S.COMMITTEE_REVIEW: {S.APPROVED, S.COUNTER_OFFER, S.REJECTED, S.MANUAL_REVIEW, S.CANCELLED},
    S.APPROVED: {S.OFFER_ACCEPTED, S.CANCELLED},
    S.COUNTER_OFFER: {S.OFFER_ACCEPTED, S.CANCELLED},
    S.OFFER_ACCEPTED: {S.SIGNING, S.CANCELLED},
    S.SIGNING: {S.SIGNED, S.CANCELLED},
    S.SIGNED: {S.DISBURSED},
    S.REJECTED: set(),
    S.DISBURSED: set(),
    S.CANCELLED: set(),
}

FINAL = {S.REJECTED, S.DISBURSED, S.CANCELLED}
CLIENT_CANCELLABLE = {
    S.DRAFT, S.SUBMITTED, S.VALIDATION, S.INFO_REQUESTED, S.ENRICHMENT, S.SCORING,
    S.MANUAL_REVIEW, S.COMMITTEE_REVIEW, S.APPROVED, S.COUNTER_OFFER, S.OFFER_ACCEPTED, S.SIGNING,
}

# Статусы, при входе в которые автоматически ставится задача конвейеру
AUTO_STAGE_FOR_STATUS = {
    S.SUBMITTED: "ACCEPT",
    S.VALIDATION: "VALIDATE",
    S.ENRICHMENT: "ENRICH",
    S.SCORING: "SCORE",
    S.OFFER_ACCEPTED: "PREPARE_DOCS",
    S.SIGNED: "DISBURSE",
}

# Человекочитаемое описание статусов: используется и в UI клиента, и в документации
STATUS_INFO: dict[str, dict] = {
    S.DRAFT: {"label": "Черновик", "client_hint": "Заполните заявку — данные сохраняются автоматически.", "stage": 1},
    S.SUBMITTED: {"label": "Отправлена", "client_hint": "Заявка принята, начинаем проверку.", "stage": 2},
    S.VALIDATION: {"label": "Проверка данных", "client_hint": "Проверяем полноту и корректность сведений.", "stage": 2},
    S.INFO_REQUESTED: {"label": "Нужна информация", "client_hint": "Банку нужны уточнения — ответьте на запрос в заявке.", "stage": 2},
    S.ENRICHMENT: {"label": "Запрос данных", "client_hint": "Получаем сведения из ЕГРЮЛ, ФНС и бюро кредитных историй.", "stage": 3},
    S.SCORING: {"label": "Оценка", "client_hint": "Оцениваем заявку и подбираем условия.", "stage": 3},
    S.MANUAL_REVIEW: {"label": "У специалиста", "client_hint": "Заявку изучает кредитный специалист. Обычно это занимает до 4 часов.", "stage": 3},
    S.COMMITTEE_REVIEW: {"label": "На согласовании", "client_hint": "Решение согласуется с риск-менеджером.", "stage": 3},
    S.APPROVED: {"label": "Одобрена", "client_hint": "Кредит одобрен. Ознакомьтесь с условиями и примите предложение.", "stage": 4},
    S.COUNTER_OFFER: {"label": "Есть предложение", "client_hint": "Банк готов выдать кредит на других условиях — выберите подходящий вариант.", "stage": 4},
    S.REJECTED: {"label": "Отказ", "client_hint": "К сожалению, сейчас банк не может выдать кредит. Посмотрите рекомендации.", "stage": 4},
    S.OFFER_ACCEPTED: {"label": "Готовим документы", "client_hint": "Формируем кредитный договор.", "stage": 5},
    S.SIGNING: {"label": "Подписание", "client_hint": "Проверьте договор и подпишите его кодом из уведомлений.", "stage": 5},
    S.SIGNED: {"label": "Подписан", "client_hint": "Договор подписан, перечисляем деньги.", "stage": 5},
    S.DISBURSED: {"label": "Деньги выданы", "client_hint": "Деньги зачислены на счёт. График платежей — в заявке.", "stage": 6},
    S.CANCELLED: {"label": "Отменена", "client_hint": "Заявка отменена.", "stage": 6},
}


class TransitionError(Exception):
    pass


@dataclass
class Actor:
    type: str  # CLIENT | SYSTEM | EMPLOYEE
    id: str | None = None
    name: str | None = None


SYSTEM = Actor("SYSTEM", None, "Кредитный конвейер")


def can_transition(src: str, dst: str) -> bool:
    return dst in TRANSITIONS.get(src, set())


def log_event(
    db: Session,
    app: Application,
    event_type: str,
    message: str,
    actor: Actor,
    details: dict | None = None,
    visible_to_client: bool = True,
    from_status: str | None = None,
    to_status: str | None = None,
) -> ApplicationEvent:
    ev = ApplicationEvent(
        application_id=app.id,
        event_type=event_type,
        from_status=from_status,
        to_status=to_status,
        actor_type=actor.type,
        actor_id=actor.id,
        actor_name=actor.name,
        message=message,
        details=details or {},
        visible_to_client=visible_to_client,
    )
    db.add(ev)
    return ev


def notify(db: Session, app: Application, title: str, body: str, kind: str = "STATUS") -> None:
    db.add(Notification(company_id=app.company_id, application_id=app.id, kind=kind, title=title, body=body))


def enqueue(db: Session, app: Application, stage: str, delay_sec: float = 0.0) -> PipelineTask:
    task = PipelineTask(
        application_id=app.id,
        stage=stage,
        run_after=datetime.now(UTC) + timedelta(seconds=delay_sec),
    )
    db.add(task)
    return task


def transition(
    db: Session,
    app: Application,
    to: str,
    actor: Actor,
    message: str | None = None,
    details: dict | None = None,
    notify_client: bool = True,
    delay_sec: float = 0.0,
) -> None:
    src = app.status
    if not can_transition(src, to):
        raise TransitionError(f"Переход {src} → {to} недопустим")
    app.status = to
    now = datetime.now(UTC)
    if to == S.SUBMITTED and app.submitted_at is None:
        app.submitted_at = now
    if to in {S.APPROVED, S.COUNTER_OFFER, S.REJECTED} and app.decided_at is None:
        app.decided_at = now
    if to in FINAL:
        app.closed_at = now

    info = STATUS_INFO[to]
    msg = message or info["client_hint"]
    log_event(db, app, "STATUS_CHANGED", msg, actor, details, True, src, to)

    if notify_client and to not in {S.VALIDATION, S.ENRICHMENT, S.SCORING, S.SUBMITTED}:
        kind = "ACTION_REQUIRED" if to in {S.INFO_REQUESTED, S.APPROVED, S.COUNTER_OFFER, S.SIGNING} else "STATUS"
        notify(db, app, f"Заявка {app.number}: {info['label']}", msg, kind)

    stage = AUTO_STAGE_FOR_STATUS.get(to)
    if stage:
        enqueue(db, app, stage, delay_sec)
