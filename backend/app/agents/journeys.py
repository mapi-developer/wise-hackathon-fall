"""
Journeys: the plan a user builds with the assistant and then walks through.

Stored: the journey and its pathway (tasks with journey_id). Computed live, in code, every
time it is read: which documents are satisfied, the financial overview, and what can be
automated. Used by the agent tools and the API alike, so both always agree.
"""
from __future__ import annotations

import math
from datetime import date, timedelta
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import or_
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.agents import guidelines, rules
from app.models import (
    ChatSession, CountryGuideline, Document, DocumentAnalysis, Journey, Payment, PrefilledForm, Task, User, utcnow,
)

STATUSES = ("planning", "active", "completed", "archived")
CATEGORY_FOR_KIND = {
    "passport": "Passport", "insurance": "Insurance", "bank_statement": "Finances", "accommodation": "Housing",
    "enrolment": "Education", "permit": "Visa or permit",
}
# Who to ask for a document the user can't produce themselves.
REQUEST_FROM = {
    "enrolment": "your university's registrar",
    "employment_contract": "your employer's HR team",
    "invitation": "your host",
    "accommodation": "your landlord or hotel",
}


async def user_docs(session: AsyncSession, user: User) -> list[rules.UserDoc]:
    docs = (await session.exec(select(Document).where(Document.user_id == user.id))).all()
    analyses = {a.document_id: a for a in (await session.exec(select(DocumentAnalysis).where(DocumentAnalysis.user_id == user.id))).all()}
    out = []
    for d in docs:
        a = analyses.get(d.id)
        n = a.normalized if a and a.status == "done" else {}
        out.append(rules.UserDoc(
            id=d.id, title=d.title, category=d.category,
            kind=a.document_kind if a and a.status == "done" else None,
            expiry_date=n.get("expiry_date") or (d.expires_on.isoformat() if d.expires_on else None),
            issue_date=n.get("issue_date"), issues=a.issues if a else [],
            amount=n.get("amount"), currency=n.get("currency"),
        ))
    return out


def _due(travel: Optional[date], days_before: Optional[int]) -> Optional[date]:
    if travel is None or days_before is None:
        return None
    return max(date.today(), travel - timedelta(days=days_before))


def _collect_offset(g: CountryGuideline) -> Optional[int]:
    return next((s.get("days_before_travel") for s in g.steps if s.get("category") == "Documents" and s.get("days_before_travel")), None)


def pathway_tasks(user: User, j: Journey, g: CountryGuideline) -> list[Task]:
    """Documents to gather first, then the application steps in order."""
    tasks, seq = [], 0
    for r in g.requirements:
        if not r.get("mandatory", True):
            continue
        tasks.append(Task(
            user_id=user.id, journey_id=j.id, source="agent", kind="requirement", seq=seq, category="Documents",
            title=f"Get: {r['title']}", description=r.get("description"), requirement_key=r["key"],
            due_date=_due(j.travel_date, _collect_offset(g)),
        ))
        seq += 1
    for s in g.steps:
        tasks.append(Task(
            user_id=user.id, journey_id=j.id, source="agent", kind="step", seq=seq, category=s.get("category", "Journey"),
            title=s["title"], description=s.get("description"), requirement_key=f"step:{s['key']}",
            due_date=_due(j.travel_date, s.get("days_before_travel")),
        ))
        seq += 1
    return tasks


async def create(session: AsyncSession, user: User, g: CountryGuideline, origin: str, travel: Optional[date],
                 stay_days: Optional[int], title: Optional[str] = None, parent_id: Optional[str] = None,
                 chat_id: Optional[str] = None) -> Journey:
    j = Journey(
        user_id=user.id, parent_id=parent_id, chat_id=chat_id, origin_code=origin, destination_code=g.destination_code,
        destination_name=g.destination_name, purpose=g.purpose, visa_type=g.visa_type,
        guideline_id=g.id, guideline_version=g.version, travel_date=travel, stay_days=stay_days,
        title=title or f"{g.destination_name} · {g.purpose.replace('_', ' ')}",
    )
    session.add(j)
    await session.flush()
    session.add_all(pathway_tasks(user, j, g))
    await session.commit()
    await session.refresh(j)
    return j


async def reschedule(session: AsyncSession, j: Journey) -> None:
    """Recompute due dates of open steps after the travel date changed."""
    g = await session.get(CountryGuideline, j.guideline_id) if j.guideline_id else None
    if not g:
        return
    offsets = {f"step:{s['key']}": s.get("days_before_travel") for s in g.steps}
    collect = _collect_offset(g)
    for t in (await session.exec(select(Task).where(Task.journey_id == j.id, Task.done == False))).all():  # noqa: E712
        if t.kind == "step":
            t.due_date = _due(j.travel_date, offsets.get(t.requirement_key))
        elif t.kind == "requirement":
            t.due_date = _due(j.travel_date, collect)
        session.add(t)


