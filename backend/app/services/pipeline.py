"""Автоматические этапы кредитного конвейера.

Каждый этап — идемпотентный обработчик задачи PipelineTask. Этапы выполняет отдельный
процесс `worker` (горизонтально масштабируется: задачи выбираются через SELECT ... FOR UPDATE SKIP LOCKED).
"""
from __future__ import annotations

import hashlib
import logging
import secrets
import tempfile
import time
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Application, Document, PipelineTask, Product
from ..scoring.engine import Features, ProductTerms, decide
from ..scoring.finance import schedule
from ..state_machine import SYSTEM, log_event, notify, transition
from ..state_machine import Status as S
from . import integrations
from .integrations import SourceUnavailable

log = logging.getLogger("pipeline")

DOC_LABELS = {
    "FIN_STATEMENTS": "Бухгалтерская отчётность за последний год",
    "BANK_STATEMENT": "Выписка по расчётному счёту за 6–12 месяцев (CSV)",
    "COLLATERAL_DOCS": "Документы по залогу (право собственности, оценка)",
    "OTHER": "Иной документ",
    "CONTRACT": "Кредитный договор",
}


def product_terms(p: Product) -> ProductTerms:
    return ProductTerms(
        code=p.code, name=p.name, min_amount=p.min_amount, max_amount=p.max_amount, min_term=p.min_term,
        max_term=p.max_term, margin=p.margin, rate_cap=p.rate_cap, collateral_required=p.collateral_required,
        requires_account=p.requires_account, eligible_okved_prefixes=list(p.eligible_okved_prefixes or []),
    )


def _doc_types(app: Application) -> set[str]:
    return {d.doc_type for d in app.documents}


def required_documents(app: Application) -> list[str]:
    req = list(app.product.required_documents or [])
    if app.amount > get_settings().auto_decision_limit and "FIN_STATEMENTS" not in req:
        req.append("FIN_STATEMENTS")
    return req


# --------------------------------------------------------------------------- stages


def stage_accept(db: Session, app: Application) -> None:
    if app.status != S.SUBMITTED:
        return
    transition(db, app, S.VALIDATION, SYSTEM, delay_sec=get_settings().pipeline_step_delay_sec)


def stage_validate(db: Session, app: Application) -> None:
    if app.status != S.VALIDATION:
        return
    p, fd = app.product, app.form_data or {}
    fin, col = fd.get("financials") or {}, fd.get("collateral") or {}
    errors, requests = [], []

    if not (p.min_amount <= app.amount <= p.max_amount):
        errors.append(f"Сумма вне диапазона продукта ({p.min_amount:,.0f}–{p.max_amount:,.0f} ₽)".replace(",", " "))
    if not (p.min_term <= app.term_months <= p.max_term):
        errors.append(f"Срок вне диапазона продукта ({p.min_term}–{p.max_term} мес.)")
    if not (app.consents or {}).get("bki") or not (app.consents or {}).get("personal_data"):
        requests.append({"code": "CONSENT", "type": "field", "text": "Подтвердите согласия на запрос в БКИ и обработку данных"})
    if not fin.get("revenue_last_year"):
        requests.append({"code": "REVENUE", "type": "field", "text": "Укажите выручку за последний год"})
    if p.collateral_required and not float(col.get("estimated_value") or 0):
        requests.append({"code": "COLLATERAL", "type": "field", "text": "Укажите предмет залога и его оценочную стоимость"})
    have = _doc_types(app)
    for dt in required_documents(app):
        if dt not in have:
            requests.append({"code": f"DOC_{dt}", "type": "document", "doc_type": dt, "text": f"Загрузите: {DOC_LABELS[dt]}"})

    app.validation = {"checked_at": _now(), "errors": errors, "requests": requests}
    if errors:
        transition(db, app, S.REJECTED, SYSTEM, "Параметры заявки не соответствуют условиям продукта: " + "; ".join(errors))
        app.decision = {"outcome": "REJECT", "reasons": errors, "by": "SYSTEM"}
        return
    if requests:
        _request_info(db, app, requests, "Для продолжения рассмотрения нужны дополнительные сведения")
        return
    log_event(db, app, "VALIDATION_PASSED", "Данные заявки заполнены полностью и корректно", SYSTEM)
    transition(db, app, S.ENRICHMENT, SYSTEM, delay_sec=get_settings().pipeline_step_delay_sec)


