"""Симулятор внешних систем для автономной проверки решения.

Смоделированы (контракты упрощены с сохранением смысла интеграции):
  * ЕГРЮЛ/ЕГРИП           GET  /egrul/v1/companies/{inn}
  * ФНС «Прозрачный бизнес» GET /fns/v1/transparent-business/{inn}
  * Бюро кредитных историй POST /bki/v1/reports
  * Антифрод               POST /antifraud/v1/check
  * АБС банка (счета)      GET  /abs/v1/accounts/{inn}
  * АБС банка (выдача)     POST /abs/v1/loans

Для ИНН из fixtures.json возвращаются заранее подготовленные профили (демо-сценарии).
Для любого другого корректного ИНН профиль генерируется детерминированно из хэша ИНН,
поэтому эксперт может проверить решение на произвольной «компании».

Управление сбоями (демонстрация отказоустойчивости): POST /admin/chaos {"source": "bki", "failure_rate": 1.0}
"""
import asyncio
import hashlib
import json
import os
import random
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

FIXTURES = {k: v for k, v in json.loads((Path(__file__).parent / "fixtures.json").read_text(encoding="utf-8")).items()
            if not k.startswith("_")}
LATENCY_MS = int(os.getenv("MOCK_LATENCY_MS", "150"))
CHAOS: dict[str, float] = {"default": float(os.getenv("MOCK_FAILURE_RATE", "0"))}

app = FastAPI(title="CreditFlow External Systems Simulator", version="1.0.0",
              description="Моки ЕГРЮЛ, ФНС, БКИ, антифрода и АБС. Все данные синтетические.")

OKVEDS = [
    ("10.71", "Производство хлеба и мучных кондитерских изделий"), ("25.62", "Обработка металлических изделий"),
    ("47.11", "Торговля розничная в неспециализированных магазинах"), ("49.41", "Деятельность автомобильного грузового транспорта"),
    ("56.10", "Деятельность ресторанов и услуги по доставке продуктов питания"), ("62.01", "Разработка компьютерного программного обеспечения"),
    ("41.20", "Строительство жилых и нежилых зданий"), ("68.20", "Аренда и управление недвижимым имуществом"),
    ("86.23", "Стоматологическая практика"), ("01.13", "Выращивание овощей"), ("96.02", "Услуги парикмахерских и салонов красоты"),
]
REGIONS = ["г. Москва", "г. Санкт-Петербург", "Республика Татарстан", "Новосибирская область", "Свердловская область",
           "Краснодарский край", "Нижегородская область", "Самарская область"]
SURNAMES = ["Иванов", "Смирнов", "Кузнецов", "Попов", "Васильев", "Петров", "Соколов", "Михайлов", "Новиков", "Фёдоров"]
NAMES = ["Алексей", "Дмитрий", "Сергей", "Андрей", "Ольга", "Наталья", "Елена", "Игорь", "Марина", "Павел"]


def _rng(inn: str) -> random.Random:
    return random.Random(int(hashlib.sha256(inn.encode()).hexdigest(), 16))


