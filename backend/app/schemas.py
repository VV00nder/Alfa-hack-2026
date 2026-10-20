"""DTO API. Входные данные строго валидируются (pydantic v2)."""
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .validators import is_valid_inn

EMAIL_RE = r"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$"


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---------------------------------------------------------------- auth


class LoginIn(BaseModel):
    email: str = Field(pattern=EMAIL_RE, max_length=255)
    password: str = Field(min_length=6, max_length=128)


class RegisterIn(BaseModel):
    email: str = Field(pattern=EMAIL_RE, max_length=255)
    password: str = Field(min_length=8, max_length=128)
    full_name: str = Field(min_length=3, max_length=255)
    position: str | None = Field(default="Генеральный директор", max_length=128)
    inn: str

    @field_validator("inn")
    @classmethod
    def _inn(cls, v: str) -> str:
        v = v.strip()
        if not is_valid_inn(v):
            raise ValueError("Некорректный ИНН (проверьте контрольную сумму)")
        return v


class CompanyOut(ORM):
    id: str
    inn: str
    ogrn: str | None
    name: str
    legal_form: str
    okved: str | None
    okved_name: str | None
    region: str | None
    address: str | None
    director_name: str | None
    registration_date: date | None
    segment: str
    employees: int | None


class UserOut(ORM):
    id: str
    email: str
    full_name: str
    position: str | None
    role: str
    company: CompanyOut | None = None


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


# ---------------------------------------------------------------- products


class ProductOut(ORM):
    code: str
    name: str
    tagline: str
    description: str
    min_amount: float
    max_amount: float
    min_term: int
    max_term: int
    margin: float
    rate_cap: float | None
    collateral_required: bool
    guarantee_required: bool
    requires_account: bool
    purposes: list[str]
    eligible_okved_prefixes: list[str]
    required_documents: list[str]
    decision_time: str
    rate_from: float | None = None


class RecommendIn(BaseModel):
    purpose: str | None = Field(default=None, description="Цель: EQUIPMENT, WORKING_CAPITAL, CASH_GAP, EXPANSION, REAL_ESTATE, REFINANCE, TENDER")
    amount: float | None = Field(default=None, gt=0, le=500_000_000)
    term_months: int | None = Field(default=None, ge=1, le=120)
    has_collateral: bool = False
    text: str | None = Field(default=None, max_length=1000, description="Свободное описание потребности (для ИИ-ассистента)")


class CalcIn(BaseModel):
    product_code: str
    amount: float = Field(gt=0, le=500_000_000)
    term_months: int = Field(ge=1, le=120)


# ---------------------------------------------------------------- applications


class Financials(BaseModel):
    revenue_last_year: float | None = Field(default=None, ge=0, le=1e11)
    expenses_last_year: float | None = Field(default=None, ge=0, le=1e11)
    existing_monthly_payments: float | None = Field(default=0, ge=0, le=1e10)
    employees: int | None = Field(default=None, ge=0, le=100_000)


class Collateral(BaseModel):
    type: Literal["NONE", "REAL_ESTATE", "EQUIPMENT", "VEHICLE", "GOODS"] = "NONE"
    description: str | None = Field(default=None, max_length=500)
    estimated_value: float | None = Field(default=0, ge=0, le=1e11)


class Contact(BaseModel):
    name: str | None = Field(default=None, max_length=255)
    position: str | None = Field(default=None, max_length=128)
    phone: str | None = Field(default=None, max_length=32)


class FormData(BaseModel):
    financials: Financials = Financials()
    collateral: Collateral = Collateral()
    contact: Contact = Contact()
    owner_guarantee: bool = False
    company_confirmed: bool = False


class Consents(BaseModel):
    bki: bool = False
    personal_data: bool = False


class ApplicationCreate(BaseModel):
    product_code: str
    amount: float = Field(gt=0, le=500_000_000)
    term_months: int = Field(ge=1, le=120)
    purpose: str | None = Field(default=None, max_length=64)
    purpose_comment: str | None = Field(default=None, max_length=1000)


