import uuid
from datetime import date, datetime, timezone
from typing import Optional

from sqlalchemy import JSON, Column, UniqueConstraint
from sqlmodel import Field, SQLModel


def new_id() -> str:
    return uuid.uuid4().hex


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(SQLModel, table=True):
    __tablename__ = "users"

    id: str = Field(default_factory=new_id, primary_key=True)
    google_sub: str = Field(unique=True, index=True)
    email: str = Field(index=True)
    full_name: str
    first_name: str
    picture_url: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)

    # Filled in by the user on their profile
    citizenship: str = ""
    passport: str = ""
    address: str = ""
    residence_status: str = ""
    studies: str = ""
    monthly_budget_eur: int = 1000
    savings_eur: int = 0
    journey_stage: str = "apply"  # apply, arrive, stay, transition
    # Structured travel profile for the explore map (ISO 3166-1 alpha-2, "" = not set)
    nationality_code: str = ""
    residence_code: str = ""  # country of the user's residence permit
    travel_purpose: str = "tourism"  # tourism, study, work, job_search, family

    notify_push: bool = True
    notify_email: bool = True
    notify_sms: bool = False


class Task(SQLModel, table=True):
    __tablename__ = "tasks"

    id: str = Field(default_factory=new_id, primary_key=True)
    user_id: str = Field(foreign_key="users.id", index=True)
    title: str
    category: str = "Personal"
    due_date: Optional[date] = None
    done: bool = False
    created_at: datetime = Field(default_factory=utcnow)
    source: str = "user"  # user, agent
    # Journey pathway: tasks with a journey_id are its steps, in seq order.
    journey_id: Optional[str] = Field(default=None, foreign_key="journeys.id", index=True)
    kind: str = "personal"  # personal, requirement (a document to get), step (an application step)
    seq: int = 0
    description: Optional[str] = None
    requirement_key: Optional[str] = None
    done_at: Optional[datetime] = None


class Document(SQLModel, table=True):
    __tablename__ = "documents"

    id: str = Field(default_factory=new_id, primary_key=True)
    user_id: str = Field(foreign_key="users.id", index=True)
    title: str
    category: str = "Other"
    file_name: str
    content_type: str
    size_bytes: int
    sha256: str = Field(index=True)
    storage_key: str
    expires_on: Optional[date] = None
    uploaded_at: datetime = Field(default_factory=utcnow)


class Payment(SQLModel, table=True):
    __tablename__ = "payments"

    id: str = Field(default_factory=new_id, primary_key=True)
    user_id: str = Field(foreign_key="users.id", index=True)
    title: str
    amount_eur: int
    status: str = "paid"  # paid, upcoming
    paid_on: date = Field(default_factory=lambda: utcnow().date())
    journey_id: Optional[str] = Field(default=None, foreign_key="journeys.id", index=True)
    fee_key: Optional[str] = None
    # Exact amount in its own currency (decimal string); amount_eur is kept for older rows.
    amount: Optional[str] = None
    currency: str = "EUR"


class Notification(SQLModel, table=True):
    __tablename__ = "notifications"

    id: str = Field(default_factory=new_id, primary_key=True)
    user_id: str = Field(foreign_key="users.id", index=True)
    kind: str  # deadline, money, document, travel
    title: str
    body: str
    href: str
    read: bool = False
    created_at: datetime = Field(default_factory=utcnow)


def json_col(default=list):
    return Field(default_factory=default, sa_column=Column(JSON, nullable=False))


class CountryGuideline(SQLModel, table=True):
    """
    Curated immigration rules the agents are allowed to use. Populated by the
    guidelines pipeline (see app/cli/import_guidelines.py). An entry is usable only
    while it is verified and fresh (app/agents/guidelines.py decides, not the model).
    """
    __tablename__ = "country_guidelines"
    __table_args__ = (UniqueConstraint("destination_code", "origin_code", "purpose"),)

    id: str = Field(default_factory=new_id, primary_key=True)
    destination_code: str = Field(index=True)  # ISO 3166-1 alpha-2
    destination_name: str
    origin_code: str = Field(index=True)  # ISO alpha-2, or "*" for any citizenship
    purpose: str  # tourism, study, work, job_search, family
    visa_type: str
    # visa_free, visa_on_arrival, evisa, visa_required; drives the explore map colour
    entry_type: Optional[str] = None
    summary: str
    max_stay_days: Optional[int] = None
    processing_days_min: Optional[int] = None
    processing_days_max: Optional[int] = None
    requirements: list = json_col()
    fees: list = json_col()
    steps: list = json_col()
    forms: list = json_col()
    sources: list = json_col()
    verified_at: Optional[datetime] = None
    valid_until: Optional[date] = None
    version: int = 1
    updated_at: datetime = Field(default_factory=utcnow)
    # Set by the pipeline: hash of the source pages it was extracted from, last check time.
    managed_by: str = "manual"  # manual, pipeline
    source_hash: Optional[str] = None
    checked_at: Optional[datetime] = None