def stage_enrich(db: Session, app: Application) -> None:
    if app.status != S.ENRICHMENT:
        return
    inn = app.company.inn
    sources = {
        "egrul": lambda: integrations.egrul(inn),
        "fns": lambda: integrations.fns_transparent(inn),
        "bki": lambda: integrations.bki_report(inn, consent_id=app.id),
        "antifraud": lambda: integrations.antifraud(inn, app.amount),
        "accounts": lambda: integrations.internal_accounts(inn),
    }
    data: dict = {"fetched_at": _now(), "unavailable": []}
    for key, fn in sources.items():
        try:
            data[key] = fn()
        except SourceUnavailable as e:
            data[key] = None
            data["unavailable"].append(e.source)
    app.enrichment = data
    got = [k for k in sources if data.get(k)]
    log_event(db, app, "ENRICHMENT_DONE",
              "Получены сведения из внешних источников" + (f" (недоступно: {', '.join(data['unavailable'])})" if data["unavailable"] else ""),
              SYSTEM, {"sources": got, "unavailable": data["unavailable"]})

    # Сверка заявленной выручки с данными ФНС → запрос подтверждения, если расхождение > 35%
    declared = float(((app.form_data or {}).get("financials") or {}).get("revenue_last_year") or 0)
    fns_rev = float((data.get("fns") or {}).get("revenue_last_year") or 0)
    has_proof = bool(_doc_types(app) & {"BANK_STATEMENT", "FIN_STATEMENTS"})
    if fns_rev and declared and abs(declared - fns_rev) / fns_rev > 0.35 and not has_proof and app.info_rounds < 2:
        _request_info(db, app, [{
            "code": "REVENUE_MISMATCH", "type": "document", "doc_type": "BANK_STATEMENT",
            "text": (f"Указанная выручка ({declared:,.0f} ₽) отличается от данных ФНС ({fns_rev:,.0f} ₽). "
                     "Загрузите выписку по счёту за 6–12 месяцев или отчётность — это подтвердит обороты.").replace(",", " "),
        }], "Нужно подтвердить выручку")
        return
    transition(db, app, S.SCORING, SYSTEM, delay_sec=get_settings().pipeline_step_delay_sec)


def build_features(app: Application) -> Features:
    e = app.enrichment or {}
    eg, fns, bki = e.get("egrul") or {}, e.get("fns") or {}, e.get("bki") or {}
    af, acc = e.get("antifraud") or {}, e.get("accounts") or {}
    fd = app.form_data or {}
    fin, col = fd.get("financials") or {}, fd.get("collateral") or {}

    reg = eg.get("registration_date") or (app.company.registration_date.isoformat() if app.company.registration_date else None)
    age = 0
    if reg:
        d = date.fromisoformat(reg)
        today = date.today()
        age = (today.year - d.year) * 12 + today.month - d.month

    declared_rev = float(fin.get("revenue_last_year") or 0)
    declared_exp = float(fin.get("expenses_last_year") or 0)
    statement = next((d.parsed for d in app.documents if d.doc_type == "BANK_STATEMENT" and d.parsed.get("ok")), None)
    if statement:
        revenue, verified = float(statement["annualized_inflow"]), True
    elif fns.get("revenue_last_year"):
        revenue, verified = float(fns["revenue_last_year"]), True
    elif acc.get("is_client"):
        revenue, verified = float(acc.get("avg_monthly_inflow", 0)) * 12, True
    else:
        revenue, verified = declared_rev, False
    exp_ratio = declared_exp / declared_rev if declared_rev else 0.85
    if fns.get("expenses_last_year") and fns.get("revenue_last_year"):
        exp_ratio = max(exp_ratio, float(fns["expenses_last_year"]) / float(fns["revenue_last_year"]))
    expenses = revenue * exp_ratio

    bki_payments = sum(float(x.get("monthly_payment", 0)) for x in bki.get("active_loans", []))
    flags = fns.get("flags") or {}
    status = eg.get("status", "ACTIVE") if eg.get("found", True) else "NOT_FOUND"
    return Features(
        business_age_months=age,
        revenue_annual=revenue,
        expenses_annual=expenses,
        existing_monthly_payments=max(float(fin.get("existing_monthly_payments") or 0), bki_payments),
        okved=(eg.get("okved_main") or {}).get("code") or app.company.okved or "",
        company_status=status,
        bki_score=bki.get("score"),
        max_overdue_days_12m=int(bki.get("max_overdue_days_12m", 0)),
        current_overdue_days=int(bki.get("current_overdue_days", 0)),
        inquiries_30d=int(bki.get("inquiries_30d", 0)),
        tax_arrears=float(fns.get("tax_arrears", 0)),
        is_bank_client=bool(acc.get("is_client")),
        account_months=int(acc.get("account_months", 0)),
        avg_turnover_in=float(acc.get("avg_monthly_inflow", 0)),
        disqualified_director=bool(flags.get("disqualified_director")),
        mass_address=bool(flags.get("mass_address")),
        unreliable_info=bool(flags.get("unreliable_info")),
        antifraud_level=af.get("risk_level", "LOW"),
        collateral_value=float(col.get("estimated_value") or 0),
        has_guarantee=bool(fd.get("owner_guarantee")),
        revenue_verified=verified,
        sources_unavailable=list(e.get("unavailable", [])),
    )


