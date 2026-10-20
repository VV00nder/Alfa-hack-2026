"""Модель данных кредитного конвейера (SQLAlchemy 2.0)."""
import uuid
from datetime import UTC, date, datetime

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base, JsonType


def utcnow() -> datetime:
    return datetime.now(UTC)


def new_id() -> str:
    return str(uuid.uuid4())


class Company(Base):
    __tablename__ = "companies"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    inn: Mapped[str] = mapped_column(String(12), unique=True, index=True)
    ogrn: Mapped[str | None] = mapped_column(String(15))
    name: Mapped[str] = mapped_column(String(255))
    legal_form: Mapped[str] = mapped_column(String(8))  # OOO | IP
    okved: Mapped[str | None] = mapped_column(String(16))
    okved_name: Mapped[str | None] = mapped_column(String(255))
    region: Mapped[str | None] = mapped_column(String(128))
    address: Mapped[str | None] = mapped_column(String(512))
    director_name: Mapped[str | None] = mapped_column(String(255))
    registration_date: Mapped[date | None] = mapped_column(Date)
    segment: Mapped[str] = mapped_column(String(16), default="micro")  # micro | small | medium
    employees: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    users: Mapped[list["User"]] = relationship(back_populates="company")


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    full_name: Mapped[str] = mapped_column(String(255))
    position: Mapped[str | None] = mapped_column(String(128))
    role: Mapped[str] = mapped_column(String(32))  # CLIENT | ANALYST | RISK_MANAGER | ADMIN
    company_id: Mapped[str | None] = mapped_column(ForeignKey("companies.id"))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    company: Mapped[Company | None] = relationship(back_populates="users")


class Product(Base):
    __tablename__ = "products"

    code: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    tagline: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text)
    min_amount: Mapped[float] = mapped_column(Float)
    max_amount: Mapped[float] = mapped_column(Float)
    min_term: Mapped[int] = mapped_column(Integer)
    max_term: Mapped[int] = mapped_column(Integer)
    margin: Mapped[float] = mapped_column(Float)  # надбавка к ключевой ставке, п.п.
    rate_cap: Mapped[float | None] = mapped_column(Float)
    collateral_required: Mapped[bool] = mapped_column(Boolean, default=False)
    guarantee_required: Mapped[bool] = mapped_column(Boolean, default=False)
    requires_account: Mapped[bool] = mapped_column(Boolean, default=False)
    purposes: Mapped[list] = mapped_column(JsonType, default=list)
    eligible_okved_prefixes: Mapped[list] = mapped_column(JsonType, default=list)
    required_documents: Mapped[list] = mapped_column(JsonType, default=list)
    decision_time: Mapped[str] = mapped_column(String(64))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)


class Application(Base):
    __tablename__ = "applications"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    number: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id"), index=True)
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"))
    product_code: Mapped[str] = mapped_column(ForeignKey("products.code"))
    amount: Mapped[float] = mapped_column(Float)
    term_months: Mapped[int] = mapped_column(Integer)
    purpose: Mapped[str | None] = mapped_column(String(64))
    purpose_comment: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), index=True, default="DRAFT")

    form_data: Mapped[dict] = mapped_column(JsonType, default=dict)
    consents: Mapped[dict] = mapped_column(JsonType, default=dict)
    validation: Mapped[dict] = mapped_column(JsonType, default=dict)
    enrichment: Mapped[dict] = mapped_column(JsonType, default=dict)
    scoring: Mapped[dict] = mapped_column(JsonType, default=dict)
    decision: Mapped[dict] = mapped_column(JsonType, default=dict)
    offer: Mapped[dict] = mapped_column(JsonType, default=dict)
    info_request: Mapped[dict] = mapped_column(JsonType, default=dict)
    loan: Mapped[dict] = mapped_column(JsonType, default=dict)

    info_rounds: Mapped[int] = mapped_column(Integer, default=0)
    assigned_to: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    sign_code_hash: Mapped[str | None] = mapped_column(String(128))
    version: Mapped[int] = mapped_column(Integer, default=1)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    company: Mapped[Company] = relationship()
    product: Mapped[Product] = relationship()
    events: Mapped[list["ApplicationEvent"]] = relationship(
        back_populates="application", order_by="ApplicationEvent.created_at", cascade="all, delete-orphan"
    )
    documents: Mapped[list["Document"]] = relationship(
        back_populates="application", order_by="Document.created_at", cascade="all, delete-orphan"
    )

    __mapper_args__ = {"version_id_col": version}  # оптимистическая блокировка


