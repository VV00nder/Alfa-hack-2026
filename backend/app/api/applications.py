"""Клиентский API заявки: черновик → отправка → ответ на запрос → предложение → подписание."""
import hashlib
from datetime import date

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import Application, Document, Product, User
from ..schemas import (
    AcceptOfferIn,
    ApplicationCreate,
    ApplicationOut,
    ApplicationShort,
    ApplicationUpdate,
    CancelIn,
    DocumentOut,
    InfoResponseIn,
    SignIn,
)
from ..security import audit, require_client
from ..services.applications import after_commit, get_client_app, new_number, to_full, to_short
from ..services.documents import ALLOWED_EXT, DOC_TYPES, parse_bank_statement
from ..state_machine import CLIENT_CANCELLABLE, Actor, TransitionError, log_event, transition
from ..state_machine import Status as S

router = APIRouter(prefix="/applications", tags=["Applications (client)"])


def _actor(user: User) -> Actor:
    return Actor("CLIENT", user.id, user.full_name)


def _merge_form(app: Application, form_data, consents) -> None:
    if form_data is not None:
        app.form_data = {**(app.form_data or {}), **form_data.model_dump()}
    if consents is not None:
        app.consents = {**consents.model_dump(), "given_at": date.today().isoformat()}


def _do(db: Session, app: Application, to: str, actor: Actor, message: str | None = None) -> None:
    try:
        transition(db, app, to, actor, message)
    except TransitionError as e:
        raise HTTPException(409, str(e))


@router.get("", response_model=list[ApplicationShort], summary="Мои заявки")
def list_my(user: User = Depends(require_client), db: Session = Depends(get_db)):
    apps = db.scalars(select(Application).where(Application.company_id == user.company_id)
                      .order_by(Application.created_at.desc())).all()
    return [to_short(a) for a in apps]


@router.post("", response_model=ApplicationOut, status_code=201, summary="Создать черновик заявки")
def create(body: ApplicationCreate, user: User = Depends(require_client), db: Session = Depends(get_db)):
    product = db.get(Product, body.product_code)
    if not product or not product.is_active:
        raise HTTPException(422, "Неизвестный продукт")
    app = Application(number=new_number(), company_id=user.company_id, created_by=user.id, status=S.DRAFT,
                      form_data={"contact": {"name": user.full_name, "position": user.position}}, consents={},
                      **body.model_dump())
    db.add(app)
    db.flush()
    log_event(db, app, "CREATED", "Создан черновик заявки", _actor(user), to_status=S.DRAFT)
    db.commit()
    db.refresh(app)
    return to_full(app, False)


@router.get("/{app_id}", response_model=ApplicationOut, summary="Заявка с таймлайном, предложением и документами")
def get_one(app_id: str, user: User = Depends(require_client), db: Session = Depends(get_db)):
    return to_full(get_client_app(db, user, app_id), False)


@router.patch("/{app_id}", response_model=ApplicationOut, summary="Автосохранение черновика")
def update(app_id: str, body: ApplicationUpdate, user: User = Depends(require_client), db: Session = Depends(get_db)):
    app = get_client_app(db, user, app_id)
    if app.status not in (S.DRAFT, S.INFO_REQUESTED):
        raise HTTPException(409, "Заявку можно изменять только в статусе черновика или при запросе информации")
    data = body.model_dump(exclude_unset=True, exclude={"form_data", "consents"})
    if app.status == S.INFO_REQUESTED:
        data = {}  # после отправки параметры кредита меняются только через новую заявку
    if "product_code" in data and not db.get(Product, data["product_code"]):
        raise HTTPException(422, "Неизвестный продукт")
    for k, v in data.items():
        setattr(app, k, v)
    _merge_form(app, body.form_data, body.consents)
    db.commit()
    db.refresh(app)
    return to_full(app, False)


