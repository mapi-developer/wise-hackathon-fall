"""
Integration tests against the real database (run inside the backend container):
    docker exec -w /app unbound_backend python -m pytest -q tests/

Each test makes its own user and guideline and deletes everything it created.
No model is called: the pipeline's model steps are replaced with scripted results.
"""
import asyncio
import uuid
from datetime import date, timedelta

import pytest

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")
from sqlmodel import delete, select

from app.agents import journeys, tools
from app.agents.rules import normalize_extraction
from app.core.database import async_session_maker, engine, init_db
from app.models import (
    ChatSession, CountryGuideline, Document, DocumentAnalysis, Journey, Payment, PipelineRun, PrefilledForm,
    SourceSnapshot, Task, User, utcnow,
)
from app.pipeline import run as pipeline
from app.pipeline.fetch import Page
from app.pipeline.targets import SCHENGEN_FORM, Target

DEST = "ZZ"  # test-only destination code, never real data


def run(coro):
    """Each test gets its own event loop; pooled connections must not outlive it."""
    async def wrapped():
        try:
            return await coro
        finally:
            await engine.dispose()
    return asyncio.run(wrapped())


async def _cleanup(session, user_id=None):
    if user_id:
        for m in (PrefilledForm, Payment, Task, DocumentAnalysis, Document, ChatSession):
            await session.execute(delete(m).where(m.user_id == user_id))
        await session.execute(delete(Journey).where(Journey.user_id == user_id))
        await session.execute(delete(User).where(User.id == user_id))
    await session.execute(delete(CountryGuideline).where(CountryGuideline.destination_code == DEST))
    await session.commit()


def _guideline(verified=True, **kw):
    return CountryGuideline(
        destination_code=DEST, destination_name="Testland", origin_code="*", purpose="tourism", visa_type="Test visa",
        summary="Test", managed_by="pipeline",
        requirements=[
            {"key": "passport", "title": "Valid passport", "description": "", "doc_kind": "passport", "mandatory": True,
             "constraints": {"valid_months_after_stay": 3}, "evidence": {"url": "https://oif.gov.hu/x", "quote": "passport"}},
            {"key": "insurance", "title": "Travel insurance", "description": "", "doc_kind": "insurance", "mandatory": True,
             "constraints": {"min_amount": "30000.00", "min_amount_currency": "EUR"}},
            {"key": "accommodation", "title": "Accommodation", "description": "", "doc_kind": "accommodation", "mandatory": True, "constraints": {}},
        ],
        fees=[{"key": "visa_fee", "title": "Visa fee", "amount": "90.00", "currency": "EUR", "mandatory": True},
              {"key": "service", "title": "Service fee", "amount": None, "currency": "EUR", "mandatory": True}],
        steps=[{"key": "book", "title": "Book an appointment", "description": "", "days_before_travel": 45, "category": "Appointment"},
               {"key": "submit", "title": "Submit", "description": "", "days_before_travel": 30, "category": "Journey"}],
        forms=[SCHENGEN_FORM], sources=[{"title": "t", "url": "https://oif.gov.hu/x"}],
        verified_at=utcnow() if verified else None, **kw,
    )


@pytest.fixture(scope="module", autouse=True)
def schema():
    run(init_db())


async def _setup(session, verified=True):
    await _cleanup(session)
    u = User(google_sub=f"test-{uuid.uuid4().hex}", email="t@test.local", full_name="Anna Eriksson", first_name="Anna",
             savings_eur=5000, monthly_budget_eur=900)
    g = _guideline(verified)
    session.add_all([u, g])
    await session.commit()
    raw = {"document_kind": "passport", "surname": "Eriksson", "given_names": "Anna", "document_number": "751234567",
           "date_of_birth": "12.08.1994", "issue_date": "10.01.2020", "expiry_date": "10.01.2030", "mrz": None}
    norm, issues = normalize_extraction(raw)
    d = Document(user_id=u.id, title="Passport", category="Passport", file_name="p.pdf", content_type="application/pdf",
                 size_bytes=1, sha256=uuid.uuid4().hex, storage_key="none")
    session.add(d)
    await session.flush()
    session.add(DocumentAnalysis(document_id=d.id, user_id=u.id, status="done", document_kind="passport", raw=raw, normalized=norm, issues=issues))
    chat = ChatSession(user_id=u.id)
    session.add(chat)
    await session.commit()
    return u, g, chat


