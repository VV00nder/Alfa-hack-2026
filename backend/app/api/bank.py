"""Рабочее место сотрудника банка: очередь, карточка заявки, решение, аналитика, управление лентой."""
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import Application, ApplicationEvent, AuditLog, Company, NewsItem, Product, User
from ..schemas import ApplicationOut, ApplicationShort, DecisionIn, NewsIn, NewsOut
from ..scoring.engine import _offer
from ..security import audit, require_employee, require_roles
from ..services import assistant
from ..services.applications import after_commit, get_any_app, to_full, to_short
from ..services.news import rank_feed
from ..services.pipeline import DOC_LABELS, product_terms, run_decision, set_offer
from ..state_machine import STATUS_INFO, Actor, TransitionError, log_event, transition
from ..state_machine import Status as S

router = APIRouter(prefix="/bank", tags=["Back office (bank)"])


def _actor(u: User) -> Actor:
    return Actor("EMPLOYEE", u.id, f"{u.full_name} ({u.position or u.role})")


@router.get("/applications", response_model=list[ApplicationShort], summary="Очередь заявок с фильтрами")
def queue(status: str | None = Query(None, description="Статус или список через запятую"),
          q: str | None = Query(None, description="Поиск по номеру, ИНН или названию"),
          product: str | None = None, mine: bool = False,
          user: User = Depends(require_employee), db: Session = Depends(get_db)):
    stmt = select(Application).join(Company).where(Application.status != S.DRAFT)
    if status:
        stmt = stmt.where(Application.status.in_(status.split(",")))
    if product:
        stmt = stmt.where(Application.product_code == product)
    if mine:
        stmt = stmt.where(Application.assigned_to == user.id)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(Application.number.ilike(like) | Company.inn.ilike(like) | Company.name.ilike(like))
    apps = db.scalars(stmt.order_by(Application.updated_at.desc()).limit(200)).all()
    return [to_short(a) for a in apps]


@router.get("/applications/{app_id}", response_model=ApplicationOut, summary="Полная карточка заявки (данные источников, скоринг, аудит)")
def card(app_id: str, user: User = Depends(require_employee), db: Session = Depends(get_db)):
    return to_full(get_any_app(db, app_id), True)


@router.post("/applications/{app_id}/assign", response_model=ApplicationOut, summary="Взять заявку в работу")
def assign(app_id: str, user: User = Depends(require_employee), db: Session = Depends(get_db)):
    app = get_any_app(db, app_id)
    if app.status not in (S.MANUAL_REVIEW, S.COMMITTEE_REVIEW):
        raise HTTPException(409, "Заявка не находится на ручном рассмотрении")
    app.assigned_to = user.id
    log_event(db, app, "ASSIGNED", f"Заявку взял в работу: {user.full_name}", _actor(user), visible_to_client=False)
    db.commit()
    return to_full(app, True)


@router.get("/applications/{app_id}/ai-summary", summary="ИИ-резюме заявки для андеррайтера")
def ai_summary(app_id: str, user: User = Depends(require_employee), db: Session = Depends(get_db)):
    return assistant.analyst_summary(get_any_app(db, app_id))


@router.post("/applications/{app_id}/what-if", summary="Пересчёт модели с другими параметрами (без сохранения)")
def what_if(app_id: str, amount: float = Query(..., gt=0), term_months: int = Query(..., ge=1, le=120),
            product_code: str | None = None, user: User = Depends(require_employee), db: Session = Depends(get_db)):
    app = get_any_app(db, app_id)
    if not app.enrichment:
        raise HTTPException(409, "Данные из источников ещё не получены")
    product = db.get(Product, product_code) if product_code else None
    if product_code and not product:
        raise HTTPException(422, "Неизвестный продукт")
    res = run_decision(db, app, amount, term_months, product)
    return {"score": res["score"], "grade": res["grade"], "affordability": res["affordability"], "decision": res["decision"]}