@router.post("/{app_id}/submit", response_model=ApplicationOut, summary="Отправить заявку в банк")
def submit(app_id: str, request: Request, user: User = Depends(require_client), db: Session = Depends(get_db)):
    app = get_client_app(db, user, app_id)
    if app.status != S.DRAFT:
        return to_full(app, False)  # идемпотентность: повторная отправка не создаёт дублей
    problems = []
    if not (app.consents or {}).get("bki") or not (app.consents or {}).get("personal_data"):
        problems.append("Нужны согласия на запрос в БКИ и обработку данных")
    if not ((app.form_data or {}).get("financials") or {}).get("revenue_last_year"):
        problems.append("Укажите выручку за последний год")
    if not (app.form_data or {}).get("company_confirmed"):
        problems.append("Подтвердите данные компании")
    if problems:
        raise HTTPException(422, {"message": "Заявка заполнена не полностью", "problems": problems})
    _do(db, app, S.SUBMITTED, _actor(user), "Заявка отправлена в банк")
    audit(db, request, user, "APPLICATION_SUBMITTED", "application", app.id)
    db.commit()
    after_commit()
    db.refresh(app)
    return to_full(app, False)


@router.post("/{app_id}/documents", response_model=DocumentOut, status_code=201, summary="Загрузить документ")
async def upload(app_id: str, doc_type: str = Form(...), file: UploadFile = File(...),
                 user: User = Depends(require_client), db: Session = Depends(get_db)):
    app = get_client_app(db, user, app_id)
    if app.status not in (S.DRAFT, S.INFO_REQUESTED):
        raise HTTPException(409, "Документы можно добавлять в черновик или по запросу банка")
    if doc_type not in DOC_TYPES:
        raise HTTPException(422, f"Тип документа: {', '.join(sorted(DOC_TYPES))}")
    name = (file.filename or "file").replace("/", "_").replace("\\", "_")[:200]
    if not name.lower().endswith(ALLOWED_EXT):
        raise HTTPException(415, "Допустимые форматы: PDF, PNG, JPG, CSV, TXT")
    content = await file.read()
    limit = get_settings().max_upload_mb * 1024 * 1024
    if len(content) > limit:
        raise HTTPException(413, f"Файл больше {get_settings().max_upload_mb} МБ")
    if not content:
        raise HTTPException(422, "Пустой файл")
    parsed = parse_bank_statement(content) if doc_type == "BANK_STATEMENT" and name.lower().endswith((".csv", ".txt")) else {}
    doc = Document(application_id=app.id, doc_type=doc_type, filename=name, content_type=file.content_type or "application/octet-stream",
                   size=len(content), sha256=hashlib.sha256(content).hexdigest(), content=content, parsed=parsed, uploaded_by=user.id)
    db.add(doc)
    msg = f"Загружен документ «{name}»"
    if parsed.get("ok"):
        msg += f": распознано {parsed['operations']} операций за {parsed['months']} мес."
    log_event(db, app, "DOCUMENT_UPLOADED", msg, _actor(user), {"doc_type": doc_type, "parsed": bool(parsed.get("ok"))})
    db.commit()
    db.refresh(doc)
    return DocumentOut.model_validate(doc)


@router.get("/{app_id}/documents/{doc_id}", summary="Скачать документ (в т.ч. сформированный договор)")
def download(app_id: str, doc_id: str, user: User = Depends(require_client), db: Session = Depends(get_db)):
    app = get_client_app(db, user, app_id)
    doc = next((d for d in app.documents if d.id == doc_id), None)
    if not doc:
        raise HTTPException(404, "Документ не найден")
    disp = "inline" if doc.content_type == "text/html" else "attachment"
    return Response(doc.content, media_type=doc.content_type,
                    headers={"Content-Disposition": f"{disp}; filename*=UTF-8''{doc.id}{doc.filename[-5:]}",
                             "X-Content-Type-Options": "nosniff"})


@router.delete("/{app_id}/documents/{doc_id}", status_code=204, summary="Удалить документ из черновика")
def delete_doc(app_id: str, doc_id: str, user: User = Depends(require_client), db: Session = Depends(get_db)):
    app = get_client_app(db, user, app_id)
    if app.status not in (S.DRAFT, S.INFO_REQUESTED):
        raise HTTPException(409, "Документ уже передан в банк")
    doc = next((d for d in app.documents if d.id == doc_id and d.doc_type != "CONTRACT"), None)
    if not doc:
        raise HTTPException(404, "Документ не найден")
    db.delete(doc)
    db.commit()


