"""ИИ-ассистент. Применяется только там, где даёт понятную ценность:

1. Разбор потребности из свободного текста → цель, сумма, срок → подбор продукта.
2. Объяснение статуса, решения и следующего шага простым языком (по данным заявки).
3. Краткое резюме заявки для кредитного специалиста.

Работает в двух режимах:
* rules — детерминированные правила и база знаний (по умолчанию, без внешних зависимостей);
* llm  — open-weights модель (Qwen2.5-Instruct) через локальный Ollama. LLM получает только
  факты из заявки и базы знаний (RAG), не принимает кредитных решений, а её ответ имеет
  гарантированный fallback на правила при ошибке или таймауте.
"""
from __future__ import annotations

import json
import logging
import re

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import Application, Company, Product
from ..scoring.engine import ProductTerms, rate_for
from ..scoring.finance import annuity_payment
from ..state_machine import STATUS_INFO

log = logging.getLogger("assistant")

PURPOSE_LABELS = {
    "EQUIPMENT": "покупка оборудования или транспорта",
    "WORKING_CAPITAL": "пополнение оборотных средств, закупка товара",
    "CASH_GAP": "кассовый разрыв: зарплата, налоги, аренда",
    "EXPANSION": "развитие: новая точка, направление",
    "REAL_ESTATE": "покупка или ремонт помещения",
    "REFINANCE": "рефинансирование других кредитов",
    "TENDER": "исполнение госконтракта или тендера",
}

PURPOSE_KEYWORDS = [
    ("EQUIPMENT", r"оборудован|станок|станк|печ[ьи]|техник|машин|автомобил|грузовик|фур[уы]|трактор|линию|кофемашин"),
    ("REAL_ESTATE", r"помещени|недвижим|склад|офис|здани|ремонт"),
    ("CASH_GAP", r"кассов|разрыв|зарплат|налог|аренд|отсрочк"),
    ("TENDER", r"госконтракт|тендер|44-фз|223-фз|контракт"),
    ("REFINANCE", r"рефинанс|перекредит|погасить другой|другой кредит"),
    ("EXPANSION", r"открыт|филиал|точк|расшир|масштаб|нов(ое|ый) направлени"),
    ("WORKING_CAPITAL", r"закуп|товар|сырь|оборот|материал|запас|сезон"),
]

KB = [
    {"keys": r"статус|что происходит|где заявк|этап", "title": "Статусы заявки",
     "text": "Заявка проходит этапы: проверка данных → запрос сведений из ЕГРЮЛ, ФНС и БКИ → оценка → решение → "
             "подписание договора → выдача. Текущий этап и следующий шаг всегда видны на странице заявки."},
    {"keys": r"документ|какие нужн|выписк|отчетност|отчётност", "title": "Документы",
     "text": "Для экспресс-кредита документы обычно не нужны: данные о компании мы получаем из ЕГРЮЛ и ФНС сами. "
             "Выписка по счёту в CSV ускоряет решение, если вы не клиент банка. Для сумм больше 10 млн ₽ нужна "
             "бухгалтерская отчётность, для инвестиционного кредита — документы по залогу."},
    {"keys": r"dscr|дскр|нагрузк|сколько дадут|лимит|максимальн", "title": "Как считается лимит",
     "text": "Лимит считается по денежному потоку: ежемесячные платежи по всем кредитам не должны превышать "
             "денежный поток бизнеса, делённый на 1,3 (коэффициент DSCR). Чем выше подтверждённая выручка и ниже текущие "
             "платежи, тем больше лимит."},
    {"keys": r"ставк|процент|дорого|ключев", "title": "Ставка",
     "text": "Ставка = ключевая ставка ЦБ (сейчас 14%) + надбавка продукта + надбавка за риск по рейтингу. "
             "Клиентам с расчётным счётом в банке — скидка 0,5 п.п. По льготной программе МСП ставка ограничена."},
    {"keys": r"льгот|господдерж|1764|программ|мсп", "title": "Льготная программа",
     "text": "Льготный кредит по программе поддержки МСП доступен компаниям из приоритетных отраслей: производство, "
             "сельское хозяйство, IT, логистика, туризм, образование и здравоохранение. Ставка ниже рыночной, "
             "если нет долгов по налогам."},
    {"keys": r"отказ|почему не|не одобр", "title": "Почему может быть отказ",
     "text": "Основные причины: просрочки по кредитам, долги по налогам, отрицательный денежный поток, срок бизнеса "
             "меньше 3 месяцев, ограничения в ЕГРЮЛ. В заявке показано, что повлияло на решение и что можно улучшить."},
    {"keys": r"подпис|код|договор|эп|электронн", "title": "Подписание",
     "text": "После принятия предложения формируется договор. Его подписывают кодом простой электронной подписи — "
             "код приходит в уведомления личного кабинета. Сотрудники банка никогда не спрашивают этот код."},
    {"keys": r"залог|обеспечен|поручител", "title": "Залог и поручительство",
     "text": "Экспресс-кредит выдаётся без залога. Для оборотного кредита нужно поручительство собственника. "
             "Инвестиционный кредит требует залога (недвижимость, оборудование, транспорт): с залогом лимит выше, а ставка ниже."},
    {"keys": r"быстр|сколько ждать|срок рассмотр|когда", "title": "Сроки",
     "text": "Экспресс-кредит до 10 млн ₽ рассматривается автоматически за несколько минут. Если заявке нужна "
             "экспертиза, её изучает специалист — обычно до 4 рабочих часов."},
    {"keys": r"досрочн|погасить раньше", "title": "Досрочное погашение",
     "text": "Погасить кредит досрочно можно в любой момент без комиссий — полностью или частично."},
]

