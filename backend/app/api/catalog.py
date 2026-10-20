"""Каталог продуктов, подбор, калькулятор, профиль компании и предзаполнение."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import Product, User
from ..schemas import CalcIn, CompanyOut, ProductOut, RecommendIn
from ..scoring.engine import ProductTerms, rate_for
from ..scoring.finance import annuity_payment
from ..security import current_user, require_client
from ..services import assistant, integrations
from ..services.integrations import SourceUnavailable

router = APIRouter(tags=["Products & Company"])


def _with_rate(p: Product, is_client: bool = False) -> ProductOut:
    out = ProductOut.model_validate(p)
    terms = ProductTerms(p.code, p.name, p.min_amount, p.max_amount, p.min_term, p.max_term, p.margin, p.rate_cap)
    out.rate_from = rate_for(terms, "A", is_client, get_settings().key_rate)
    return out


@router.get("/products", response_model=list[ProductOut], summary="Каталог кредитных продуктов")
def list_products(db: Session = Depends(get_db)):
    return [_with_rate(p) for p in db.scalars(select(Product).where(Product.is_active.is_(True)).order_by(Product.sort_order))]


@router.get("/products/{code}", response_model=ProductOut, summary="Карточка продукта")
def get_product(code: str, db: Session = Depends(get_db)):
    p = db.get(Product, code)
    if not p:
        raise HTTPException(404, "Продукт не найден")
    return _with_rate(p)


@router.post("/products/recommend", summary="Подбор продукта под потребность (анкета и/или свободный текст)")
def recommend(body: RecommendIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    purpose, amount, term, collateral, engine, parsed = body.purpose, body.amount, body.term_months, body.has_collateral, "rules", None
    if body.text:
        parsed, engine = assistant.parse_need(body.text)
        purpose = purpose or parsed["purpose"]
        amount = amount or parsed["amount"]
        term = term or parsed["term_months"]
        collateral = collateral or parsed["has_collateral"]
    is_client = False
    if user.company:
        try:
            is_client = bool(integrations.internal_accounts(user.company.inn).get("is_client"))
        except SourceUnavailable:
            pass
    recs = assistant.recommend(db, user.company, purpose, amount, term, collateral, is_client)
    return {"engine": engine, "parsed": parsed,
            "request": {"purpose": purpose, "amount": amount, "term_months": term, "has_collateral": collateral},
            "recommendations": recs}


@router.post("/products/calculate", summary="Кредитный калькулятор (ориентировочный платёж)")
def calculate(body: CalcIn, db: Session = Depends(get_db)):
    p = db.get(Product, body.product_code)
    if not p:
        raise HTTPException(404, "Продукт не найден")
    terms = ProductTerms(p.code, p.name, p.min_amount, p.max_amount, p.min_term, p.max_term, p.margin, p.rate_cap)
    rate = rate_for(terms, "A", False, get_settings().key_rate)
    pay = annuity_payment(body.amount, rate, body.term_months)
    warnings = []
    if not p.min_amount <= body.amount <= p.max_amount:
        warnings.append(f"Сумма для продукта: {p.min_amount:,.0f}–{p.max_amount:,.0f} ₽".replace(",", " "))
    if not p.min_term <= body.term_months <= p.max_term:
        warnings.append(f"Срок для продукта: {p.min_term}–{p.max_term} мес.")
    return {"rate_from": rate, "monthly_payment": round(pay, 2), "total_payment": round(pay * body.term_months, 2),
            "overpayment": round(pay * body.term_months - body.amount, 2), "warnings": warnings,
            "note": "Расчёт ориентировочный: итоговая ставка зависит от оценки заявки"}


@router.get("/companies/me", response_model=CompanyOut, summary="Профиль компании пользователя")
def my_company(user: User = Depends(require_client)):
    return CompanyOut.model_validate(user.company)


@router.get("/companies/me/prefill", summary="Предзаполнение заявки из ЕГРЮЛ, ФНС и данных банка")
def prefill(user: User = Depends(require_client)):
    """Сокращает повторный ввод: клиент только подтверждает данные, которые банк уже может получить сам."""
    inn = user.company.inn
    out: dict = {"sources": [], "unavailable": []}
    for key, fn in (("egrul", integrations.egrul), ("fns", integrations.fns_transparent), ("accounts", integrations.internal_accounts)):
        try:
            out[key] = fn(inn)
            out["sources"].append(key)
        except SourceUnavailable as e:
            out[key] = None
            out["unavailable"].append(e.source)
    fns = out.get("fns") or {}
    out["financials"] = {
        "revenue_last_year": fns.get("revenue_last_year"),
        "expenses_last_year": fns.get("expenses_last_year"),
        "employees": fns.get("avg_employees"),
        "source": "ФНС «Прозрачный бизнес», отчётность за " + str(fns.get("year", "")) if fns else None,
    }
    return out