def set_status(j: Journey, status: str) -> None:
    if status not in STATUSES:
        raise ValueError(f"status must be one of {STATUSES}")
    j.status = status
    j.completed_at = utcnow() if status == "completed" else None
    j.updated_at = utcnow()


def _money_sum(amounts: list[tuple[str, str]]) -> dict[str, str]:
    out: dict[str, Decimal] = {}
    for amount, cur in amounts:
        out[cur] = out.get(cur, Decimal("0")) + Decimal(amount)
    return {c: str(v.quantize(Decimal("0.01"))) for c, v in sorted(out.items())}


def finances(j: Journey, g: Optional[CountryGuideline], user: User, payments: list[Payment]) -> dict[str, Any]:
    fees = rules.sum_fees(g.fees) if g else {"items": [], "mandatory_totals": {}, "amounts_not_fixed": []}
    paid = _money_sum([(p.amount or str(p.amount_eur), p.currency or "EUR") for p in payments])
    remaining = {}
    for cur, total in fees["mandatory_totals"].items():
        left = Decimal(total) - Decimal(paid.get(cur, "0"))
        remaining[cur] = str(max(left, Decimal("0")).quantize(Decimal("0.01")))
    funds = None
    for r in (g.requirements if g else []):
        c = r.get("constraints") or {}
        if c.get("min_amount") and c.get("min_amount_currency"):
            need = Decimal(c["min_amount"])
            have = Decimal(user.savings_eur)
            comparable = c["min_amount_currency"] == "EUR"
            funds = {
                "requirement": r["title"], "required": str(need), "currency": c["min_amount_currency"],
                "savings_eur": str(have), "covered": (have >= need) if comparable else None,
                "short_by": str(max(need - have, Decimal(0))) if comparable else None,
            }
            break
    months = math.ceil(j.stay_days / 30) if j.stay_days else None
    living = str(Decimal(user.monthly_budget_eur * months)) if months else None
    return {
        "fees": fees, "paid": paid, "remaining": remaining, "proof_of_funds": funds,
        "stay_months": months, "monthly_budget_eur": user.monthly_budget_eur, "living_budget_eur": living,
    }


def automation(j: Journey, g: Optional[CountryGuideline], gap: Optional[dict], forms: list[PrefilledForm],
               payments: list[Payment], tasks: list[Task]) -> list[dict[str, Any]]:
    """What the platform can do for the user on this journey, and what's already done."""
    out: list[dict[str, Any]] = []
    if not g:
        return out
    by_form = {f.form_key: f for f in forms}
    for f in g.forms:
        done = by_form.get(f["key"])
        out.append({"kind": "prefill", "key": f["key"], "title": f"Prefill: {f['title']}", "done": bool(done),
                    "form_id": done.id if done else None})
    paid_keys = {p.fee_key for p in payments}
    # Non-mandatory fees are alternatives (one per way of applying or applicant group): once one
    # is paid, the others aren't needed.
    optional = [f for f in g.fees if not f.get("mandatory", True)]
    paid_alternative = any(f["key"] in paid_keys for f in optional)
    for fee in g.fees:
        if not fee.get("amount"):
            continue
        is_alt = not fee.get("mandatory", True)
        if is_alt and paid_alternative and fee["key"] not in paid_keys:
            continue
        out.append({"kind": "pay", "key": fee["key"], "title": f"Pay {fee['title']}", "amount": fee["amount"],
                    "currency": fee["currency"], "note": fee.get("note"), "done": fee["key"] in paid_keys})
    if any(t.due_date and not t.done for t in tasks):
        out.append({"kind": "calendar", "key": "calendar", "title": "Add the deadlines to your calendar", "done": False})
    reqs = {r["key"]: r for r in g.requirements}
    for item in (gap or {}).get("requirements", []):
        if item["status"] == "satisfied" or not item["mandatory"]:
            continue
        kind = reqs.get(item["key"], {}).get("doc_kind")
        if kind in REQUEST_FROM:
            out.append({
                "kind": "email", "key": f"request:{item['key']}", "title": f"Ask {REQUEST_FROM[kind]} for: {item['title']}",
                "subject": f"Request: {item['title']} for my {g.visa_type} application",
                "body": (f"Hello,\n\nI am applying for a {g.visa_type} in {g.destination_name} and need the following "
                         f"document: {item['title']}.\n{reqs[item['key']].get('description') or ''}\n\nCould you please "
                         "send it to me? Thank you.\n"),
                "done": False,
            })
        out.append({"kind": "upload", "key": f"upload:{item['key']}", "title": f"Upload: {item['title']}",
                    "category": CATEGORY_FOR_KIND.get(kind, "Other"), "done": False})
    return out