AMOUNT_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*(млрд|млн|миллион\w*|тыс\w*|т\.р\.|к\b|₽|руб\w*)?", re.I)
TERM_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*(год|года|лет|мес\w*)", re.I)


# --------------------------------------------------------------------------- LLM


def _llm(messages: list[dict], json_mode: bool = False) -> str | None:
    s = get_settings()
    if not s.llm_enabled:
        return None
    try:
        body = {"model": s.llm_model, "messages": messages, "stream": False, "options": {"temperature": 0.2}}
        if json_mode:
            body["format"] = "json"
        r = httpx.post(f"{s.ollama_url}/api/chat", json=body, timeout=s.llm_timeout_sec)
        r.raise_for_status()
        return r.json()["message"]["content"].strip()
    except Exception as e:  # noqa: BLE001 — LLM не должна ломать сценарий
        log.warning("llm unavailable: %s", e)
        return None


def llm_status() -> dict:
    s = get_settings()
    if not s.llm_enabled:
        return {"enabled": False, "model": None}
    try:
        r = httpx.get(f"{s.ollama_url}/api/tags", timeout=2)
        models = [m["name"] for m in r.json().get("models", [])]
        return {"enabled": True, "model": s.llm_model, "available": s.llm_model in models}
    except Exception:  # noqa: BLE001
        return {"enabled": True, "model": s.llm_model, "available": False}


# --------------------------------------------------------------------------- 1. need parsing


def parse_need_rules(text: str) -> dict:
    t = text.lower().replace(" ", " ")
    purpose = next((code for code, rx in PURPOSE_KEYWORDS if re.search(rx, t)), None)

    amount = None
    for m in AMOUNT_RE.finditer(t):
        num, unit = float(m.group(1).replace(",", ".")), (m.group(2) or "").lower()
        after = t[m.end():m.end() + 6]
        if re.match(r"\s*(год|лет|мес)", after) or unit.startswith(("год", "мес")):
            continue
        if unit.startswith("млрд"):
            amount = num * 1e9
        elif unit.startswith(("млн", "миллион")):
            amount = num * 1e6
        elif unit.startswith(("тыс", "т.р", "к")):
            amount = num * 1e3
        elif num >= 10_000:
            amount = num
        if amount:
            break

    term = None
    tm = TERM_RE.search(t)
    if tm:
        n = float(tm.group(1).replace(",", "."))
        term = int(n * 12) if tm.group(2).startswith(("год", "лет")) else int(n)
    elif re.search(r"на\s+год\b", t):
        term = 12
    elif re.search(r"полгода", t):
        term = 6

    has_collateral = bool(re.search(r"залог|есть недвижим|в собственности|под залог", t)) and not re.search(r"без залога", t)
    return {"purpose": purpose, "amount": amount, "term_months": term, "has_collateral": has_collateral}


def parse_need(text: str) -> tuple[dict, str]:
    rules = parse_need_rules(text)
    out = _llm([
        {"role": "system", "content": (
            "Ты извлекаешь параметры кредитной потребности предпринимателя из текста. Верни JSON с ключами: "
            "purpose (одно из: " + ", ".join(PURPOSE_LABELS) + " или null), amount (число в рублях или null), "
            "term_months (целое или null), has_collateral (true/false). Не выдумывай значения.")},
        {"role": "user", "content": text},
    ], json_mode=True)
    if out:
        try:
            data = json.loads(out)
            merged = {
                "purpose": data.get("purpose") if data.get("purpose") in PURPOSE_LABELS else rules["purpose"],
                "amount": float(data["amount"]) if isinstance(data.get("amount"), (int, float)) and data["amount"] > 0 else rules["amount"],
                "term_months": int(data["term_months"]) if isinstance(data.get("term_months"), (int, float)) and 0 < data["term_months"] <= 120 else rules["term_months"],
                "has_collateral": bool(data.get("has_collateral", rules["has_collateral"])),
            }
            return merged, f"llm:{get_settings().llm_model}"
        except (ValueError, TypeError, KeyError):
            pass
    return rules, "rules"


