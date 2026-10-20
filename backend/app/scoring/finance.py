"""Финансовая математика: аннуитет, обратный расчёт лимита, график платежей."""
from datetime import date

from dateutil.relativedelta import relativedelta


def annuity_payment(principal: float, annual_rate_pct: float, months: int) -> float:
    if months <= 0:
        return 0.0
    r = annual_rate_pct / 100 / 12
    if r == 0:
        return principal / months
    return principal * r / (1 - (1 + r) ** -months)


def max_principal(monthly_payment: float, annual_rate_pct: float, months: int) -> float:
    """Максимальная сумма кредита при заданном допустимом платеже."""
    if monthly_payment <= 0 or months <= 0:
        return 0.0
    r = annual_rate_pct / 100 / 12
    if r == 0:
        return monthly_payment * months
    return monthly_payment * (1 - (1 + r) ** -months) / r


def schedule(principal: float, annual_rate_pct: float, months: int, start: date) -> list[dict]:
    r = annual_rate_pct / 100 / 12
    pay = annuity_payment(principal, annual_rate_pct, months)
    balance = principal
    rows = []
    for i in range(1, months + 1):
        interest = balance * r
        body = pay - interest
        if i == months:
            body = balance
            pay = body + interest
        balance -= body
        rows.append(
            {
                "n": i,
                "date": (start + relativedelta(months=i)).isoformat(),
                "payment": round(pay, 2),
                "principal": round(body, 2),
                "interest": round(interest, 2),
                "balance": round(max(balance, 0), 2),
            }
        )
    return rows


def round_down(amount: float, step: float = 50_000) -> float:
    return float(int(amount // step) * step)