def test_journey_lifecycle():
    async def go():
        async with async_session_maker() as s:
            u, g, chat = await _setup(s)
            try:
                travel = (date.today() + timedelta(days=90)).isoformat()
                trip = {"destination_code": DEST, "origin_code": "RU", "purpose": "tourism", "travel_date": travel, "stay_days": 10}
                ctx = tools.Context(chat_id=chat.id)
                r, err = await tools.run(s, u, "create_journey", trip, ctx)
                assert not err and r["status"] == "created", r
                jid = r["id"]
                await s.refresh(chat)
                assert chat.journey_id == jid and ctx.journey_id == jid  # conversation linked to the journey

                steps = r["steps"]
                assert [x["title"] for x in steps][:3] == ["Get: Valid passport", "Get: Travel insurance", "Get: Accommodation"]
                assert steps[0]["done"] is True  # the analysed passport satisfies it: ticked automatically
                book = next(x for x in steps if x["title"] == "Book an appointment")
                assert book["due_date"] == (date.fromisoformat(travel) - timedelta(days=45)).isoformat()

                fin = r["finances"]
                assert fin["fees"]["mandatory_totals"] == {"EUR": "90.00"} and fin["fees"]["amounts_not_fixed"] == ["Service fee"]
                assert fin["stay_months"] == 1 and fin["living_budget_eur"] == "900"
                kinds = {a["kind"] for a in r["automation"]}
                assert {"prefill", "pay", "calendar", "upload", "email"} <= kinds

                j = await s.get(Journey, jid)
                p, err = await journeys.pay_fee(s, u, j, "visa_fee")
                assert p and p.amount == "90.00" and p.currency == "EUR"
                assert (await journeys.pay_fee(s, u, j, "visa_fee"))[1]  # can't pay twice
                assert (await journeys.pay_fee(s, u, j, "service"))[1]  # no fixed amount
                view = await journeys.view(s, u, j)
                assert view["finances"]["remaining"] == {"EUR": "0.00"}
                assert next(a for a in view["automation"] if a["kind"] == "pay")["done"]

                r, _ = await tools.run(s, u, "prefill_form", {"journey_id": jid, "form_key": "schengen_application"}, ctx)
                form = await s.get(PrefilledForm, r["form_id"])
                vals = {f["key"]: f["value"] for f in form.fields}
                assert vals["surname"] == "ERIKSSON" and vals["date_of_birth"] == "12-08-1994" and form.journey_id == jid

                step = next(x for x in steps if x["title"] == "Submit")
                r, _ = await tools.run(s, u, "set_step_done", {"journey_id": jid, "step_id": step["id"], "done": True}, ctx)
                assert r["done"] is True

                new_travel = (date.today() + timedelta(days=200)).isoformat()
                await tools.run(s, u, "update_journey", {"journey_id": jid, "travel_date": new_travel, "status": "active"}, ctx)
                view = await journeys.view(s, u, await s.get(Journey, jid))
                book = next(x for x in view["steps"] if x["title"] == "Book an appointment")
                assert book["due_date"] == date.fromisoformat(new_travel) - timedelta(days=45)  # rescheduled
                done_submit = next(x for x in view["steps"] if x["title"] == "Submit")
                assert done_submit["done"]  # done steps keep their state

                await tools.run(s, u, "update_journey", {"journey_id": jid, "status": "completed"}, ctx)
                assert (await s.get(Journey, jid)).completed_at is not None
                await tools.run(s, u, "update_journey", {"journey_id": jid, "status": "active"}, ctx)  # reopen
                assert (await s.get(Journey, jid)).completed_at is None

                r, _ = await tools.run(s, u, "create_journey", {**trip, "title": "Next leg", "continues_journey_id": jid}, tools.Context())
                assert r["parent"]["id"] == jid

                cal = journeys.ics(await s.get(Journey, jid), (await s.exec(select(Task).where(Task.journey_id == jid))).all())
                assert cal.startswith("BEGIN:VCALENDAR") and "Book an appointment" in cal and "Submit" not in cal

                # Out-of-date guideline: the agent gets steps but no rules.
                g.verified_at = utcnow() - timedelta(days=10)
                s.add(g)
                await s.commit()
                r, _ = await tools.run(s, u, "get_journey", {"journey_id": jid}, ctx)
                assert "requirements" not in r and r["rules"]["status"] == "not_up_to_date" and r["steps"]
                r, _ = await tools.run(s, u, "create_journey", trip, ctx)
                assert r["status"] == "not_up_to_date"

                # Another user can't touch it.
                other = User(google_sub=f"test-{uuid.uuid4().hex}", email="o@test.local", full_name="O", first_name="O")
                s.add(other)
                await s.commit()
                r, _ = await tools.run(s, other, "get_journey", {"journey_id": jid}, tools.Context())
                assert r["status"] == "error"
                await s.delete(other)
                await s.commit()
            finally:
                await _cleanup(s, u.id)
    run(go())