# --------------------------------------------------------------------------- product recommendation


def recommend(db: Session, company: Company | None, purpose: str | None, amount: float | None,
              term: int | None, has_collateral: bool, is_bank_client: bool = False) -> list[dict]:
    s = get_settings()
    products = db.scalars(select(Product).where(Product.is_active.is_(True)).order_by(Product.sort_order)).all()
    okved = (company.okved if company else "") or ""
    recs = []
    for p in products:
        fit, why, blockers = 0, [], []
        if purpose and purpose in (p.purposes or []):
            fit += 40
            why.append(f"подходит для цели «{PURPOSE_LABELS.get(purpose, purpose)}»")
        elif purpose:
            fit -= 25
        if amount:
            if p.min_amount <= amount <= p.max_amount:
                fit += 20
            else:
                fit -= 30
                blockers.append(f"сумма {p.min_amount / 1e6:g}–{p.max_amount / 1e6:g} млн ₽")
        if term:
            if p.min_term <= term <= p.max_term:
                fit += 10
            else:
                fit -= 10
                blockers.append(f"срок {p.min_term}–{p.max_term} мес.")
        if p.collateral_required:
            if has_collateral:
                fit += 10
                why.append("есть залог — ставка ниже, лимит выше")
            else:
                fit -= 35
                blockers.append("нужен залог")
        elif not has_collateral:
            fit += 5
            why.append("без залога")
        if p.eligible_okved_prefixes:
            if okved and okved.startswith(tuple(p.eligible_okved_prefixes)):
                fit += 30
                why.append("ваша отрасль входит в программу господдержки")
            else:
                fit -= 50
                blockers.append("только для приоритетных отраслей")
        if p.requires_account:
            if is_bank_client:
                fit += 10
                why.append("лимит считается по оборотам вашего счёта")
            else:
                fit -= 40
                blockers.append("нужен расчётный счёт в банке")
        if p.code == "EXPRESS":
            why.append("решение онлайн за минуты")
        terms = ProductTerms(p.code, p.name, p.min_amount, p.max_amount, p.min_term, p.max_term, p.margin, p.rate_cap)
        rate = rate_for(terms, "A", is_bank_client, s.key_rate)
        a = min(max(amount or p.min_amount, p.min_amount), p.max_amount)
        t = min(max(term or 24, p.min_term), p.max_term)
        recs.append({
            "product_code": p.code, "name": p.name, "tagline": p.tagline, "fit": fit, "reasons": why,
            "limitations": blockers, "rate_from": rate, "example_amount": a, "example_term": t,
            "example_payment": round(annuity_payment(a, rate, t), 2), "decision_time": p.decision_time,
        })
    recs.sort(key=lambda x: -x["fit"])
    return recs


# --------------------------------------------------------------------------- 2. chat


def _kb_lookup(q: str) -> list[dict]:
    ql = q.lower()
    return [k for k in KB if re.search(k["keys"], ql)][:2]


def _app_context(app: Application) -> str:
    st = STATUS_INFO[app.status]
    parts = [f"Заявка {app.number}: {app.product.name}, {app.amount:,.0f} ₽ на {app.term_months} мес. "
             f"Текущий статус — «{st['label']}». {st['client_hint']}".replace(",", " ")]
    if app.status == "INFO_REQUESTED":
        parts.append("Банк просит: " + "; ".join(i["text"] for i in app.info_request.get("items", [])))
    if app.status in ("APPROVED", "COUNTER_OFFER") and app.offer.get("options"):
        o = app.offer["options"][0]
        parts.append(f"Предложение: {o['amount']:,.0f} ₽ на {o['term_months']} мес. под {o['rate']}%, "
                     f"платёж {o['monthly_payment']:,.0f} ₽ в месяц.".replace(",", " "))
    if app.status == "REJECTED":
        parts.append("Причины: " + "; ".join(app.decision.get("reasons", [])))
        if app.decision.get("tips"):
            parts.append("Что можно улучшить: " + "; ".join(app.decision["tips"]))
    return " ".join(parts)