def run_decision(db: Session, app: Application, amount: float | None = None, term: int | None = None,
                 product: Product | None = None) -> dict:
    """Расчёт модели. Параметры amount/term/product позволяют сделать what-if без изменения заявки."""
    s = get_settings()
    features = build_features(app)
    alts = [product_terms(p) for p in db.scalars(select(Product).where(Product.is_active.is_(True))).all()]
    res = decide(features, product_terms(product or app.product), amount or app.amount, term or app.term_months,
                 s.key_rate, s.auto_decision_limit, alts)
    res["features"] = features.__dict__
    res["calculated_at"] = _now()
    return res


def stage_score(db: Session, app: Application) -> None:
    if app.status != S.SCORING:
        return
    res = run_decision(db, app)
    app.scoring = res
    d = res["decision"]
    log_event(db, app, "SCORING_DONE",
              f"Скоринг: {res['score']} баллов, рейтинг {res['grade']}, PD {res['pd'] * 100:.1f}%. Рекомендация: {d['outcome']}",
              SYSTEM, {"score": res["score"], "grade": res["grade"], "outcome": d["outcome"]}, visible_to_client=False)
    outcome = d["outcome"]
    if outcome == "APPROVE":
        set_offer(app, [d["recommended_offer"]])
        app.decision = {"outcome": "APPROVE", "by": "SYSTEM", "reasons": d["reasons"], "at": _now()}
        transition(db, app, S.APPROVED, SYSTEM, "Кредит одобрен автоматически. Ознакомьтесь с условиями предложения.")
    elif outcome == "COUNTER_OFFER":
        set_offer(app, d["alternatives"])
        app.decision = {"outcome": "COUNTER_OFFER", "by": "SYSTEM", "reasons": d["reasons"], "at": _now()}
        transition(db, app, S.COUNTER_OFFER, SYSTEM,
                   "Банк готов выдать кредит на скорректированных условиях. Выберите подходящий вариант.")
    elif outcome == "MANUAL_REVIEW":
        app.decision = {"outcome": "MANUAL_REVIEW", "by": "SYSTEM", "reasons": d["reasons"], "at": _now()}
        transition(db, app, S.MANUAL_REVIEW, SYSTEM)
    else:
        app.decision = {"outcome": "REJECT", "by": "SYSTEM", "reasons": d["reasons"],
                        "tips": d["improvement_tips"], "at": _now()}
        transition(db, app, S.REJECTED, SYSTEM, "Банк не может выдать кредит на текущих данных. Посмотрите, что можно улучшить.")