@router.post("/applications/{app_id}/decision", response_model=ApplicationOut, summary="Решение сотрудника по заявке")
def decision(app_id: str, body: DecisionIn, request: Request, user: User = Depends(require_employee), db: Session = Depends(get_db)):
    app = get_any_app(db, app_id)
    s = get_settings()
    actor = _actor(user)
    if app.status == S.COMMITTEE_REVIEW and user.role not in ("RISK_MANAGER", "ADMIN"):
        raise HTTPException(403, "Решение на этапе согласования принимает риск-менеджер")
    if app.status not in (S.MANUAL_REVIEW, S.COMMITTEE_REVIEW):
        raise HTTPException(409, f"Решение невозможно в статусе {app.status}")

    sc = app.scoring or {}
    rec = (sc.get("decision") or {}).get("recommended_offer") or {}
    product = db.get(Product, body.product_code) if body.product_code else app.product
    if not product:
        raise HTTPException(422, "Неизвестный продукт")
    amount = body.amount or rec.get("amount") or app.amount
    term = body.term_months or rec.get("term_months") or app.term_months
    rate = body.rate or rec.get("rate") or (sc.get("affordability") or {}).get("rate") or (s.key_rate + product.margin)

    try:
        if body.action in ("APPROVE", "COUNTER_OFFER"):
            if not (product.min_amount <= amount <= product.max_amount and product.min_term <= term <= product.max_term):
                raise HTTPException(422, "Условия вне параметров продукта")
            needs_committee = amount > s.committee_limit and app.status == S.MANUAL_REVIEW and user.role == "ANALYST"
            if needs_committee:
                app.decision = {**app.decision, "proposal": {"action": body.action, "amount": amount, "term_months": term,
                                                              "rate": rate, "product_code": product.code, "by": user.full_name,
                                                              "comment": body.comment}}
                transition(db, app, S.COMMITTEE_REVIEW, actor, "Решение согласуется с риск-менеджером (принцип «четырёх глаз»)")
            else:
                kind = "FULL" if body.action == "APPROVE" else "COUNTER"
                offer = _offer(product_terms(product), amount, term, rate, kind,
                               "Условия, согласованные специалистом банка")
                options = [offer]
                if body.action == "COUNTER_OFFER":
                    options += [a for a in (sc.get("decision") or {}).get("alternatives", [])
                                if (a["amount"], a["term_months"]) != (amount, term)][:2]
                set_offer(app, options)
                app.decision = {**app.decision, "outcome": body.action, "by": user.full_name, "role": user.role,
                                "reasons": [body.comment], "at": datetime.now(UTC).isoformat()}
                to = S.APPROVED if body.action == "APPROVE" else S.COUNTER_OFFER
                msg = ("Кредит одобрен. Ознакомьтесь с условиями предложения." if to == S.APPROVED
                       else "Банк готов выдать кредит на скорректированных условиях. Выберите вариант.")
                transition(db, app, to, actor, msg)
        elif body.action == "REJECT":
            app.decision = {**app.decision, "outcome": "REJECT", "by": user.full_name, "reasons": [body.comment],
                            "tips": (sc.get("decision") or {}).get("improvement_tips", []),
                            "at": datetime.now(UTC).isoformat()}
            transition(db, app, S.REJECTED, actor, "Банк не может выдать кредит. " + body.comment)
        elif body.action == "REQUEST_INFO":
            items = [{"code": "ANALYST", "type": "field", "text": t} for t in (body.info_items or [])]
            items += [{"code": f"DOC_{d}", "type": "document", "doc_type": d, "text": f"Загрузите: {DOC_LABELS.get(d, d)}"}
                      for d in (body.request_doc_types or [])]
            if not items:
                raise HTTPException(422, "Укажите, что запросить у клиента")
            app.info_request = {"items": items, "message": body.comment, "requested_at": datetime.now(UTC).isoformat(),
                                "by": user.full_name, "response": None}
            app.info_rounds += 1
            transition(db, app, S.INFO_REQUESTED, actor, "Специалист банка просит уточнить: " + "; ".join(i["text"] for i in items))
        elif body.action == "TO_COMMITTEE":
            transition(db, app, S.COMMITTEE_REVIEW, actor, "Заявка передана на согласование риск-менеджеру")
        elif body.action == "RETURN_TO_ANALYST":
            transition(db, app, S.MANUAL_REVIEW, actor, "Заявка возвращена специалисту для доработки")
    except TransitionError as e:
        raise HTTPException(409, str(e))

    log_event(db, app, "EMPLOYEE_DECISION", f"{body.action}: {body.comment}", actor,
              {"action": body.action, "amount": amount, "term": term, "rate": rate}, visible_to_client=False)
    audit(db, request, user, f"DECISION_{body.action}", "application", app.id, {"comment": body.comment})
    db.commit()
    after_commit()
    db.refresh(app)
    return to_full(app, True)


