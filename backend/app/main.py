import hashlib
import json
import os
from contextlib import asynccontextmanager
from datetime import date, timedelta
from typing import List, Optional, Type, TypeVar
from urllib.parse import quote

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from sqlmodel import SQLModel, delete, func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.core.auth import create_access_token, get_current_user, verify_google_credential
from app.core.database import async_session_maker, get_session, init_db
from app.core.logging import setup_logging
from app import explore
from app.agents import guidelines as guideline_store
from app.agents import journeys as journey_svc, llm as agent_llm
from app.agents.orchestrator import run_turn
from app.models import (
    ChatMessage, ChatSession, CountryGuideline, Document, DocumentAnalysis, FavoriteDestination, Journey, Notification,
    Payment, PipelineRun, PrefilledForm, Task, User, utcnow,
)
from app.schemas import (
    AuthResponse, ChatCreate, ChatRequest, DocumentOut, FavoriteCreate, FormValues, GoogleAuthRequest, JourneyPatch, PaymentCreate,
    TaskCreate,
    TaskUpdate, UserOut, UserUpdate,
)
from app.forms import pdf as form_pdf, service as form_service, templates as form_templates
from app.pipeline.targets import TARGETS
from app.services import visa_matrix
from app.services.storage import StorageService
from sqlalchemy import text

MAX_UPLOAD_BYTES = 10 * 1024 * 1024
CHAT_RATE_LIMIT_PER_HOUR = int(os.getenv("CHAT_RATE_LIMIT_PER_HOUR", "60"))
ADMIN_EMAILS = {e.strip().lower() for e in os.getenv("ADMIN_EMAILS", "").split(",") if e.strip()}
DOCUMENT_CATEGORIES = {"Passport", "Visa or permit", "Insurance", "Finances", "Education", "Housing", "Other"}
EXPIRY_WARNING_DAYS = 60

# Magic bytes, so the stored type is what the file really is, not what the browser claims.
SIGNATURES = {b"%PDF": "application/pdf", b"\xff\xd8\xff": "image/jpeg", b"\x89PNG": "image/png"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    await init_db()
    async with async_session_maker() as session:
        await visa_matrix.ensure_loaded(session)
    await StorageService.ensure_bucket_exists()
    yield


app = FastAPI(title="Unbound API", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:5173").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Unplaced-Fields", "Content-Disposition"],
)

M = TypeVar("M", bound=SQLModel)


async def owned(session: AsyncSession, model: Type[M], item_id: str, user: User, label: str) -> M:
    """Loads a row and 404s unless it belongs to the user, so ids can't be guessed across accounts."""
    item = await session.get(model, item_id)
    if not item or getattr(item, "user_id") != user.id:
        raise HTTPException(404, f"{label} not found")
    return item


def notify(session: AsyncSession, user: User, kind: str, title: str, body: str, href: str) -> None:
    session.add(Notification(user_id=user.id, kind=kind, title=title, body=body, href=href))


# --- AUTH ---

@app.post("/api/auth/google", response_model=AuthResponse)
async def google_login(payload: GoogleAuthRequest, session: AsyncSession = Depends(get_session)):
    info = await verify_google_credential(payload.credential)
    result = await session.exec(select(User).where(User.google_sub == info["sub"]))
    user = result.first()
    name = info.get("name") or info["email"].split("@")[0]
    if user:
        # keep the Google account details current; the rest is the user's own
        user.email = info["email"]
        user.picture_url = info.get("picture")
    else:
        user = User(
            google_sub=info["sub"],
            email=info["email"],
            full_name=name,
            first_name=info.get("given_name") or name.split()[0],
            picture_url=info.get("picture"),
        )
    session.add(user)
    await session.commit()
    await session.refresh(user)
    return AuthResponse(access_token=create_access_token(user.id), user=me_out(user))


# --- PROFILE ---

def is_admin(user: User) -> bool:
    return user.email.lower() in ADMIN_EMAILS


def me_out(user: User) -> UserOut:
    out = UserOut.model_validate(user, from_attributes=True)
    out.is_admin = is_admin(user)
    return out


async def require_admin(user: User = Depends(get_current_user)) -> User:
    if not is_admin(user):
        raise HTTPException(403, "Only administrators can do this.")
    return user


@app.get("/api/me", response_model=UserOut)
async def get_me(user: User = Depends(get_current_user)):
    return me_out(user)