async def view(session: AsyncSession, user: User, j: Journey) -> dict[str, Any]:
    g = await session.get(CountryGuideline, j.guideline_id) if j.guideline_id else None
    status, reason = guidelines.freshness(g) if g else ("missing", "no guideline")
    tasks = (await session.exec(select(Task).where(Task.journey_id == j.id).order_by(Task.seq, Task.created_at))).all()
    forms = (await session.exec(select(PrefilledForm).where(PrefilledForm.journey_id == j.id).order_by(PrefilledForm.created_at.desc()))).all()
    payments = (await session.exec(select(Payment).where(Payment.journey_id == j.id))).all()
    # Conversations about it now, and the one it was planned in (which may have moved on to another journey).
    about = or_(ChatSession.journey_id == j.id, ChatSession.id == j.chat_id) if j.chat_id else ChatSession.journey_id == j.id
    chats = (await session.exec(
        select(ChatSession).where(ChatSession.user_id == j.user_id, about).order_by(ChatSession.updated_at.desc())
    )).all()
    children = (await session.exec(select(Journey).where(Journey.parent_id == j.id))).all()
    parent = await session.get(Journey, j.parent_id) if j.parent_id else None

    gap = None
    if g:
        gap = rules.check_requirements(g.requirements, await user_docs(session, user), j.travel_date, j.stay_days)
        # A document that is now on file ticks its pathway step; un-ticking stays the user's call.
        satisfied = {r["key"] for r in gap["requirements"] if r["status"] == "satisfied"}
        for t in tasks:
            if t.kind == "requirement" and t.requirement_key in satisfied and not t.done:
                t.done, t.done_at = True, utcnow()
                session.add(t)
        await session.commit()

    req_by_key = {r["key"]: r for r in (g.requirements if g else [])}
    for item in (gap or {}).get("requirements", []):
        ev = req_by_key.get(item["key"], {}).get("evidence")
        item["source_url"] = ev.get("url") if ev else None

    done = sum(1 for t in tasks if t.done)
    return {
        "id": j.id, "title": j.title, "status": j.status, "summary": j.summary,
        "origin_code": j.origin_code, "destination_code": j.destination_code, "destination_name": j.destination_name,
        "purpose": j.purpose, "visa_type": j.visa_type, "travel_date": j.travel_date, "stay_days": j.stay_days,
        "trip_end": (j.travel_date + timedelta(days=j.stay_days)) if j.travel_date and j.stay_days else None,
        "created_at": j.created_at, "updated_at": j.updated_at, "completed_at": j.completed_at,
        "guideline": {
            "status": status, "reason": reason, "verified_at": g.verified_at if g else None,
            "summary": g.summary if g else None, "processing_days_max": g.processing_days_max if g else None,
            "max_stay_days": g.max_stay_days if g else None, "sources": g.sources if g else [],
        },
        "progress": {"done": done, "total": len(tasks)},
        "steps": [{
            "id": t.id, "title": t.title, "description": t.description, "kind": t.kind, "category": t.category,
            "due_date": t.due_date, "done": t.done, "done_at": t.done_at,
        } for t in tasks],
        "requirements": (gap or {}).get("requirements", []),
        "finances": finances(j, g, user, payments),
        "automation": automation(j, g, gap, forms, payments, tasks),
        "forms": [{"id": f.id, "title": f.title, "created_at": f.created_at,
                   "missing": sum(1 for x in f.fields if x["status"] == "missing")} for f in forms],
        "chats": [{"id": c.id, "title": c.title, "updated_at": c.updated_at, "created_here": c.id == j.chat_id} for c in chats],
        "parent": {"id": parent.id, "title": parent.title} if parent else None,
        "continuations": [{"id": c.id, "title": c.title, "status": c.status} for c in children],
    }


async def summary(session: AsyncSession, j: Journey) -> dict[str, Any]:
    tasks = (await session.exec(select(Task).where(Task.journey_id == j.id))).all()
    nxt = sorted((t for t in tasks if not t.done), key=lambda t: (t.due_date or date.max, t.seq))
    return {
        "id": j.id, "title": j.title, "status": j.status, "destination_code": j.destination_code,
        "destination_name": j.destination_name, "purpose": j.purpose, "visa_type": j.visa_type,
        "travel_date": j.travel_date, "stay_days": j.stay_days, "parent_id": j.parent_id,
        "progress": {"done": sum(1 for t in tasks if t.done), "total": len(tasks)},
        "next_step": {"title": nxt[0].title, "due_date": nxt[0].due_date} if nxt else None,
        "updated_at": j.updated_at,
    }