@router.post("/{app_id}/info-response", response_model=ApplicationOut, summary="Ответить на запрос банка и вернуть заявку в работу")
def info_response(app_id: str, body: InfoResponseIn, user: User = Depends(require_client), db: Session = Depends(get_db)):
    app = get_client_app(db, user, app_id)
    if app.status != S.INFO_REQUESTED:
        raise HTTPException(409, "Банк не запрашивал дополнительную информацию")
    _merge_form(app, body.form_data, body.consents)
    have = {d.doc_type for d in app.documents}
    missing = [i["text"] for i in app.info_request.get("items", [])
               if i.get("type") == "document" and i.get("doc_type") and i["doc_type"] not in have]
    if missing and not body.comment:
        raise HTTPException(422, {"message": "Загрузите запрошенные документы или оставьте комментарий", "problems": missing})
    app.info_request = {**app.info_request, "response": {"comment": body.comment, "at": date.today().isoformat()}}
    _do(db, app, S.SUBMITTED, _actor(user), "Информация предоставлена, заявка возвращена на рассмотрение")
    db.commit()
    after_commit()
    db.refresh(app)
    return to_full(app, False)


@router.post("/{app_id}/accept-offer", response_model=ApplicationOut, summary="Принять предложение (выбрать вариант)")
def accept_offer(app_id: str, body: AcceptOfferIn, user: User = Depends(require_client), db: Session = Depends(get_db)):
    app = get_client_app(db, user, app_id)
    if app.status not in (S.APPROVED, S.COUNTER_OFFER):
        raise HTTPException(409, "Нет активного предложения")
    options = app.offer.get("options", [])
    if body.option_index >= len(options):
        raise HTTPException(422, "Неверный вариант предложения")
    if app.offer.get("valid_until") and date.fromisoformat(app.offer["valid_until"]) < date.today():
        raise HTTPException(409, "Срок действия предложения истёк")
    app.offer = {**app.offer, "selected_index": body.option_index}
    o = options[body.option_index]
    _do(db, app, S.OFFER_ACCEPTED, _actor(user),
        f"Предложение принято: {o['amount']:,.0f} ₽ на {o['term_months']} мес. под {o['rate']}%".replace(",", " "))
    db.commit()
    after_commit()
    db.refresh(app)
    return to_full(app, False)


@router.post("/{app_id}/sign", response_model=ApplicationOut, summary="Подписать договор кодом ПЭП (симуляция)")
def sign(app_id: str, body: SignIn, request: Request, user: User = Depends(require_client), db: Session = Depends(get_db)):
    app = get_client_app(db, user, app_id)
    if app.status != S.SIGNING:
        raise HTTPException(409, "Договор не ожидает подписания")
    attempts = int((app.loan or {}).get("sign_attempts", 0))
    if attempts >= 5:
        raise HTTPException(429, "Превышено число попыток. Отмените заявку и создайте новую.")
    if hashlib.sha256(f"{app.id}:{body.code}".encode()).hexdigest() != app.sign_code_hash:
        app.loan = {**app.loan, "sign_attempts": attempts + 1}
        audit(db, request, user, "SIGN_FAILED", "application", app.id)
        db.commit()
        raise HTTPException(422, f"Неверный код. Осталось попыток: {4 - attempts}")
    app.loan = {**app.loan, "signed_by": user.full_name, "signed_at": date.today().isoformat()}
    _do(db, app, S.SIGNED, _actor(user), "Договор подписан простой электронной подписью")
    audit(db, request, user, "CONTRACT_SIGNED", "application", app.id)
    db.commit()
    after_commit()
    db.refresh(app)
    return to_full(app, False)


@router.post("/{app_id}/cancel", response_model=ApplicationOut, summary="Отозвать заявку")
def cancel(app_id: str, body: CancelIn, user: User = Depends(require_client), db: Session = Depends(get_db)):
    app = get_client_app(db, user, app_id)
    if app.status not in CLIENT_CANCELLABLE:
        raise HTTPException(409, "Заявку уже нельзя отменить")
    _do(db, app, S.CANCELLED, _actor(user), "Заявка отозвана клиентом" + (f": {body.reason}" if body.reason else ""))
    db.commit()
    db.refresh(app)
    return to_full(app, False)
