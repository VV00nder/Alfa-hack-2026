"""Персонализированная новостная лента предпринимателя.

Прозрачное (объяснимое) ранжирование на правилах: каждая новость размечена тегами таргетинга,
лента считает релевантность по профилю компании (ОКВЭД, регион, сегмент, форма), этапу её заявок
и реакциям пользователя. Для каждой карточки возвращается «почему вы это видите».
"""
from __future__ import annotations

from collections import Counter
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Application, Company, NewsInteraction, NewsItem, Product
from ..state_machine import STATUS_INFO

SEGMENT_LABEL = {"micro": "микробизнеса", "small": "малого бизнеса", "medium": "среднего бизнеса"}
CATEGORY_LABEL = {
    "MARKET": "Рынок и ставки", "SUPPORT": "Господдержка", "TAX": "Налоги и отчётность",
    "PRODUCT": "Продукты банка", "EDUCATION": "Финграмотность", "INDUSTRY": "Отраслевые новости",
}


def rank_feed(db: Session, company: Company, user_id: str | None = None, limit: int = 20) -> list[dict]:
    items = db.scalars(select(NewsItem).where(NewsItem.is_active.is_(True))).all()
    apps = db.scalars(select(Application).where(Application.company_id == company.id)).all()
    statuses = {a.status for a in apps}
    products = {a.product_code for a in apps}
    product_names = {p.code: p.name for p in db.scalars(select(Product)).all()}

    hidden: set[str] = set()
    cat_clicks: Counter = Counter()
    if user_id:
        rows = db.execute(
            select(NewsInteraction.news_id, NewsInteraction.action, NewsItem.category)
            .join(NewsItem, NewsItem.id == NewsInteraction.news_id)
            .where(NewsInteraction.user_id == user_id)
        ).all()
        for news_id, action, cat in rows:
            if action == "HIDE":
                hidden.add(news_id)
            elif action in ("CLICK", "LIKE"):
                cat_clicks[cat] += 1

    now = datetime.now(UTC)
    okved = company.okved or ""
    result = []
    for n in items:
        if n.id in hidden:
            continue
        t = n.tags or {}
        score = float(n.priority)
        reasons: list[str] = []

        if t.get("okved"):
            if not any(okved.startswith(p) for p in t["okved"]):
                continue
            score += 40
            reasons.append(f"Ваш вид деятельности: {okved} {company.okved_name or ''}".strip())
        if t.get("legal_forms"):
            if company.legal_form not in t["legal_forms"]:
                continue
            score += 10
            reasons.append("Актуально для " + ("индивидуальных предпринимателей" if company.legal_form == "IP" else "юрлиц"))
        if t.get("regions"):
            if company.region not in t["regions"]:
                continue
            score += 20
            reasons.append(f"Ваш регион: {company.region}")
        if t.get("segments"):
            if company.segment not in t["segments"]:
                continue
            score += 10
            reasons.append(f"Для {SEGMENT_LABEL.get(company.segment, company.segment)}")
        if t.get("statuses"):
            hit = statuses & set(t["statuses"])
            if not hit:
                continue
            score += 45
            st = sorted(hit)[0]
            reasons.append(f"Связано с вашей заявкой (этап «{STATUS_INFO[st]['label']}»)")
        if t.get("products"):
            hit = products & set(t["products"])
            if hit:
                score += 25
                reasons.append(f"Вы интересовались продуктом «{product_names.get(sorted(hit)[0], '')}»")

        if cat_clicks.get(n.category):
            score += min(15, 5 * cat_clicks[n.category])
            reasons.append(f"Вы читаете раздел «{CATEGORY_LABEL.get(n.category, n.category)}»")

        pub = n.published_at if n.published_at.tzinfo else n.published_at.replace(tzinfo=UTC)
        age_days = max(0, (now - pub).days)
        score += max(0, 20 - age_days)
        if not reasons:
            reasons.append("Важно для всех предпринимателей")

        result.append({"item": n, "relevance": round(score, 1), "reasons": reasons})

    result.sort(key=lambda x: (-x["relevance"], -x["item"].published_at.timestamp()))
    return result[:limit]