def offer_conditions(product: Product, app: Application) -> list[str]:
    from .assistant import PURPOSE_LABELS

    cond = ["Целевое использование средств: " + (app.purpose_comment or PURPOSE_LABELS.get(app.purpose or "", "развитие бизнеса"))]
    if product.guarantee_required:
        cond.append("Поручительство собственника бизнеса")
    if product.collateral_required:
        col = (app.form_data or {}).get("collateral") or {}
        cond.append(f"Залог: {col.get('description') or 'имущество'}")
    if product.code == "GOV_1764":
        cond.append("Льготная ставка по программе поддержки МСП — при соблюдении условий программы")
    cond.append("Досрочное погашение без комиссий")
    return cond


def set_offer(app: Application, options: list[dict]) -> None:
    app.offer = {
        "options": options,
        "valid_until": (date.today() + timedelta(days=get_settings().offer_ttl_days)).isoformat(),
        "conditions": offer_conditions(app.product, app),
        "selected_index": None,
    }


def stage_prepare_docs(db: Session, app: Application) -> None:
    if app.status != S.OFFER_ACCEPTED:
        return
    o = app.offer["options"][app.offer["selected_index"]]
    contract_no = f"КД-{app.number.split('-', 1)[1]}"
    html = render_contract(app, o, contract_no)
    db.add(Document(application_id=app.id, doc_type="CONTRACT", filename=f"{contract_no}.html", content_type="text/html",
                    size=len(html.encode()), sha256=hashlib.sha256(html.encode()).hexdigest(), content=html.encode(),
                    parsed={}, uploaded_by="SYSTEM"))
    code = f"{secrets.randbelow(1_000_000):06d}"
    app.sign_code_hash = hashlib.sha256(f"{app.id}:{code}".encode()).hexdigest()
    app.loan = {"contract_number": contract_no}
    notify(db, app, "Код для подписания договора",
           f"Ваш код простой электронной подписи для договора {contract_no}: {code}. "
           "Никому его не сообщайте — сотрудники банка его не спрашивают.", "SIGN_CODE")
    transition(db, app, S.SIGNING, SYSTEM, "Договор сформирован. Проверьте условия и подпишите его кодом из уведомлений.")


def stage_disburse(db: Session, app: Application) -> None:
    if app.status != S.SIGNED:
        return
    o = app.offer["options"][app.offer["selected_index"]]
    res = integrations.core_disburse({
        "application_id": app.id, "inn": app.company.inn, "amount": o["amount"], "rate": o["rate"],
        "term_months": o["term_months"], "contract_number": app.loan.get("contract_number"),
    })
    start = date.today()
    app.loan = {
        **app.loan, **{k: res.get(k) for k in ("loan_id", "account", "disbursed_at")},
        "amount": o["amount"], "rate": o["rate"], "term_months": o["term_months"],
        "monthly_payment": o["monthly_payment"], "schedule": schedule(o["amount"], o["rate"], o["term_months"], start),
    }
    transition(db, app, S.DISBURSED, SYSTEM,
               f"{o['amount']:,.0f} ₽ зачислены на счёт {res.get('account')}. График платежей доступен в заявке.".replace(",", " "))


STAGES = {
    "ACCEPT": stage_accept,
    "VALIDATE": stage_validate,
    "ENRICH": stage_enrich,
    "SCORE": stage_score,
    "PREPARE_DOCS": stage_prepare_docs,
    "DISBURSE": stage_disburse,
}


# --------------------------------------------------------------------------- helpers


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _request_info(db: Session, app: Application, items: list[dict], message: str) -> None:
    app.info_request = {"items": items, "message": message, "requested_at": _now(), "by": "SYSTEM", "response": None}
    app.info_rounds += 1
    transition(db, app, S.INFO_REQUESTED, SYSTEM, message + ": " + "; ".join(i["text"] for i in items))