@app.patch("/api/me", response_model=UserOut)
async def update_me(payload: UserUpdate, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    changes = payload.model_dump(exclude_unset=True)
    if "full_name" in changes:
        name = (changes["full_name"] or "").strip()
        if not name:
            raise HTTPException(422, "Add your name as it appears in your passport.")
        changes["full_name"] = name
        user.first_name = name.split()[0]
    for key, value in changes.items():
        setattr(user, key, value.strip() if isinstance(value, str) else value)
    session.add(user)
    await session.commit()
    await session.refresh(user)
    return me_out(user)


@app.delete("/api/me", status_code=204)
async def delete_me(user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    docs = (await session.exec(select(Document).where(Document.user_id == user.id))).all()
    for doc in docs:
        await StorageService.delete(doc.storage_key)
    chat_ids = select(ChatSession.id).where(ChatSession.user_id == user.id)
    await session.execute(delete(ChatMessage).where(ChatMessage.session_id.in_(chat_ids)))
    # Children before parents (foreign keys).
    for model in (ChatSession, PrefilledForm, DocumentAnalysis, Document, Task, Payment, Journey, Notification, FavoriteDestination):
        await session.execute(delete(model).where(model.user_id == user.id))
    await session.delete(user)
    await session.commit()


# --- TASKS ---

@app.get("/api/tasks", response_model=List[Task])
async def list_tasks(user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    result = await session.exec(select(Task).where(Task.user_id == user.id).order_by(Task.due_date, Task.created_at))
    return result.all()


@app.post("/api/tasks", response_model=Task)
async def create_task(payload: TaskCreate, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    task = Task(user_id=user.id, title=payload.title.strip(), category=payload.category, due_date=payload.due_date)
    session.add(task)
    await session.commit()
    await session.refresh(task)
    return task


@app.patch("/api/tasks/{task_id}", response_model=Task)
async def update_task(task_id: str, payload: TaskUpdate, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    task = await owned(session, Task, task_id, user, "Task")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(task, key, value)
    session.add(task)
    await session.commit()
    await session.refresh(task)
    return task


@app.delete("/api/tasks/{task_id}", status_code=204)
async def delete_task(task_id: str, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    task = await owned(session, Task, task_id, user, "Task")
    await session.delete(task)
    await session.commit()


# --- DOCUMENTS ---

def document_out(doc: Document, analysis: Optional[DocumentAnalysis]) -> DocumentOut:
    out = DocumentOut.model_validate(doc, from_attributes=True)
    if analysis:
        out.analysis = {
            "status": analysis.status, "document_kind": analysis.document_kind, "summary": analysis.summary,
            "fields": analysis.normalized, "issues": analysis.issues, "error": analysis.error,
            "analyzed_at": analysis.analyzed_at,
        }
    return out


@app.get("/api/documents", response_model=List[DocumentOut])
async def list_documents(user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    docs = (await session.exec(select(Document).where(Document.user_id == user.id).order_by(Document.uploaded_at.desc()))).all()
    analyses = {a.document_id: a for a in (await session.exec(select(DocumentAnalysis).where(DocumentAnalysis.user_id == user.id))).all()}
    return [document_out(d, analyses.get(d.id)) for d in docs]


@app.post("/api/documents/{doc_id}/analyze", response_model=DocumentOut)
async def reanalyze_document(doc_id: str, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    doc = await owned(session, Document, doc_id, user, "Document")
    analysis = (await session.exec(select(DocumentAnalysis).where(DocumentAnalysis.document_id == doc.id))).first()
    if analysis and analysis.status == "pending":
        raise HTTPException(409, "This document is already being analysed.")
    analysis = analysis or DocumentAnalysis(document_id=doc.id, user_id=user.id)
    # The worker (app/worker.py) picks pending analyses up from the database.
    analysis.status, analysis.error, analysis.claimed_at = "pending", None, None
    session.add(analysis)
    await session.commit()
    return document_out(doc, analysis)


@app.post("/api/documents", response_model=DocumentOut)
async def upload_document(
    file: UploadFile = File(...),
    title: str = Form(..., min_length=1, max_length=120),
    category: str = Form("Other"),
    expires_on: Optional[date] = Form(None),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    if category not in DOCUMENT_CATEGORIES:
        raise HTTPException(422, "Choose a document type from the list.")
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "This file is over 10 MB. Compress it or upload a single page.")
    if not data:
        raise HTTPException(422, "This file is empty. Choose another one.")
    content_type = next((t for sig, t in SIGNATURES.items() if data.startswith(sig)), None)
    if not content_type:
        raise HTTPException(415, "Upload a PDF, JPG or PNG file.")

    digest = hashlib.sha256(data).hexdigest()
    dupe = (await session.exec(select(Document).where(Document.user_id == user.id, Document.sha256 == digest))).first()
    if dupe:
        raise HTTPException(409, f"You already uploaded this file as “{dupe.title}”.")

    doc = Document(
        user_id=user.id,
        title=title.strip(),
        category=category,
        file_name=os.path.basename(file.filename or "document"),
        content_type=content_type,
        size_bytes=len(data),
        sha256=digest,
        storage_key="",
        expires_on=expires_on,
    )
    doc.storage_key = f"{user.id}/{doc.id}"
    await StorageService.put(doc.storage_key, data, content_type)
    session.add(doc)

    if expires_on:
        days = (expires_on - date.today()).days
        if days < 0:
            notify(session, user, "document", f"{doc.title} has expired", f"It expired on {expires_on:%d %b %Y}. Upload a valid one.", "/app/documents")
        elif days <= EXPIRY_WARNING_DAYS:
            notify(session, user, "deadline", f"{doc.title} expires in {days} days", f"Renew it before {expires_on:%d %b %Y}.", "/app/documents")

    analysis = DocumentAnalysis(document_id=doc.id, user_id=user.id)
    session.add(analysis)
    await session.commit()
    await session.refresh(doc)
    return document_out(doc, analysis)


@app.get("/api/documents/{doc_id}/file")
async def download_document(doc_id: str, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    doc = await owned(session, Document, doc_id, user, "Document")
    data = await StorageService.get(doc.storage_key)
    return Response(
        content=data,
        media_type=doc.content_type,
        headers={"Content-Disposition": f"inline; filename*=UTF-8''{quote(doc.file_name)}"},
    )


@app.delete("/api/documents/{doc_id}", status_code=204)
async def delete_document(doc_id: str, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    doc = await owned(session, Document, doc_id, user, "Document")
    await StorageService.delete(doc.storage_key)
    await session.execute(delete(DocumentAnalysis).where(DocumentAnalysis.document_id == doc.id))
    await session.delete(doc)
    await session.commit()


# --- PAYMENTS ---

@app.get("/api/payments", response_model=List[Payment])
async def list_payments(user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    result = await session.exec(select(Payment).where(Payment.user_id == user.id).order_by(Payment.paid_on.desc()))
    return result.all()


@app.post("/api/payments", response_model=Payment)
async def create_payment(payload: PaymentCreate, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    """Simulated Wise payment: records it as paid. No money moves."""
    payment = Payment(user_id=user.id, title=payload.title, amount_eur=payload.amount_eur, status="paid")
    session.add(payment)
    notify(session, user, "money", "Payment recorded", f"€{payload.amount_eur} for {payload.title}.", "/app/finances/costs")
    await session.commit()
    await session.refresh(payment)
    return payment


# --- NOTIFICATIONS ---

@app.get("/api/notifications", response_model=List[Notification])
async def list_notifications(user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    result = await session.exec(
        select(Notification).where(Notification.user_id == user.id).order_by(Notification.created_at.desc()).limit(50)
    )
    return result.all()


@app.post("/api/notifications/{notif_id}/read", response_model=Notification)
async def mark_notification_read(notif_id: str, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    notif = await owned(session, Notification, notif_id, user, "Notification")
    notif.read = True
    session.add(notif)
    await session.commit()
    await session.refresh(notif)
    return notif


@app.post("/api/notifications/mark-all-read", status_code=204)
async def mark_all_read(user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    result = await session.exec(select(Notification).where(Notification.user_id == user.id, Notification.read == False))  # noqa: E712
    for notif in result.all():
        notif.read = True
        session.add(notif)
    await session.commit()


# --- ASSISTANT ---

def session_out(c: ChatSession) -> dict:
    return {"id": c.id, "title": c.title, "journey_id": c.journey_id, "created_at": c.created_at, "updated_at": c.updated_at}


@app.get("/api/chat/sessions")
async def list_chat_sessions(user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    rows = (await session.exec(select(ChatSession).where(ChatSession.user_id == user.id).order_by(ChatSession.updated_at.desc()).limit(50))).all()
    return [session_out(c) for c in rows]


@app.post("/api/chat/sessions")
async def create_chat_session(payload: Optional[ChatCreate] = None, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    journey_id = payload.journey_id if payload else None
    if journey_id:
        await owned(session, Journey, journey_id, user, "Journey")
    chat = ChatSession(user_id=user.id, provider=agent_llm.provider(), journey_id=journey_id)
    session.add(chat)
    await session.commit()
    await session.refresh(chat)
    return session_out(chat)


@app.patch("/api/chat/sessions/{chat_id}")
async def update_chat_session(chat_id: str, payload: ChatCreate, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    """Point a conversation at another journey (or none): the assistant then works on that one."""
    chat = await owned(session, ChatSession, chat_id, user, "Conversation")
    if payload.journey_id:
        await owned(session, Journey, payload.journey_id, user, "Journey")
    chat.journey_id = payload.journey_id
    chat.updated_at = utcnow()
    session.add(chat)
    await session.commit()
    await session.refresh(chat)
    return session_out(chat)


@app.delete("/api/chat/sessions/{chat_id}", status_code=204)
async def delete_chat_session(chat_id: str, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    chat = await owned(session, ChatSession, chat_id, user, "Conversation")
    await session.execute(delete(ChatMessage).where(ChatMessage.session_id == chat.id))
    await session.delete(chat)
    await session.commit()


@app.get("/api/chat/sessions/{chat_id}/messages")
async def list_chat_messages(chat_id: str, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    """What the UI shows: user turns and assistant text with its tool steps. Tool-result turns are internal."""
    chat = await owned(session, ChatSession, chat_id, user, "Conversation")
    rows = (await session.exec(select(ChatMessage).where(ChatMessage.session_id == chat.id).order_by(ChatMessage.seq))).all()
    return [
        {"id": r.id, "role": r.role, "text": r.display_text, "events": r.events, "created_at": r.created_at}
        for r in rows if r.display_text or r.events
    ]


# One answer at a time per conversation; a second request would interleave the history.
_busy: set[str] = set()


@app.post("/api/chat/sessions/{chat_id}/messages")
async def send_chat_message(chat_id: str, payload: ChatRequest, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    await owned(session, ChatSession, chat_id, user, "Conversation")
    # Rate limit per user, counted from stored messages (works across restarts).
    sent = (await session.exec(
        select(func.count()).select_from(ChatMessage).join(ChatSession, ChatSession.id == ChatMessage.session_id)
        .where(ChatSession.user_id == user.id, ChatMessage.role == "user", ChatMessage.display_text != None,  # noqa: E711
               ChatMessage.created_at > utcnow() - timedelta(hours=1))
    )).one()
    if sent >= CHAT_RATE_LIMIT_PER_HOUR:
        raise HTTPException(429, f"You’ve sent {CHAT_RATE_LIMIT_PER_HOUR} messages in the last hour. Try again a little later.")
    if chat_id in _busy:
        raise HTTPException(409, "The assistant is still answering in this conversation.")
    _busy.add(chat_id)

    async def events():
        try:
            async for event in run_turn(user.id, chat_id, payload.message.strip()):
                yield f"data: {json.dumps(event, default=str)}\n\n"
        finally:
            _busy.discard(chat_id)

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# --- PLANS & FORMS ---

def form_out(form: PrefilledForm) -> dict:
    return {**form.model_dump(mode="json"), "has_official_pdf": form_templates.pdf_spec(form.form_key) is not None}


@app.get("/api/forms")
async def list_forms(user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    rows = (await session.exec(select(PrefilledForm).where(PrefilledForm.user_id == user.id).order_by(PrefilledForm.created_at.desc()))).all()
    return [form_out(f) for f in rows]


@app.get("/api/forms/{form_id}")
async def get_form(form_id: str, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    return form_out(await owned(session, PrefilledForm, form_id, user, "Form"))


@app.patch("/api/forms/{form_id}")
async def update_form(form_id: str, payload: FormValues, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    form = await owned(session, PrefilledForm, form_id, user, "Form")
    fields = []
    for f in form.fields:
        if f["key"] in payload.values:
            v = (payload.values[f["key"]] or "").strip()[:300] or None
            f = {**f, "value": v, "status": "filled" if v else "missing", "source": None if v else f.get("source")}
            f["edited"] = True
        fields.append(f)
    form.fields = fields  # reassign: JSON columns only save on assignment
    session.add(form)
    await session.commit()
    await session.refresh(form)
    return form_out(form)


async def _passport_verified(session: AsyncSession, user: User) -> bool:
    rows = (await session.exec(select(DocumentAnalysis).where(DocumentAnalysis.user_id == user.id, DocumentAnalysis.document_kind == "passport"))).all()
    return any(a.normalized.get("mrz_verified") for a in rows)


@app.get("/api/forms/{form_id}/official.pdf")
async def form_official_pdf(form_id: str, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    """The official form with the values written in, ready to print and sign."""
    form = await owned(session, PrefilledForm, form_id, user, "Form")
    data, not_placed = await form_service.filled_official(form)
    if data is None:
        raise HTTPException(404, "There's no printable official form for this application; download the data sheet instead.")
    return Response(content=data, media_type="application/pdf", headers={
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(form_pdf.safe_filename(form.title))}.pdf",
        "X-Unplaced-Fields": ",".join(not_placed),
    })


@app.get("/api/forms/{form_id}/datasheet.pdf")
async def form_datasheet_pdf(form_id: str, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    """Every field, its value and where it came from: for online forms such as Enter Hungary."""
    form = await owned(session, PrefilledForm, form_id, user, "Form")
    j = await session.get(Journey, form.journey_id) if form.journey_id else None
    data = form_service.datasheet(form, j.title if j else None, await _passport_verified(session, user))
    return Response(content=data, media_type="application/pdf", headers={
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(form_pdf.safe_filename(form.title + ' data sheet'))}.pdf",
    })


@app.delete("/api/forms/{form_id}", status_code=204)
async def delete_form(form_id: str, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    form = await owned(session, PrefilledForm, form_id, user, "Form")
    await session.delete(form)
    await session.commit()


@app.get("/api/guidelines/coverage")
async def guideline_coverage(user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    return await guideline_store.coverage(session)


# --- JOURNEYS ---

@app.get("/api/journeys")
async def list_journeys(user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    rows = (await session.exec(select(Journey).where(Journey.user_id == user.id).order_by(Journey.updated_at.desc()))).all()
    return [await journey_svc.summary(session, j) for j in rows]


@app.get("/api/journeys/{journey_id}")
async def get_journey(journey_id: str, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    j = await owned(session, Journey, journey_id, user, "Journey")
    return await journey_svc.view(session, user, j)


@app.patch("/api/journeys/{journey_id}")
async def update_journey(journey_id: str, payload: JourneyPatch, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    j = await owned(session, Journey, journey_id, user, "Journey")
    changes = payload.model_dump(exclude_unset=True)
    if "status" in changes:
        journey_svc.set_status(j, changes["status"])
    if "title" in changes:
        j.title = changes["title"].strip()
    if "travel_date" in changes or "stay_days" in changes:
        if "travel_date" in changes:
            j.travel_date = changes["travel_date"]
        if "stay_days" in changes:
            j.stay_days = changes["stay_days"]
        await journey_svc.reschedule(session, j)
    j.updated_at = utcnow()
    session.add(j)
    await session.commit()
    return await journey_svc.view(session, user, j)


@app.delete("/api/journeys/{journey_id}", status_code=204)
async def delete_journey(journey_id: str, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    """Deletes the journey and its pathway; conversations, forms and payments are kept but unlinked."""
    j = await owned(session, Journey, journey_id, user, "Journey")
    await session.execute(delete(Task).where(Task.journey_id == j.id))
    for model in (ChatSession, PrefilledForm, Payment):
        for row in (await session.exec(select(model).where(model.journey_id == j.id))).all():
            row.journey_id = None
            session.add(row)
    for child in (await session.exec(select(Journey).where(Journey.parent_id == j.id))).all():
        child.parent_id = j.parent_id
        session.add(child)
    await session.flush()
    await session.delete(j)
    await session.commit()


@app.post("/api/journeys/{journey_id}/forms/{form_key}")
async def prefill_journey_form(journey_id: str, form_key: str, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    j = await owned(session, Journey, journey_id, user, "Journey")
    form, error = await journey_svc.prefill_form(session, user, j, form_key)
    if error:
        raise HTTPException(409, error)
    return form_out(form)


@app.post("/api/journeys/{journey_id}/fees/{fee_key}/pay")
async def pay_journey_fee(journey_id: str, fee_key: str, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    j = await owned(session, Journey, journey_id, user, "Journey")
    payment, error = await journey_svc.pay_fee(session, user, j, fee_key)
    if error:
        raise HTTPException(409, error)
    notify(session, user, "money", "Payment recorded", f"{payment.amount} {payment.currency} for {payment.title}.", f"/app/journeys/{j.id}")
    await session.commit()
    return payment


@app.get("/api/journeys/{journey_id}/calendar.ics")
async def journey_calendar(journey_id: str, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    j = await owned(session, Journey, journey_id, user, "Journey")
    tasks = (await session.exec(select(Task).where(Task.journey_id == j.id).order_by(Task.seq))).all()
    return Response(
        content=journey_svc.ics(j, tasks), media_type="text/calendar",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(j.title)}.ics"},
    )


# --- ADMIN: GUIDELINES PIPELINE ---

@app.get("/api/admin/pipeline")
async def pipeline_status(_: User = Depends(require_admin), session: AsyncSession = Depends(get_session)):
    runs = (await session.exec(select(PipelineRun).order_by(PipelineRun.created_at.desc()).limit(20))).all()
    rows = (await session.exec(select(CountryGuideline))).all()
    entries = []
    for g in sorted(rows, key=lambda r: (r.destination_code, r.purpose, r.origin_code)):
        status, reason = guideline_store.freshness(g)
        entries.append({
            "id": g.id, "destination": g.destination_name, "origin": g.origin_code, "purpose": g.purpose,
            "visa_type": g.visa_type, "managed_by": g.managed_by, "version": g.version, "status": status, "reason": reason,
            "verified_at": g.verified_at, "checked_at": g.checked_at,
            "counts": {"requirements": len(g.requirements), "fees": len(g.fees), "steps": len(g.steps)},
            "sources": g.sources,
        })
    return {"runs": runs, "guidelines": entries, "targets": [t.key for t in TARGETS]}


@app.post("/api/admin/pipeline/runs")
async def queue_pipeline_run(admin: User = Depends(require_admin), session: AsyncSession = Depends(get_session)):
    busy = (await session.exec(select(PipelineRun).where(PipelineRun.status.in_(("queued", "running"))))).first()
    if busy:
        raise HTTPException(409, "A pipeline run is already queued or running.")
    run = PipelineRun(trigger="manual", requested_by=admin.email)
    session.add(run)
    await session.commit()
    await session.refresh(run)
    return run


# --- HEALTH ---

@app.get("/api/health")
async def health(response: Response, session: AsyncSession = Depends(get_session)):
    checks = {}
    try:
        await session.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception as e:
        checks["database"] = f"error: {type(e).__name__}"
    try:
        await StorageService.ensure_bucket_exists()
        checks["storage"] = "ok"
    except Exception as e:
        checks["storage"] = f"error: {type(e).__name__}"
    checks["ai_provider"] = agent_llm.provider()
    ok = all(v == "ok" for k, v in checks.items() if k in ("database", "storage"))
    response.status_code = 200 if ok else 503
    return {"status": "ok" if ok else "degraded", "checks": checks}

# --- EXPLORE (visa map) ---

CODE = r"^[A-Z]{2}$"
PURPOSE = r"^(tourism|study|work|job_search|family)$"


async def travel_profile(session: AsyncSession, user: User, origin: Optional[str], residence: Optional[str], purpose: Optional[str]) -> dict:
    """Passport, residence and purpose: the query overrides the profile; an empty profile falls back to the analysed passport."""
    source = "chosen" if origin else "none"
    if not origin and user.nationality_code:
        origin, source = user.nationality_code, "profile"
    if not origin:
        analyses = (await session.exec(
            select(DocumentAnalysis)
            .where(DocumentAnalysis.user_id == user.id, DocumentAnalysis.status == "done", DocumentAnalysis.document_kind == "passport")
            .order_by(DocumentAnalysis.analyzed_at.desc())
        )).all()
        for a in analyses:
            if code := explore.alpha2(a.normalized.get("nationality")):
                origin, source = code, "passport"
                break
    if not origin and (code := explore.alpha2(user.citizenship)):
        origin, source = code, "citizenship"
    # residence="" in the query means "no residence permit" even if the profile has one.
    residence = user.residence_code if residence is None else residence
    return {"origin": origin, "origin_source": source, "residence": residence or None, "purpose": purpose or user.travel_purpose or "tourism"}


@app.get("/api/explore/map")
async def explore_map(
    origin: Optional[str] = Query(None, pattern=CODE),
    residence: Optional[str] = Query(None, pattern=r"^([A-Z]{2})?$"),
    purpose: Optional[str] = Query(None, pattern=PURPOSE),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    profile = await travel_profile(session, user, origin, residence, purpose)
    countries = await explore.decisions(session, profile["origin"], profile["residence"], profile["purpose"])
    return {**profile, "source": visa_matrix.SOURCE, "passports": await visa_matrix.passports(session), "countries": countries}


@app.get("/api/explore/alternatives")
async def explore_alternatives(
    instead_of: Optional[str] = Query(None, pattern=CODE, description="Destination the user can't easily go to"),
    region: Optional[str] = Query(None, pattern=r"^(Africa|Americas|Asia|Europe|Oceania)$"),
    origin: Optional[str] = Query(None, pattern=CODE),
    residence: Optional[str] = Query(None, pattern=r"^([A-Z]{2})?$"),
    purpose: Optional[str] = Query(None, pattern=PURPOSE),
    limit: int = Query(8, ge=1, le=30),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Easier destinations than `instead_of` (visa-free first, then nearest), or the easiest overall."""
    profile = await travel_profile(session, user, origin, residence, purpose)
    rows = await explore.decisions(session, profile["origin"], profile["residence"], profile["purpose"])
    target = next((r for r in rows if r["code"] == instead_of), None) if instead_of else None
    found = explore.alternatives(rows, instead_of, profile["origin"], region, limit=limit)
    return {**profile, "instead_of": target, "alternatives": found, "source": visa_matrix.SOURCE}


@app.get("/api/explore/countries/{code}")
async def explore_country(
    code: str,
    origin: Optional[str] = Query(None, pattern=CODE),
    residence: Optional[str] = Query(None, pattern=r"^([A-Z]{2})?$"),
    purpose: Optional[str] = Query(None, pattern=PURPOSE),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    code = code.upper()
    profile = await travel_profile(session, user, origin, residence, purpose)
    o = profile["origin"]
    matrix = (await visa_matrix.for_origin(session, o)).get(code) if o else None
    rows = (await session.exec(select(CountryGuideline).where(CountryGuideline.destination_code == code))).all()
    g = explore.pick_guideline(list(rows), code, o, profile["purpose"])
    current = bool(g) and guideline_store.freshness(g)[0] == "current"
    d = explore.decide(code, o, profile["residence"], profile["purpose"], matrix, g, current)
    favorite = (await session.exec(select(FavoriteDestination).where(FavoriteDestination.user_id == user.id, FavoriteDestination.country_code == code))).first()
    return {
        **profile,
        "decision": d.as_dict(),
        "guideline": explore.guideline_detail(g) if g else None,
        "indicative": {"category": matrix.category, "stay_days": matrix.stay_days, "raw": matrix.raw} if matrix else None,
        "source": visa_matrix.SOURCE,
        "favorite": favorite is not None,
    }


@app.get("/api/explore/favorites")
async def list_favorites(user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    rows = (await session.exec(select(FavoriteDestination).where(FavoriteDestination.user_id == user.id).order_by(FavoriteDestination.created_at.desc()))).all()
    return [r.country_code for r in rows]


@app.post("/api/explore/favorites", status_code=204)
async def add_favorite(payload: FavoriteCreate, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    exists = (await session.exec(select(FavoriteDestination).where(FavoriteDestination.user_id == user.id, FavoriteDestination.country_code == payload.country_code))).first()
    if not exists:
        session.add(FavoriteDestination(user_id=user.id, country_code=payload.country_code))
        await session.commit()


@app.delete("/api/explore/favorites/{code}", status_code=204)
async def remove_favorite(code: str, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    await session.execute(delete(FavoriteDestination).where(FavoriteDestination.user_id == user.id, FavoriteDestination.country_code == code.upper()))
    await session.commit()
