"""Обработка загружаемых документов.

Выписка по счёту в CSV распознаётся автоматически: из неё считаются поступления по месяцам,
и это значение используется как подтверждённая выручка при скоринге (вместо ручного ввода).
"""
import csv
import io
from collections import defaultdict
from datetime import date

ALLOWED_TYPES = {
    "application/pdf", "image/png", "image/jpeg", "text/csv", "application/vnd.ms-excel",
    "text/plain", "application/octet-stream",
}
ALLOWED_EXT = (".pdf", ".png", ".jpg", ".jpeg", ".csv", ".txt")
DOC_TYPES = {"FIN_STATEMENTS", "BANK_STATEMENT", "COLLATERAL_DOCS", "OTHER"}


def _parse_date(s: str) -> date | None:
    s = s.strip()
    for fmt in ("%Y-%m-%d", "%d.%m.%Y"):
        try:
            from datetime import datetime

            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _parse_amount(s: str) -> float | None:
    try:
        return float(s.replace(" ", "").replace(" ", "").replace(",", "."))
    except ValueError:
        return None


def parse_bank_statement(content: bytes) -> dict:
    """Ожидаемый формат: date;amount;description (разделитель ; или ,). Положительные суммы — поступления."""
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = content.decode("cp1251", errors="replace")
    sample = text[:2000]
    delim = ";" if sample.count(";") >= sample.count(",") else ","
    reader = csv.reader(io.StringIO(text), delimiter=delim)
    inflow: dict[str, float] = defaultdict(float)
    outflow: dict[str, float] = defaultdict(float)
    rows = 0
    for rec in reader:
        if len(rec) < 2:
            continue
        d, a = _parse_date(rec[0]), _parse_amount(rec[1])
        if d is None or a is None:
            continue  # заголовок или мусор
        rows += 1
        key = f"{d.year}-{d.month:02d}"
        if a >= 0:
            inflow[key] += a
        else:
            outflow[key] += -a
    months = sorted(set(inflow) | set(outflow))
    if rows == 0 or not months:
        return {"ok": False, "error": "Не удалось распознать операции. Ожидается CSV: дата;сумма;назначение"}
    avg_in = sum(inflow.values()) / len(months)
    avg_out = sum(outflow.values()) / len(months)
    return {
        "ok": True,
        "operations": rows,
        "months": len(months),
        "period": f"{months[0]} — {months[-1]}",
        "avg_monthly_inflow": round(avg_in, 2),
        "avg_monthly_outflow": round(avg_out, 2),
        "annualized_inflow": round(avg_in * 12, 2),
        "by_month": [{"month": m, "inflow": round(inflow[m], 2), "outflow": round(outflow[m], 2)} for m in months],
    }
