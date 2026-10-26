"""Модель принятия кредитного решения.

Архитектура намеренно разделяет три слоя (как в кейсе: «скоринг ≠ кредитное решение»):

1. Политика (стоп-факторы и триггеры ручного рассмотрения) — формальные правила банка.
2. Скоринг (балльная карта) — оценка риска ЗАЁМЩИКА, не зависящая от суммы заявки:
   score → рейтинг A..E → вероятность дефолта (PD).
3. Кредитная логика — по рейтингу, продукту и денежному потоку считает ставку, лимит
   (через допустимую долговую нагрузку, DSCR) и выбирает исход:
   APPROVE / COUNTER_OFFER / MANUAL_REVIEW / REJECT.

Все параметры — в одном модуле и версионируются (MODEL_VERSION сохраняется в каждой заявке),
чтобы решение можно было воспроизвести и объяснить при аудите.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

from .finance import annuity_payment, max_principal, round_down

MODEL_VERSION = "SME-SCORECARD-1.3"
BASE_SCORE = 520
DSCR_MIN = 1.3  # платежи по всем кредитам не должны превышать денежный поток / 1.3
UNSECURED_REVENUE_CAP = 0.5  # беззалоговый лимит — не более 50% годовой выручки
OVERDRAFT_TURNOVER_CAP = 0.4  # овердрафт — не более 40% среднемесячных поступлений

GRADES = [(600, "A"), (550, "B"), (500, "C"), (450, "D"), (-10_000, "E")]
GRADE_PREMIUM = {"A": 0.0, "B": 1.5, "C": 3.0, "D": 5.0, "E": 8.0}
CLIENT_DISCOUNT = 0.5

LOW_RISK_OKVED = ("01", "02", "03", "62", "63", "72", "85", "86") + tuple(str(i) for i in range(10, 34))
HIGH_RISK_OKVED = ("41", "42", "43", "64", "66", "68", "92")
PRIORITY_OKVED = LOW_RISK_OKVED + ("49", "52", "55")  # приоритетные отрасли льготной программы


@dataclass
class Features:
    business_age_months: int
    revenue_annual: float
    expenses_annual: float
    existing_monthly_payments: float
    okved: str
    company_status: str = "ACTIVE"
    bki_score: int | None = None
    max_overdue_days_12m: int = 0
    current_overdue_days: int = 0
    inquiries_30d: int = 0
    tax_arrears: float = 0.0
    is_bank_client: bool = False
    account_months: int = 0
    avg_turnover_in: float = 0.0
    disqualified_director: bool = False
    mass_address: bool = False
    unreliable_info: bool = False
    antifraud_level: str = "LOW"
    collateral_value: float = 0.0
    has_guarantee: bool = False
    revenue_verified: bool = True
    sources_unavailable: list[str] = field(default_factory=list)


@dataclass
class ProductTerms:
    code: str
    name: str
    min_amount: float
    max_amount: float
    min_term: int
    max_term: int
    margin: float
    rate_cap: float | None = None
    collateral_required: bool = False
    requires_account: bool = False
    eligible_okved_prefixes: list[str] = field(default_factory=list)


@dataclass
class Factor:
    code: str
    label: str
    value: str
    points: int
    hint: str = ""


# --------------------------------------------------------------------------- helpers


def sector_risk(okved: str) -> str:
    if okved.startswith(HIGH_RISK_OKVED):
        return "HIGH"
    if okved.startswith(LOW_RISK_OKVED):
        return "LOW"
    return "MEDIUM"


def grade_for(score: int) -> str:
    for threshold, g in GRADES:
        if score >= threshold:
            return g
    return "E"


def pd_for(score: int) -> float:
    """Калибровка балла в вероятность дефолта на горизонте 12 мес. (синтетическая)."""
    return round(1 / (1 + math.exp((score - 470) / 38)), 4)


def rate_for(product: ProductTerms, grade: str, is_bank_client: bool, key_rate: float) -> float:
    rate = key_rate + product.margin + GRADE_PREMIUM[grade] - (CLIENT_DISCOUNT if is_bank_client else 0)
    if product.rate_cap is not None:
        rate = min(rate, product.rate_cap)
    return round(rate, 2)


def monthly_cash_flow(f: Features) -> float:
    return (f.revenue_annual - f.expenses_annual) / 12


def product_eligibility(product: ProductTerms, f: Features) -> list[str]:
    problems = []
    if product.requires_account and not f.is_bank_client:
        problems.append("Продукт доступен только клиентам с расчётным счётом в банке")
    if product.eligible_okved_prefixes and not f.okved.startswith(tuple(product.eligible_okved_prefixes)):
        problems.append("Вид деятельности (ОКВЭД) не входит в перечень приоритетных отраслей программы")
    if product.collateral_required and f.collateral_value <= 0:
        problems.append("Для продукта требуется залог")
    return problems


# --------------------------------------------------------------------------- 1. policy


def policy_checks(f: Features) -> tuple[list[dict], list[dict]]:
    stops: list[dict] = []
    manual: list[dict] = []
    if f.company_status != "ACTIVE":
        stops.append({"code": "SF01", "label": f"Статус компании в ЕГРЮЛ: {f.company_status}"})
    if f.disqualified_director:
        stops.append({"code": "SF02", "label": "Руководитель находится в реестре дисквалифицированных лиц"})
    if f.current_overdue_days > 30 or f.max_overdue_days_12m > 90:
        stops.append({"code": "SF03", "label": "Существенная просроченная задолженность по данным БКИ"})
    if f.antifraud_level == "HIGH":
        stops.append({"code": "SF04", "label": "Высокий риск мошенничества по данным антифрод-проверки"})
    if f.business_age_months < 3:
        stops.append({"code": "SF05", "label": "Срок деятельности бизнеса менее 3 месяцев"})
    if f.tax_arrears > 500_000:
        stops.append({"code": "SF06", "label": "Задолженность по налогам более 500 тыс. ₽"})
    if monthly_cash_flow(f) <= 0:
        stops.append({"code": "SF07", "label": "Отрицательный денежный поток бизнеса"})

    if f.mass_address or f.unreliable_info:
        manual.append({"code": "MT01", "label": "Отметки ФНС: адрес массовой регистрации / недостоверные сведения"})
    if f.antifraud_level == "MEDIUM":
        manual.append({"code": "MT02", "label": "Средний риск по антифрод-проверке"})
    for src in f.sources_unavailable:
        manual.append({"code": "MT03", "label": f"Источник данных недоступен: {src}"})
    if not f.revenue_verified:
        manual.append({"code": "MT04", "label": "Выручка не подтверждена внешними данными"})
    return stops, manual


# --------------------------------------------------------------------------- 2. scorecard


def scorecard(f: Features) -> tuple[int, list[Factor]]:
    factors: list[Factor] = []

    def add(code, label, value, points, hint=""):
        factors.append(Factor(code, label, value, points, hint))

    m = f.business_age_months
    pts = -60 if m < 6 else -30 if m < 12 else 0 if m < 24 else 25 if m < 60 else 40
    add("AGE", "Срок деятельности", f"{m // 12} г. {m % 12} мес.", pts,
        "Срок работы бизнеса больше 2 лет повышает оценку")

    margin = (f.revenue_annual - f.expenses_annual) / f.revenue_annual if f.revenue_annual > 0 else -1
    pts = -60 if margin < 0 else -15 if margin < 0.05 else 15 if margin < 0.15 else 30
    add("MARGIN", "Рентабельность", f"{margin * 100:.1f}%", pts, "Устойчивая рентабельность выше 15% повышает оценку")

    cf = monthly_cash_flow(f)
    load = f.existing_monthly_payments / cf if cf > 0 else 99
    pts = 20 if f.existing_monthly_payments == 0 else 10 if load < 0.3 else -15 if load < 0.6 else -50
    add("DEBT_LOAD", "Текущая долговая нагрузка", f"{min(load, 9.99) * 100:.0f}% денежного потока", pts,
        "Снижение текущих платежей по кредитам освобождает лимит")

    if f.bki_score is None:
        add("BKI_SCORE", "Кредитная история", "нет истории", -5, "Положительная кредитная история повышает оценку")
    else:
        s = f.bki_score
        pts = -50 if s < 500 else -10 if s < 650 else 20 if s < 750 else 40
        add("BKI_SCORE", "Скоринговый балл БКИ", str(s), pts, "Своевременные платежи улучшают балл БКИ")

    d = f.max_overdue_days_12m
    pts = 20 if d == 0 else -20 if d <= 30 else -60 if d <= 60 else -100
    add("OVERDUE", "Просрочки за 12 мес.", "нет" if d == 0 else f"до {d} дн.", pts,
        "Отсутствие просрочек в течение 12 месяцев заметно улучшит решение")

    if f.inquiries_30d > 4:
        add("INQUIRIES", "Запросы в БКИ за 30 дней", str(f.inquiries_30d), -20,
            "Много заявок в разные банки за короткий срок снижает оценку")

    if f.tax_arrears > 0:
        add("TAX", "Задолженность по налогам", f"{f.tax_arrears:,.0f} ₽".replace(",", " "), -40,
            "Погасите задолженность по налогам перед подачей заявки")

    if f.is_bank_client:
        pts = 25 if f.account_months >= 12 else 10
        add("RELATIONSHIP", "Клиент банка", f"{f.account_months} мес., обороты подтверждены", pts)
    else:
        add("RELATIONSHIP", "Клиент банка", "нет счёта", 0, "Обороты по счёту в банке позволяют подтвердить выручку")

    risk = sector_risk(f.okved)
    pts = {"LOW": 10, "MEDIUM": 0, "HIGH": -20}[risk]
    add("SECTOR", "Отраслевой риск", {"LOW": "низкий", "MEDIUM": "средний", "HIGH": "повышенный"}[risk], pts)

    if f.collateral_value > 0 or f.has_guarantee:
        pts = 20 if f.collateral_value > 0 else 10
        add("SECURITY", "Обеспечение", "залог" if f.collateral_value > 0 else "поручительство собственника", pts)

    score = BASE_SCORE + sum(x.points for x in factors)
    return score, factors


# --------------------------------------------------------------------------- 3. credit logic


def max_amount_for(product: ProductTerms, f: Features, rate: float, term: int) -> float:
    cf = monthly_cash_flow(f)
    max_payment = cf / DSCR_MIN - f.existing_monthly_payments
    limit = max_principal(max_payment, rate, term)
    if f.collateral_value > 0:
        limit = min(limit, f.collateral_value * 0.7 + f.revenue_annual * 0.2)
    else:
        limit = min(limit, f.revenue_annual * UNSECURED_REVENUE_CAP)
    if product.requires_account:
        limit = min(limit, f.avg_turnover_in * OVERDRAFT_TURNOVER_CAP)
    limit = min(limit, product.max_amount)
    return max(round_down(limit), 0.0)


def _offer(product: ProductTerms, amount: float, term: int, rate: float, kind: str, note: str) -> dict:
    pay = annuity_payment(amount, rate, term)
    return {
        "kind": kind,
        "product_code": product.code,
        "product_name": product.name,
        "amount": amount,
        "term_months": term,
        "rate": rate,
        "monthly_payment": round(pay, 2),
        "total_payment": round(pay * term, 2),
        "overpayment": round(pay * term - amount, 2),
        "note": note,
    }


def decide(
    f: Features,
    product: ProductTerms,
    amount: float,
    term: int,
    key_rate: float,
    auto_limit: float,
    alt_products: list[ProductTerms] | None = None,
) -> dict:
    stops, manual = policy_checks(f)
    score, factors = scorecard(f)
    grade = grade_for(score)
    rate = rate_for(product, grade, f.is_bank_client, key_rate)
    cf = monthly_cash_flow(f)
    max_payment = cf / DSCR_MIN - f.existing_monthly_payments
    req_payment = annuity_payment(amount, rate, term)
    dscr = cf / (f.existing_monthly_payments + req_payment) if (f.existing_monthly_payments + req_payment) > 0 else 0
    max_amount = max_amount_for(product, f, rate, term)

    eligibility = product_eligibility(product, f)
    if product.collateral_required and f.collateral_value > 0:
        manual.append({"code": "MT05", "label": "Требуется оценка и проверка залога специалистом"})
    if amount > auto_limit:
        manual.append({"code": "MT06", "label": f"Сумма превышает лимит автоматического решения ({auto_limit:,.0f} ₽)".replace(",", " ")})
    if grade in ("C", "D"):
        manual.append({"code": "MT07", "label": f"Пограничный рейтинг {grade}: нужна экспертная оценка"})

    result = {
        "model_version": MODEL_VERSION,
        "score": score,
        "grade": grade,
        "pd": pd_for(score),
        "factors": [asdict(x) for x in factors],
        "stop_factors": stops,
        "manual_triggers": manual,
        "eligibility_issues": eligibility,
        "affordability": {
            "monthly_cash_flow": round(cf, 2),
            "existing_payments": round(f.existing_monthly_payments, 2),
            "max_payment": round(max(max_payment, 0), 2),
            "requested_payment": round(req_payment, 2),
            "dscr": round(dscr, 2),
            "dscr_min": DSCR_MIN,
            "rate": rate,
            "max_amount_for_term": max_amount,
        },
    }

    def build_alternatives() -> list[dict]:
        alts: list[dict] = []
        if max_amount >= product.min_amount:
            alts.append(_offer(product, max_amount, term, rate, "REDUCED_AMOUNT",
                               "Меньшая сумма на тот же срок — платёж укладывается в денежный поток"))
        for t in range(term + 6, product.max_term + 1, 6):
            if amount <= max_amount_for(product, f, rate, t):
                alts.append(_offer(product, amount, t, rate, "LONGER_TERM",
                                   "Та же сумма на более длинный срок — ниже ежемесячный платёж"))
                break
        for alt in alt_products or []:
            if alt.code == product.code or product_eligibility(alt, f):
                continue
            alt_rate = rate_for(alt, grade, f.is_bank_client, key_rate)
            alt_term = min(max(term, alt.min_term), alt.max_term)
            alt_amount = min(amount, max_amount_for(alt, f, alt_rate, alt_term))
            if alt_amount >= alt.min_amount and alt_rate < rate:
                why = "льготная ставка по программе поддержки МСП" if alt.eligible_okved_prefixes else f"ставка ниже на {rate - alt_rate:.2f} п.п."
                alts.append(_offer(alt, alt_amount, alt_term, alt_rate, "OTHER_PRODUCT", f"{alt.name}: {why}"))
                break
        return alts[:3]

    # ---- выбор исхода
    if stops:
        outcome, reasons = "REJECT", [s["label"] for s in stops]
        alternatives: list[dict] = []
    elif grade == "E":
        outcome, reasons, alternatives = "REJECT", ["Уровень кредитного риска выше допустимого по политике банка"], []
    elif eligibility:
        outcome, reasons, alternatives = "REJECT", eligibility, build_alternatives()
        if alternatives:
            outcome = "COUNTER_OFFER"
    elif amount <= max_amount and amount >= product.min_amount:
        outcome = "MANUAL_REVIEW" if manual else "APPROVE"
        reasons = [m["label"] for m in manual] or ["Заявка соответствует кредитной политике"]
        alternatives = []
    else:
        alternatives = build_alternatives()
        if not alternatives:
            outcome, reasons = "REJECT", ["Денежного потока бизнеса недостаточно для обслуживания кредита"]
        else:
            outcome = "MANUAL_REVIEW" if manual else "COUNTER_OFFER"
            reasons = [m["label"] for m in manual] or [
                f"Платёж по запрошенной сумме ({req_payment:,.0f} ₽) превышает допустимый ({max(max_payment, 0):,.0f} ₽)".replace(",", " ")
            ]

    recommended = None
    if outcome in ("APPROVE", "MANUAL_REVIEW") and amount <= max_amount:
        recommended = _offer(product, amount, term, rate, "FULL", "Запрошенные условия")
    elif alternatives:
        recommended = alternatives[0]

    result["decision"] = {
        "outcome": outcome,
        "reasons": reasons,
        "recommended_offer": recommended,
        "alternatives": alternatives,
        "improvement_tips": [x.hint for x in sorted(factors, key=lambda z: z.points) if x.points < 0 and x.hint][:3],
    }
    return result