class ApplicationEvent(Base):
    """Журнал событий заявки: история переходов статусов и действий участников (аудит)."""

    __tablename__ = "application_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    application_id: Mapped[str] = mapped_column(ForeignKey("applications.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    event_type: Mapped[str] = mapped_column(String(48))
    from_status: Mapped[str | None] = mapped_column(String(32))
    to_status: Mapped[str | None] = mapped_column(String(32))
    actor_type: Mapped[str] = mapped_column(String(16))  # CLIENT | SYSTEM | EMPLOYEE
    actor_id: Mapped[str | None] = mapped_column(String(36))
    actor_name: Mapped[str | None] = mapped_column(String(255))
    message: Mapped[str] = mapped_column(Text)
    details: Mapped[dict] = mapped_column(JsonType, default=dict)
    visible_to_client: Mapped[bool] = mapped_column(Boolean, default=True)

    application: Mapped[Application] = relationship(back_populates="events")


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    application_id: Mapped[str] = mapped_column(ForeignKey("applications.id"), index=True)
    doc_type: Mapped[str] = mapped_column(String(32))
    filename: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(128))
    size: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    content: Mapped[bytes] = mapped_column(LargeBinary)
    parsed: Mapped[dict] = mapped_column(JsonType, default=dict)
    uploaded_by: Mapped[str] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    application: Mapped[Application] = relationship(back_populates="documents")


class PipelineTask(Base):
    """Очередь задач конвейера (transactional outbox в PostgreSQL, выборка через SKIP LOCKED)."""

    __tablename__ = "pipeline_tasks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    application_id: Mapped[str] = mapped_column(ForeignKey("applications.id"), index=True)
    stage: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(16), default="PENDING")  # PENDING | RUNNING | DONE | FAILED
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    run_after: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    __table_args__ = (Index("ix_pipeline_tasks_pending", "status", "run_after"),)


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    company_id: Mapped[str] = mapped_column(ForeignKey("companies.id"), index=True)
    application_id: Mapped[str | None] = mapped_column(ForeignKey("applications.id"))
    kind: Mapped[str] = mapped_column(String(32))  # STATUS | ACTION_REQUIRED | SIGN_CODE | INFO
    title: Mapped[str] = mapped_column(String(255))
    body: Mapped[str] = mapped_column(Text)
    is_read: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class NewsItem(Base):
    __tablename__ = "news_items"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    title: Mapped[str] = mapped_column(String(255))
    summary: Mapped[str] = mapped_column(Text)
    body: Mapped[str] = mapped_column(Text)
    category: Mapped[str] = mapped_column(String(32))  # MARKET | SUPPORT | TAX | PRODUCT | EDUCATION | INDUSTRY
    tags: Mapped[dict] = mapped_column(JsonType, default=dict)
    priority: Mapped[int] = mapped_column(Integer, default=10)
    source: Mapped[str | None] = mapped_column(String(128))
    cta_label: Mapped[str | None] = mapped_column(String(64))
    cta_link: Mapped[str | None] = mapped_column(String(255))
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by: Mapped[str | None] = mapped_column(String(36))


class NewsInteraction(Base):
    __tablename__ = "news_interactions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    news_id: Mapped[str] = mapped_column(ForeignKey("news_items.id"))
    action: Mapped[str] = mapped_column(String(16))  # CLICK | HIDE | LIKE
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AuditLog(Base):
    """Журнал аудита безопасности (входы, действия сотрудников, изменения справочников)."""

    __tablename__ = "audit_log"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    actor_id: Mapped[str | None] = mapped_column(String(36))
    actor_email: Mapped[str | None] = mapped_column(String(255))
    action: Mapped[str] = mapped_column(String(64))
    entity: Mapped[str | None] = mapped_column(String(64))
    entity_id: Mapped[str | None] = mapped_column(String(36))
    ip: Mapped[str | None] = mapped_column(String(64))
    details: Mapped[dict] = mapped_column(JsonType, default=dict)