class FakeFetcher:
    def __init__(self, pages):
        self.pages = pages

    async def fetch(self, url):
        return self.pages.get(url) or Page(url, url, 404, error="HTTP 404")

    async def resolve(self, url):
        return url


PAGE = ("A kérelemhez csatolni kell: érvényes úti okmány másolatát; a szállás igazolását; a megélhetés fedezetének "
        "igazolását; egészségbiztosítás igazolását. Az eljárás díja 18 000 Ft. ") * 3


def test_several_journeys_in_one_conversation():
    """Plan two journeys at once, refuse a silent duplicate, switch between them, keep the link to the conversation."""
    async def go():
        async with async_session_maker() as s:
            u, g, chat = await _setup(s)
            try:
                trip = {"destination_code": DEST, "origin_code": "RU", "purpose": "tourism"}
                ctx = tools.Context(chat_id=chat.id)
                r, err = await tools.run(s, u, "create_journeys", {"trips": [trip, {**trip, "allow_duplicate": True, "title": "Plan B"}]}, ctx)
                refs = tools.ui_refs(r)
                assert not err and [x["status"] for x in r["journeys"]] == ["created", "created"], r
                assert [x["kind"] for x in refs] == ["journey", "journey"] and "_ui" not in r  # cards never reach the model
                first, second = (x["id"] for x in r["journeys"])
                assert r["journeys"][0]["missing_documents"] == ["Travel insurance", "Accommodation"]
                assert ctx.journey_id == first  # a conversation without a journey takes the first

                r, _ = await tools.run(s, u, "create_journey", trip, ctx)
                assert r["status"] == "exists" and r["journey"]["id"] in (first, second)
                assert len((await s.exec(select(Journey).where(Journey.user_id == u.id))).all()) == 2

                r, _ = await tools.run(s, u, "switch_journey", {"journey_id": second}, ctx)
                await s.refresh(chat)
                assert r["now_working_on"] == second == chat.journey_id == ctx.journey_id
                assert (await tools.run(s, u, "switch_journey", {"journey_id": "not-mine"}, ctx))[0]["status"] == "error"

                # The first journey still lists the conversation it was planned in, though the chat moved on.
                view = await journeys.view(s, u, await s.get(Journey, first))
                assert [(c["id"], c["created_here"]) for c in view["chats"]] == [(chat.id, True)]
            finally:
                await _cleanup(s, u.id)
    run(go())