class ApplicationUpdate(BaseModel):
    """Автосохранение черновика: передаются только изменённые поля."""

    product_code: str | None = None
    amount: float | None = Field(default=None, gt=0, le=500_000_000)
    term_months: int | None = Field(default=None, ge=1, le=120)
    purpose: str | None = Field(default=None, max_length=64)
    purpose_comment: str | None = Field(default=None, max_length=1000)
    form_data: FormData | None = None
    consents: Consents | None = None


class InfoResponseIn(BaseModel):
    comment: str | None = Field(default=None, max_length=2000)
    form_data: FormData | None = None
    consents: Consents | None = None


class AcceptOfferIn(BaseModel):
    option_index: int = Field(ge=0, le=5)


class SignIn(BaseModel):
    code: str = Field(min_length=6, max_length=6, pattern=r"^\d{6}$")


class CancelIn(BaseModel):
    reason: str | None = Field(default=None, max_length=500)


class EventOut(ORM):
    id: str
    created_at: datetime
    event_type: str
    from_status: str | None
    to_status: str | None
    actor_type: str
    actor_name: str | None
    message: str
    details: dict


class DocumentOut(ORM):
    id: str
    doc_type: str
    filename: str
    content_type: str
    size: int
    sha256: str
    parsed: dict
    created_at: datetime


class ApplicationShort(ORM):
    id: str
    number: str
    product_code: str
    amount: float
    term_months: int
    purpose: str | None
    status: str
    status_label: str = ""
    created_at: datetime
    updated_at: datetime
    submitted_at: datetime | None
    decided_at: datetime | None
    company_name: str | None = None
    company_inn: str | None = None
    grade: str | None = None
    score: int | None = None
    assigned_to: str | None = None
    sla_minutes: int | None = None


class ApplicationOut(ApplicationShort):
    purpose_comment: str | None
    form_data: dict
    consents: dict
    validation: dict
    info_request: dict
    offer: dict
    decision: dict
    loan: dict
    status_hint: str = ""
    stage: int = 1
    next_action: str | None = None
    required_documents: list[str] = []
    documents: list[DocumentOut] = []
    events: list[EventOut] = []
    product: ProductOut | None = None
    # Поля ниже заполняются только для сотрудников банка
    enrichment: dict | None = None
    scoring: dict | None = None
    company: CompanyOut | None = None


# ---------------------------------------------------------------- back office


class DecisionIn(BaseModel):
    action: Literal["APPROVE", "COUNTER_OFFER", "REJECT", "REQUEST_INFO", "TO_COMMITTEE", "RETURN_TO_ANALYST"]
    comment: str = Field(min_length=3, max_length=2000)
    amount: float | None = Field(default=None, gt=0)
    term_months: int | None = Field(default=None, ge=1, le=120)
    rate: float | None = Field(default=None, gt=0, lt=60)
    product_code: str | None = None
    info_items: list[str] | None = Field(default=None, description="Что запросить у клиента")
    request_doc_types: list[str] | None = None


class NotificationOut(ORM):
    id: str
    application_id: str | None
    kind: str
    title: str
    body: str
    is_read: bool
    created_at: datetime


class NewsIn(BaseModel):
    title: str = Field(min_length=5, max_length=255)
    summary: str = Field(min_length=5, max_length=1000)
    body: str = Field(default="", max_length=10_000)
    category: Literal["MARKET", "SUPPORT", "TAX", "PRODUCT", "EDUCATION", "INDUSTRY"] = "MARKET"
    tags: dict[str, list[str]] = Field(default_factory=dict, description="okved, regions, segments, legal_forms, products, statuses")
    priority: int = Field(default=10, ge=0, le=100)
    source: str | None = None
    cta_label: str | None = None
    cta_link: str | None = None


class NewsOut(ORM):
    id: str
    title: str
    summary: str
    body: str
    category: str
    tags: dict
    priority: int
    source: str | None
    cta_label: str | None
    cta_link: str | None
    published_at: datetime
    is_active: bool = True
    relevance: float | None = None
    reasons: list[str] = []


class AssistantIn(BaseModel):
    message: str = Field(min_length=1, max_length=1000)
    application_id: str | None = None


class AssistantOut(BaseModel):
    answer: str
    engine: str
    parsed: dict[str, Any] | None = None
    recommendations: list[dict] | None = None
    suggestions: list[str] = []