def ics(j: Journey, tasks: list[Task]) -> str:
    """An iCalendar file with one all-day event per open step that has a due date."""
    def esc(s: str) -> str:
        return s.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")

    stamp = utcnow().strftime("%Y%m%dT%H%M%SZ")
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Unbound//Journeys//EN", "CALSCALE:GREGORIAN",
             f"X-WR-CALNAME:{esc(j.title)}"]
    for t in tasks:
        if not t.due_date or t.done:
            continue
        lines += [
            "BEGIN:VEVENT", f"UID:{t.id}@unbound", f"DTSTAMP:{stamp}",
            f"DTSTART;VALUE=DATE:{t.due_date.strftime('%Y%m%d')}",
            f"DTEND;VALUE=DATE:{(t.due_date + timedelta(days=1)).strftime('%Y%m%d')}",
            f"SUMMARY:{esc(t.title)}", f"DESCRIPTION:{esc((t.description or '') + ' (' + j.title + ')')}",
            "BEGIN:VALARM", "TRIGGER:-P1D", "ACTION:DISPLAY", f"DESCRIPTION:{esc(t.title)}", "END:VALARM",
            "END:VEVENT",
        ]
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines) + "\r\n"


async def prefill_form(session: AsyncSession, user: User, j: Journey, form_key: str) -> tuple[Optional[PrefilledForm], Optional[str]]:
    """Fill a form template from the profile, the best analysed passport and the journey. Nothing is guessed."""
    g = await session.get(CountryGuideline, j.guideline_id) if j.guideline_id else None
    if not g:
        return None, "This journey has no guideline to take the form from."
    status, _ = guidelines.freshness(g)
    if status != "current":
        return None, f"Information about {g.destination_name} is being updated; forms will be available again soon."
    template = next((f for f in g.forms if f["key"] == form_key), None)
    if not template:
        return None, f"Unknown form. Available: {[f['key'] for f in g.forms]}"

    passport: dict = {}
    best = None
    by_kind: dict[str, DocumentAnalysis] = {}
    docs = (await session.exec(select(DocumentAnalysis).where(DocumentAnalysis.user_id == user.id, DocumentAnalysis.status == "done"))).all()
    for a in docs:
        if a.document_kind == "passport":
            score = (bool(a.normalized.get("mrz_verified")), a.normalized.get("expiry_date") or "")
            if best is None or score > best:  # prefer MRZ-verified, then the latest expiry
                best, passport = score, a.normalized
        elif a.document_kind and (a.document_kind not in by_kind or (a.analyzed_at or utcnow()) > (by_kind[a.document_kind].analyzed_at or utcnow())):
            by_kind[a.document_kind] = a  # the most recently analysed document of each kind
    parts = user.full_name.split()
    sources = {
        "profile": {
            "full_name": user.full_name, "first_name": user.first_name, "surname": parts[-1] if len(parts) > 1 else None,
            "email": user.email, "citizenship": user.citizenship, "address": user.address,
            "residence_status": user.residence_status, "studies": user.studies,
        },
        "passport": passport,
        **{kind: a.normalized for kind, a in by_kind.items()},
        "plan": {
            "destination_name": j.destination_name, "purpose": j.purpose, "visa_type": j.visa_type,
            "travel_date": j.travel_date.isoformat() if j.travel_date else None, "stay_days": j.stay_days,
            "departure_date": (j.travel_date + timedelta(days=j.stay_days)).isoformat() if j.travel_date and j.stay_days else None,
        },
    }
    from app.forms.templates import fields_for  # code-defined fields win over the stored copy

    template = {**template, "fields": fields_for(template["key"], template.get("fields", []))}
    form = PrefilledForm(user_id=user.id, journey_id=j.id, form_key=template["key"], title=template["title"],
                         official_url=template.get("official_url"), fields=rules.fill_form(template, sources))
    session.add(form)
    await session.commit()
    await session.refresh(form)
    return form, None


async def pay_fee(session: AsyncSession, user: User, j: Journey, fee_key: str) -> tuple[Optional[Payment], Optional[str]]:
    """Simulated Wise payment of a fixed guideline fee: recorded as paid, no money moves."""
    g = await session.get(CountryGuideline, j.guideline_id) if j.guideline_id else None
    fee = next((f for f in (g.fees if g else []) if f["key"] == fee_key), None)
    if not fee or not fee.get("amount"):
        return None, "This fee has no fixed amount to pay."
    existing = (await session.exec(select(Payment).where(Payment.journey_id == j.id, Payment.fee_key == fee_key))).first()
    if existing:
        return None, "This fee is already paid."
    amount = Decimal(fee["amount"])
    p = Payment(user_id=user.id, journey_id=j.id, fee_key=fee_key, title=f"{fee['title']} ({j.title})",
                amount=str(amount), currency=fee["currency"],
                amount_eur=int(amount) if fee["currency"] == "EUR" else 0, status="paid")
    session.add(p)
    await session.commit()
    await session.refresh(p)
    return p, None