def render_contract(app: Application, o: dict, contract_no: str) -> str:
    c = app.company
    rows = "".join(f"<li>{x}</li>" for x in app.offer.get("conditions", []))
    fmt = lambda v: f"{v:,.2f}".replace(",", " ")  # noqa: E731
    return f"""<!doctype html><html lang="ru"><meta charset="utf-8"><title>{contract_no}</title>
<body style="font-family:Georgia,serif;max-width:760px;margin:40px auto;line-height:1.5">
<h2>Кредитный договор № {contract_no}</h2>
<p><i>Документ сформирован прототипом CreditFlow. Синтетические данные, юридической силы не имеет.</i></p>
<p><b>Заёмщик:</b> {c.name}, ИНН {c.inn}, ОГРН {c.ogrn or '—'}, адрес: {c.address or '—'}.</p>
<p><b>Продукт:</b> {o['product_name']}</p>
<table border="1" cellpadding="6" style="border-collapse:collapse">
<tr><td>Сумма кредита</td><td>{fmt(o['amount'])} ₽</td></tr>
<tr><td>Срок</td><td>{o['term_months']} мес.</td></tr>
<tr><td>Процентная ставка</td><td>{o['rate']}% годовых</td></tr>
<tr><td>Ежемесячный аннуитетный платёж</td><td>{fmt(o['monthly_payment'])} ₽</td></tr>
<tr><td>Полная сумма выплат</td><td>{fmt(o['total_payment'])} ₽</td></tr>
</table>
<h3>Условия</h3><ul>{rows}</ul>
<p>Подписывая договор простой электронной подписью, Заёмщик подтверждает согласие с условиями.</p>
</body></html>"""


# --------------------------------------------------------------------------- worker loop


def process_task(db: Session, task: PipelineTask) -> None:
    app = db.get(Application, task.application_id)
    handler = STAGES[task.stage]
    handler(db, app)


def claim_next(db: Session) -> PipelineTask | None:
    stmt = (
        select(PipelineTask)
        .where(PipelineTask.status == "PENDING", PipelineTask.run_after <= datetime.now(UTC))
        .order_by(PipelineTask.run_after)
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    task = db.scalars(stmt).first()
    if task:
        task.status = "RUNNING"
        task.attempts += 1
        db.commit()
    return task


def run_one(session_factory, ignore_delay: bool = False) -> bool:
    """Выполнить одну задачу. Возвращает False, если очередь пуста."""
    with session_factory() as db:
        if ignore_delay:
            stmt = select(PipelineTask).where(PipelineTask.status == "PENDING").order_by(PipelineTask.created_at).limit(1)
            task = db.scalars(stmt).first()
            if task:
                task.status, task.attempts = "RUNNING", task.attempts + 1
                db.commit()
        else:
            task = claim_next(db)
        if not task:
            return False
        task_id = task.id
    with session_factory() as db:
        task = db.get(PipelineTask, task_id)
        try:
            process_task(db, task)
            task.status = "DONE"
            task.last_error = None
            db.commit()
        except Exception as e:  # noqa: BLE001 — ошибка этапа не должна ронять воркер
            db.rollback()
            task = db.get(PipelineTask, task_id)
            task.last_error = f"{e.__class__.__name__}: {e}"
            if task.attempts < 5:
                task.status = "PENDING"
                task.run_after = datetime.now(UTC) + timedelta(seconds=2 ** task.attempts)
            else:
                task.status = "FAILED"
                app = db.get(Application, task.application_id)
                log_event(db, app, "PIPELINE_ERROR", f"Этап {task.stage} завершился ошибкой: {task.last_error}",
                          SYSTEM, visible_to_client=False)
            db.commit()
            log.exception("pipeline task failed", extra={"task": task_id, "stage": task.stage})
    return True


def drain(session_factory, max_steps: int = 50) -> None:
    """Синхронно выполнить все задачи (режим тестов / RUN_PIPELINE_INLINE)."""
    for _ in range(max_steps):
        if not run_one(session_factory, ignore_delay=True):
            break


def worker_loop(session_factory) -> None:
    s = get_settings()
    log.info("worker started")
    heartbeat = Path(tempfile.gettempdir()) / "worker-heartbeat"
    while True:
        heartbeat.touch()  # для healthcheck контейнера
        try:
            if not run_one(session_factory):
                time.sleep(s.worker_poll_interval_sec)
        except Exception:  # noqa: BLE001
            log.exception("worker iteration failed")
            time.sleep(2)