def _valid_inn(inn: str) -> bool:
    def chk(d, c):
        return sum(int(a) * b for a, b in zip(d, c)) % 11 % 10
    if not inn.isdigit():
        return False
    if len(inn) == 10:
        return chk(inn[:9], [2, 4, 10, 3, 5, 9, 4, 6, 8]) == int(inn[9])
    if len(inn) == 12:
        return (chk(inn[:10], [7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) == int(inn[10])
                and chk(inn[:11], [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) == int(inn[11]))
    return False


def generated_profile(inn: str) -> dict:
    r = _rng(inn)
    ip = len(inn) == 12
    okved = r.choice(OKVEDS)
    reg = date.today() - timedelta(days=r.randint(60, 15 * 365))
    revenue = round(r.uniform(3, 300) * 1e6, -4)
    margin = r.uniform(-0.02, 0.25)
    person = f"{r.choice(SURNAMES)} {r.choice(NAMES)}"
    name = f"ИП {person}" if ip else f"ООО «Компания {inn[-4:]}»"
    overdue = r.choices([0, 0, 0, 0, 15, 40, 120], k=1)[0]
    loans = [{"lender": "Банк-партнёр", "type": "Кредит", "amount": round(revenue * 0.1, -3),
              "balance": round(revenue * 0.05, -3), "monthly_payment": round(revenue * 0.004, -3), "overdue_days": 0}
             for _ in range(r.randint(0, 2))]
    status = "LIQUIDATING" if int(inn[-3:]) % 25 == 0 else "ACTIVE"
    employees = r.randint(1, 120)
    seg = "micro" if employees <= 15 else "small" if employees <= 100 else "medium"
    is_client = r.random() < 0.4
    return {
        "egrul": {"ogrn": ("3" if ip else "1") + inn[:12].ljust(14, "0")[:14 if ip else 12], "kpp": None if ip else inn[:4] + "01001",
                  "full_name": name.upper() if not ip else f"Индивидуальный предприниматель {person}", "short_name": name,
                  "legal_form": "IP" if ip else "OOO", "status": status, "registration_date": reg.isoformat(),
                  "region": r.choice(REGIONS), "address": "адрес синтетический", "okved_main": {"code": okved[0], "name": okved[1]},
                  "okved_additional": [], "director": {"name": person, "position": "Индивидуальный предприниматель" if ip else "Генеральный директор"},
                  "founders": [] if ip else [{"name": person, "share": 100}], "authorized_capital": None if ip else 10000,
                  "msp_category": seg, "employees": employees},
        "fns": {"year": date.today().year - 1, "revenue_last_year": revenue, "expenses_last_year": round(revenue * (1 - margin), -3),
                "taxes_paid": round(revenue * 0.04, -3), "tax_arrears": r.choice([0, 0, 0, 0, 0, 80_000, 900_000]),
                "avg_employees": employees, "tax_regime": r.choice(["УСН «доходы»", "УСН «доходы минус расходы»", "ОСН"]),
                "flags": {"mass_address": r.random() < 0.08, "unreliable_info": r.random() < 0.05, "disqualified_director": r.random() < 0.03}},
        "bki": {"score": r.randint(450, 850), "max_overdue_days_12m": overdue, "current_overdue_days": 0 if overdue < 100 else 35,
                "inquiries_30d": r.randint(0, 7), "closed_loans": r.randint(0, 6), "active_loans": loans},
        "accounts": {"is_client": is_client, "account_months": r.randint(3, 60) if is_client else 0,
                     "avg_monthly_inflow": round(revenue / 12 * r.uniform(0.6, 0.95), -3) if is_client else 0,
                     "avg_monthly_outflow": round(revenue / 12 * r.uniform(0.5, 0.9), -3) if is_client else 0,
                     "avg_balance": round(revenue / 50, -3) if is_client else 0,
                     "account_number": "40702810" + inn[-10:].rjust(12, "0") if is_client else None},
        "antifraud": {"risk_level": r.choices(["LOW", "MEDIUM", "HIGH"], weights=[90, 8, 2])[0], "reasons": []},
    }


def profile(inn: str) -> dict:
    if not _valid_inn(inn):
        raise HTTPException(422, "Некорректный ИНН")
    return FIXTURES.get(inn) or generated_profile(inn)


@app.middleware("http")
async def chaos(request: Request, call_next):
    path = request.url.path
    if not path.startswith(("/health", "/admin", "/docs", "/openapi")):
        source = path.strip("/").split("/")[0]
        await asyncio.sleep(LATENCY_MS / 1000 * random.uniform(0.5, 1.5))
        rate = CHAOS.get(source, CHAOS["default"])
        if random.random() < rate:
            from fastapi.responses import JSONResponse

            return JSONResponse(status_code=503, content={"detail": f"{source} temporarily unavailable (chaos)"})
    return await call_next(request)


@app.get("/health")
def health():
    return {"status": "ok", "fixtures": len(FIXTURES), "chaos": CHAOS}


class ChaosIn(BaseModel):
    source: str = "default"
    failure_rate: float = 0.0


@app.post("/admin/chaos", summary="Включить имитацию сбоев источника (egrul, fns, bki, antifraud, abs, default)")
def set_chaos(body: ChaosIn):
    CHAOS[body.source] = max(0.0, min(1.0, body.failure_rate))
    return CHAOS


@app.get("/egrul/v1/companies/{inn}", summary="Выписка ЕГРЮЛ/ЕГРИП")
def egrul(inn: str):
    return {"inn": inn, **profile(inn)["egrul"]}


@app.get("/fns/v1/transparent-business/{inn}", summary="ФНС «Прозрачный бизнес»: финансы, налоги, отметки")
def fns(inn: str):
    return {"inn": inn, **profile(inn)["fns"]}


class BkiIn(BaseModel):
    inn: str
    consent_id: str


@app.post("/bki/v1/reports", summary="Кредитный отчёт БКИ (требует идентификатор согласия)")
def bki(body: BkiIn):
    if not body.consent_id:
        raise HTTPException(403, "Нет согласия субъекта кредитной истории")
    return {"inn": body.inn, "report_id": uuid.uuid4().hex, "generated_at": datetime.now(timezone.utc).isoformat(),
            **profile(body.inn)["bki"]}


class AntifraudIn(BaseModel):
    inn: str
    amount: float
    channel: str = "web"


@app.post("/antifraud/v1/check", summary="Антифрод-проверка заявки")
def antifraud(body: AntifraudIn):
    return {"inn": body.inn, **profile(body.inn)["antifraud"]}


@app.get("/abs/v1/accounts/{inn}", summary="Счета и обороты клиента в банке (внутренняя АБС)")
def accounts(inn: str):
    return {"inn": inn, **profile(inn)["accounts"]}


class LoanIn(BaseModel):
    application_id: str
    inn: str
    amount: float
    rate: float
    term_months: int
    contract_number: str | None = None


ISSUED: dict[str, dict] = {}


@app.post("/abs/v1/loans", summary="Открытие ссудного счёта и выдача кредита (идемпотентно по application_id)")
def disburse(body: LoanIn):
    if body.application_id in ISSUED:
        return ISSUED[body.application_id]
    acc = profile(body.inn)["accounts"].get("account_number") or ("40702810" + hashlib.md5(body.inn.encode()).hexdigest()[:12].translate(str.maketrans("abcdef", "123456")))
    res = {"loan_id": "LN-" + uuid.uuid4().hex[:10].upper(), "account": acc, "status": "DISBURSED",
           "disbursed_at": datetime.now(timezone.utc).isoformat(), "amount": body.amount}
    ISSUED[body.application_id] = res
    return res