class DocumentAnalysis(SQLModel, table=True):
    __tablename__ = "document_analyses"

    id: str = Field(default_factory=new_id, primary_key=True)
    document_id: str = Field(foreign_key="documents.id", unique=True, index=True)
    user_id: str = Field(foreign_key="users.id", index=True)
    status: str = "pending"  # pending, done, failed, skipped
    claimed_at: Optional[datetime] = None  # set by the worker that is analysing it
    document_kind: Optional[str] = None
    summary: Optional[str] = None
    raw: dict = json_col(dict)  # what the model read, as printed
    normalized: dict = json_col(dict)  # strict values from app/agents/rules.py
    issues: list = json_col()
    error: Optional[str] = None
    model: Optional[str] = None
    analyzed_at: Optional[datetime] = None


class Journey(SQLModel, table=True):
    """
    A trip or move the user plans with the assistant and then walks through.
    Its pathway is the tasks with this journey_id (ordered by seq); everything
    else (documents needed, finances, automation) is computed live from the
    guideline and the user's data, so it never goes out of date.
    """
    __tablename__ = "journeys"

    id: str = Field(default_factory=new_id, primary_key=True)
    user_id: str = Field(foreign_key="users.id", index=True)
    parent_id: Optional[str] = Field(default=None, foreign_key="journeys.id")  # the leg this one continues
    # The conversation that created it. No foreign key: deleting that conversation keeps the journey.
    chat_id: Optional[str] = Field(default=None, index=True)
    title: str
    origin_code: str
    destination_code: str
    destination_name: str
    purpose: str
    visa_type: str
    guideline_id: Optional[str] = Field(default=None, foreign_key="country_guidelines.id")
    guideline_version: Optional[int] = None
    travel_date: Optional[date] = None
    stay_days: Optional[int] = None
    status: str = "planning"  # planning, active, completed, archived
    summary: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)
    completed_at: Optional[datetime] = None


class PrefilledForm(SQLModel, table=True):
    __tablename__ = "prefilled_forms"

    id: str = Field(default_factory=new_id, primary_key=True)
    user_id: str = Field(foreign_key="users.id", index=True)
    journey_id: Optional[str] = Field(default=None, foreign_key="journeys.id", index=True)
    form_key: str
    title: str
    official_url: Optional[str] = None
    fields: list = json_col()
    created_at: datetime = Field(default_factory=utcnow)


class ChatSession(SQLModel, table=True):
    __tablename__ = "chat_sessions"

    id: str = Field(default_factory=new_id, primary_key=True)
    user_id: str = Field(foreign_key="users.id", index=True)
    title: str = "New conversation"
    journey_id: Optional[str] = Field(default=None, foreign_key="journeys.id", index=True)
    provider: str = "anthropic"  # gemini, anthropic: whose message format the history uses
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class ChatMessage(SQLModel, table=True):
    """
    One API message per row, stored exactly as sent to / received from Claude
    (append-only, so thinking blocks replay unchanged). `display_text` is what the
    UI shows; tool-result turns have none.
    """
    __tablename__ = "chat_messages"

    id: str = Field(default_factory=new_id, primary_key=True)
    session_id: str = Field(foreign_key="chat_sessions.id", index=True)
    seq: int
    role: str  # user, assistant (API roles)
    content: list = json_col()
    display_text: Optional[str] = None
    events: list = json_col()  # tool steps shown in the UI
    created_at: datetime = Field(default_factory=utcnow)


class SourceSnapshot(SQLModel, table=True):
    """An official page as fetched by the pipeline; quotes are verified against this text."""
    __tablename__ = "source_snapshots"

    id: str = Field(default_factory=new_id, primary_key=True)
    run_id: str = Field(foreign_key="pipeline_runs.id", index=True)
    url: str = Field(index=True)
    final_url: str
    found_by: str = "seed"  # seed, search
    status_code: int
    content_hash: Optional[str] = None
    text: str = ""
    error: Optional[str] = None
    fetched_at: datetime = Field(default_factory=utcnow)


class PipelineRun(SQLModel, table=True):
    __tablename__ = "pipeline_runs"

    id: str = Field(default_factory=new_id, primary_key=True)
    trigger: str = "schedule"  # schedule, manual
    status: str = "queued"  # queued, running, done, failed
    requested_by: Optional[str] = None
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=utcnow)
    results: list = json_col()  # one entry per target
    log: list = json_col()
class VisaRequirement(SQLModel, table=True):
    """
    Indicative short-stay entry rules per passport, imported from an open dataset
    (app/services/visa_matrix.py). Shown on the explore map with their source and date;
    verified country_guidelines take precedence over them.
    """
    __tablename__ = "visa_requirements"
    __table_args__ = (UniqueConstraint("origin_code", "destination_code"),)

    id: str = Field(default_factory=new_id, primary_key=True)
    origin_code: str = Field(index=True)  # passport, ISO alpha-2
    destination_code: str = Field(index=True)
    category: str  # visa_free, visa_on_arrival, evisa, eta, visa_required, no_admission
    stay_days: Optional[int] = None
    raw: str  # the dataset value as published
    imported_at: datetime = Field(default_factory=utcnow)


class FavoriteDestination(SQLModel, table=True):
    __tablename__ = "favorite_destinations"
    __table_args__ = (UniqueConstraint("user_id", "country_code"),)

    id: str = Field(default_factory=new_id, primary_key=True)
    user_id: str = Field(foreign_key="users.id", index=True)
    country_code: str
    created_at: datetime = Field(default_factory=utcnow)
