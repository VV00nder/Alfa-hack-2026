"""Уведомления в продукте, персональная лента и ИИ-ассистент."""
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import NewsInteraction, NewsItem, Notification, User
from ..schemas import AssistantIn, AssistantOut, NewsOut, NotificationOut
from ..security import current_user, require_client
from ..services import assistant
from ..services.applications import get_client_app
from ..services.news import rank_feed

router = APIRouter(tags=["Notifications, Feed, Assistant"])


@router.get("/notifications", response_model=list[NotificationOut], summary="Уведомления компании (внутри продукта)")
def notifications(user: User = Depends(require_client), db: Session = Depends(get_db)):
    rows = db.scalars(select(Notification).where(Notification.company_id == user.company_id)
                      .order_by(Notification.created_at.desc()).limit(50)).all()
    return [NotificationOut.model_validate(n) for n in rows]


@router.post("/notifications/read-all", status_code=204, summary="Отметить все уведомления прочитанными")
def read_all(user: User = Depends(require_client), db: Session = Depends(get_db)):
    db.execute(update(Notification).where(Notification.company_id == user.company_id).values(is_read=True))
    db.commit()


@router.get("/news/feed", response_model=list[NewsOut], summary="Персональная лента новостей с объяснением релевантности")
def feed(user: User = Depends(require_client), db: Session = Depends(get_db)):
    out = []
    for r in rank_feed(db, user.company, user.id):
        n = NewsOut.model_validate(r["item"])
        n.relevance, n.reasons = r["relevance"], r["reasons"]
        out.append(n)
    return out


class InteractIn(BaseModel):
    action: Literal["CLICK", "HIDE", "LIKE"]


@router.post("/news/{news_id}/interact", status_code=204, summary="Реакция на материал (влияет на ранжирование)")
def interact(news_id: str, body: InteractIn, user: User = Depends(require_client), db: Session = Depends(get_db)):
    if not db.get(NewsItem, news_id):
        raise HTTPException(404, "Материал не найден")
    db.add(NewsInteraction(user_id=user.id, news_id=news_id, action=body.action))
    db.commit()


@router.post("/assistant/chat", response_model=AssistantOut, summary="Вопрос ИИ-ассистенту (подбор продукта, статус, условия)")
def chat(body: AssistantIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    app = None
    if body.application_id and user.role == "CLIENT":
        app = get_client_app(db, user, body.application_id)
    return AssistantOut(**assistant.chat(db, user.company, body.message, app))


@router.get("/assistant/status", summary="Режим работы ассистента (rules / open-weights LLM)")
def assistant_status():
    return assistant.llm_status()