def test_pipeline_publish_reverify_and_hold(monkeypatch):
    target = Target("zz-tourism", DEST, "Testland", "*", "tourism", "test route", ("https://oif.gov.hu/zz",), (SCHENGEN_FORM,))
    pages = {"https://oif.gov.hu/zz": Page("https://oif.gov.hu/zz", "https://oif.gov.hu/zz", 200, text=PAGE, title="ZZ", content_hash="h1")}
    calls = {"extract": 0}

    def ev(q):
        return {"url": "https://oif.gov.hu/zz", "quote": q}

    good = {
        "applies": True, "visa_type": "Test permit", "summary": "Test",
        "max_stay_days": {"value": None, "evidence": None}, "processing_days_max": {"value": None, "evidence": None},
        "requirements": [
            {"key": "passport", "title": "Passport copy", "description": "", "doc_kind": "passport", "mandatory": True, "evidence": ev("érvényes úti okmány másolatát")},
            {"key": "accommodation", "title": "Accommodation", "description": "", "doc_kind": "accommodation", "mandatory": True, "evidence": ev("a szállás igazolását")},
            {"key": "funds", "title": "Funds", "description": "", "doc_kind": "bank_statement", "mandatory": True, "evidence": ev("a megélhetés fedezetének igazolását")},
            {"key": "insurance", "title": "Insurance", "description": "", "doc_kind": "insurance", "mandatory": True, "evidence": ev("egészségbiztosítás igazolását")},
            {"key": "fake", "title": "Invented", "description": "", "doc_kind": "other", "mandatory": True, "evidence": ev("ez nincs az oldalon sehol")},
        ],
        "fees": [{"key": "fee", "title": "Procedure fee", "amount": "18000", "currency": "HUF", "mandatory": True, "note": None, "evidence": ev("Az eljárás díja 18 000 Ft")}],
        "steps": [],
    }
    script = [good]

    async def fake_extract(t, ps):
        calls["extract"] += 1
        return script.pop(0), None, "fake-model"

    async def fake_discover(t, f, limit=3):
        return [], None

    monkeypatch.setattr(pipeline, "extract", fake_extract)
    monkeypatch.setattr(pipeline, "discover", fake_discover)

    async def go():
        async with async_session_maker() as s:
            await _cleanup(s)
            try:
                async def one_run():
                    r = PipelineRun(trigger="manual")
                    s.add(r)
                    await s.commit()
                    res = await pipeline.process_target(s, r, FakeFetcher(pages), target)
                    return r, res

                r1, res = await one_run()
                assert res["status"] == "published", res
                assert res["verified"] == {"requirements": 4, "fees": 1, "steps": 0}
                assert any("Invented" in d["item"] for d in res["dropped"])
                g = (await s.exec(select(CountryGuideline).where(CountryGuideline.destination_code == DEST))).first()
                assert g.managed_by == "pipeline" and g.verified_at and g.fees[0]["amount"] == "18000.00" and g.forms
                first_verified = g.verified_at

                # Same pages: no model call, quotes re-checked, verified_at refreshed.
                r2, res = await one_run()
                assert res["status"] == "reverified" and calls["extract"] == 1
                await s.refresh(g)
                assert g.verified_at > first_verified

                # Pages changed and the new extraction proves too little: held, old entry kept.
                pages["https://oif.gov.hu/zz"] = Page("https://oif.gov.hu/zz", "https://oif.gov.hu/zz", 200, text=PAGE + " új", title="ZZ", content_hash="h2")
                script.append({**good, "requirements": good["requirements"][:1]})
                r3, res = await one_run()
                assert res["status"] == "held" and "need" in res["reason"]
                await s.refresh(g)
                assert len(g.requirements) == 4 and g.version == 1

                # Source unreachable: target fails, entry untouched.
                pages.clear()
                r4, res = await one_run()
                assert res["status"] == "failed" and res["fetch_errors"]
                for r in (r1, r2, r3, r4):
                    await s.execute(delete(SourceSnapshot).where(SourceSnapshot.run_id == r.id))
                    await s.delete(r)
                await s.commit()
            finally:
                await _cleanup(s)
    run(go())