@router.get("/dashboard", summary="Метрики конвейера: воронка, доля автоматических решений, время до решения")
def dashboard(user: User = Depends(require_employee), db: Session = Depends(get_db)):
    by_status = dict(db.execute(select(Application.status, func.count()).group_by(Application.status)).all())
    apps = db.scalars(select(Application).where(Application.decided_at.is_not(None))).all()
    decided = len(apps)
    auto = sum(1 for a in apps if (a.decision or {}).get("by") == "SYSTEM")
    approved_statuses = {S.APPROVED, S.COUNTER_OFFER, S.OFFER_ACCEPTED, S.SIGNING, S.SIGNED, S.DISBURSED}
    approved = sum(1 for a in apps if a.status in approved_statuses or (a.status == S.CANCELLED and a.offer))
    times = []
    for a in apps:
        if a.submitted_at and a.decided_at:
            sub = a.submitted_at if a.submitted_at.tzinfo else a.submitted_at.replace(tzinfo=UTC)
            dec = a.decided_at if a.decided_at.tzinfo else a.decided_at.replace(tzinfo=UTC)
            times.append((dec - sub).total_seconds() / 60)
    disbursed = db.scalar(select(func.coalesce(func.sum(Application.amount), 0)).where(Application.status == S.DISBURSED))
    funnel_order = ["SUBMITTED", "DECIDED", "OFFER_ACCEPTED", "SIGNED", "DISBURSED"]
    total_sub = db.scalar(select(func.count()).select_from(Application).where(Application.submitted_at.is_not(None))) or 0
    accepted = sum(by_status.get(s, 0) for s in (S.OFFER_ACCEPTED, S.SIGNING, S.SIGNED, S.DISBURSED))
    signed = sum(by_status.get(s, 0) for s in (S.SIGNED, S.DISBURSED))
    return {
        "by_status": [{"status": k, "label": STATUS_INFO[k]["label"], "count": v} for k, v in sorted(by_status.items())],
        "total_submitted": total_sub,
        "decided": decided,
        "auto_decision_rate": round(auto / decided, 3) if decided else 0,
        "approval_rate": round(approved / decided, 3) if decided else 0,
        "avg_minutes_to_decision": round(sum(times) / len(times), 1) if times else None,
        "manual_queue": by_status.get(S.MANUAL_REVIEW, 0) + by_status.get(S.COMMITTEE_REVIEW, 0),
        "disbursed_amount": float(disbursed or 0),
        "funnel": dict(zip(funnel_order, [total_sub, decided, accepted, signed, by_status.get(S.DISBURSED, 0)], strict=False)),
    }


@router.get("/audit", summary="Журнал аудита (только администратор)")
def audit_log(limit: int = Query(100, le=500), user: User = Depends(require_roles("ADMIN", "RISK_MANAGER")), db: Session = Depends(get_db)):
    rows = db.scalars(select(AuditLog).order_by(AuditLog.created_at.desc()).limit(limit)).all()
    return [{"at": r.created_at, "actor": r.actor_email, "action": r.action, "entity": r.entity, "entity_id": r.entity_id,
             "ip": r.ip, "details": r.details} for r in rows]


@router.get("/events", summary="Последние события по всем заявкам (лента активности)")
def events(limit: int = Query(30, le=200), user: User = Depends(require_employee), db: Session = Depends(get_db)):
    rows = db.execute(select(ApplicationEvent, Application.number).join(Application)
                      .order_by(ApplicationEvent.created_at.desc()).limit(limit)).all()
    return [{"at": e.created_at, "number": n, "application_id": e.application_id, "type": e.event_type,
             "to_status": e.to_status, "actor": e.actor_name, "message": e.message} for e, n in rows]


# ------------------------------------------------------------------ news management


@router.get("/companies", summary="Компании (для предпросмотра персональной ленты)")
def companies(user: User = Depends(require_employee), db: Session = Depends(get_db)):
    return [{"id": c.id, "name": c.name, "inn": c.inn, "okved": c.okved, "okved_name": c.okved_name, "region": c.region,
             "segment": c.segment, "legal_form": c.legal_form} for c in db.scalars(select(Company).order_by(Company.name))]


@router.get("/news", response_model=list[NewsOut], summary="Все материалы ленты")
def news_all(user: User = Depends(require_employee), db: Session = Depends(get_db)):
    return [NewsOut.model_validate(n) for n in db.scalars(select(NewsItem).order_by(NewsItem.published_at.desc()))]


@router.post("/news", response_model=NewsOut, status_code=201, summary="Опубликовать материал с таргетингом")
def news_create(body: NewsIn, request: Request, user: User = Depends(require_roles("ADMIN")), db: Session = Depends(get_db)):
    n = NewsItem(**body.model_dump(), created_by=user.id)
    db.add(n)
    db.flush()
    audit(db, request, user, "NEWS_CREATED", "news", n.id, {"title": n.title})
    db.commit()
    return NewsOut.model_validate(n)


@router.delete("/news/{news_id}", status_code=204, summary="Снять материал с публикации")
def news_delete(news_id: str, request: Request, user: User = Depends(require_roles("ADMIN")), db: Session = Depends(get_db)):
    n = db.get(NewsItem, news_id)
    if not n:
        raise HTTPException(404, "Материал не найден")
    n.is_active = False
    audit(db, request, user, "NEWS_UNPUBLISHED", "news", n.id)
    db.commit()


@router.get("/news/preview", response_model=list[NewsOut], summary="Как выглядит лента для конкретной компании")
def news_preview(company_id: str, user: User = Depends(require_employee), db: Session = Depends(get_db)):
    company = db.get(Company, company_id)
    if not company:
        raise HTTPException(404, "Компания не найдена")
    out = []
    for r in rank_feed(db, company):
        n = NewsOut.model_validate(r["item"])
        n.relevance, n.reasons = r["relevance"], r["reasons"]
        out.append(n)
    return out