def chat(db: Session, company: Company | None, message: str, app: Application | None) -> dict:
    need_like = re.search(r"нужн|хочу|надо|планир|купить|закуп|взять", message.lower()) and AMOUNT_RE.search(message)
    if need_like:
        parsed, engine = parse_need(message)
        recs = recommend(db, company, parsed["purpose"], parsed["amount"], parsed["term_months"], parsed["has_collateral"])[:3]
        top = recs[0]
        lines = [f"Понял задачу: {PURPOSE_LABELS.get(parsed['purpose'] or '', 'финансирование бизнеса')}"
                 + (f", около {parsed['amount']:,.0f} ₽".replace(",", " ") if parsed["amount"] else "")
                 + (f" на {parsed['term_months']} мес." if parsed["term_months"] else "") + ".",
                 f"Лучше всего подходит «{top['name']}»: {', '.join(top['reasons'][:3]) or top['tagline']}. "
                 f"Ставка от {top['rate_from']}%, примерный платёж {top['example_payment']:,.0f} ₽/мес.".replace(",", " ")]
        return {"answer": "\n".join(lines), "engine": engine, "parsed": parsed, "recommendations": recs,
                "suggestions": [f"Оформить «{top['name']}»", "Какие документы нужны?"]}

    ctx_parts, kb = [], _kb_lookup(message)
    if app:
        ctx_parts.append(_app_context(app))
    ctx_parts += [f"{k['title']}: {k['text']}" for k in kb]
    if not ctx_parts:
        ctx_parts.append("Я помогаю подобрать кредит, объясняю статус заявки, условия и следующие шаги. "
                         "Опишите задачу своими словами, например: «нужно 3 млн на новое оборудование на 2 года».")
    fallback = "\n\n".join(ctx_parts)
    llm_answer = _llm([
        {"role": "system", "content": (
            "Ты — помощник предпринимателя в кредитном кабинете банка. Отвечай по-русски, кратко (до 5 предложений), "
            "простым языком, ТОЛЬКО на основе фактов из контекста. Не обещай одобрения и не придумывай условия. "
            "Если в контексте нет ответа — так и скажи и предложи обратиться в чат поддержки банка.\n\nКонтекст:\n" + fallback)},
        {"role": "user", "content": message},
    ])
    engine = f"llm:{get_settings().llm_model}" if llm_answer else "rules"
    sugg = ["Какие документы нужны?", "Как считается лимит?", "Сколько ждать решения?"]
    return {"answer": llm_answer or fallback, "engine": engine, "suggestions": sugg}


# --------------------------------------------------------------------------- 3. analyst summary


def analyst_summary(app: Application) -> dict:
    sc, e = app.scoring or {}, app.enrichment or {}
    if not sc:
        return {"summary": "Скоринг ещё не выполнен.", "engine": "rules"}
    aff, dec = sc["affordability"], sc["decision"]
    neg = [f for f in sc["factors"] if f["points"] < 0]
    pos = [f for f in sc["factors"] if f["points"] > 0]
    eg = e.get("egrul") or {}
    lines = [
        f"{app.company.name} (ИНН {app.company.inn}), ОКВЭД {app.company.okved}, срок деятельности "
        f"{sc['features']['business_age_months'] // 12} г. Запрос: {app.product.name}, {app.amount:,.0f} ₽ на {app.term_months} мес.".replace(",", " "),
        f"Рейтинг {sc['grade']} ({sc['score']} б., PD {sc['pd'] * 100:.1f}%). Денежный поток {aff['monthly_cash_flow']:,.0f} ₽/мес, "
        f"DSCR по запросу {aff['dscr']} (мин. {aff['dscr_min']}), макс. сумма на срок — {aff['max_amount_for_term']:,.0f} ₽.".replace(",", " "),
        "Сильные стороны: " + (", ".join(f"{f['label'].lower()} ({f['value']})" for f in pos[:3]) or "нет"),
        "Риски: " + (", ".join(f"{f['label'].lower()} ({f['value']})" for f in neg[:3]) or "существенных нет"),
    ]
    if sc.get("manual_triggers"):
        lines.append("Причины ручного рассмотрения: " + "; ".join(m["label"] for m in sc["manual_triggers"]))
    if eg.get("director"):
        lines.append(f"Руководитель по ЕГРЮЛ: {eg['director'].get('name')}.")
    rec = dec.get("recommended_offer")
    if rec:
        lines.append(f"Рекомендация системы: {rec['amount']:,.0f} ₽ на {rec['term_months']} мес. под {rec['rate']}%.".replace(",", " "))
    text = "\n".join(lines)
    polished = _llm([
        {"role": "system", "content": "Сократи заметку андеррайтера до 4–5 пунктов, сохрани все цифры, ничего не добавляй."},
        {"role": "user", "content": text},
    ])
    return {"summary": polished or text, "engine": f"llm:{get_settings().llm_model}" if polished else "rules", "facts": lines}
