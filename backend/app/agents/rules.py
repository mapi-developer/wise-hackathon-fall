"""
Deterministic rules. No model calls here: everything that touches dates, numbers,
money or legal thresholds is decided by plain code so it is exact and testable.

The document agent only *reads* values off a document (raw strings). This module
normalises them, cross-checks them (MRZ check digits), and the planning tools use it
to compare a user's documents against a guideline's requirements.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any, Iterable, Optional

# --------------------------------------------------------------------- dates

_MONTHS = {
    m: i
    for i, names in enumerate(
        [
            ("jan", "january", "янв", "января"), ("feb", "february", "фев", "февраля"), ("mar", "march", "мар", "марта"),
            ("apr", "april", "апр", "апреля"), ("may", "мая", "май"), ("jun", "june", "июн", "июня"),
            ("jul", "july", "июл", "июля"), ("aug", "august", "авг", "августа"), ("sep", "sept", "september", "сен", "сентября"),
            ("oct", "october", "окт", "октября"), ("nov", "november", "ноя", "ноября"), ("dec", "december", "дек", "декабря"),
        ],
        start=1,
    )
    for m in names
}


@dataclass
class DateResult:
    iso: Optional[str]  # YYYY-MM-DD, or None when it can't be decided
    issue: Optional[str] = None  # why it couldn't be decided


def _valid(y: int, m: int, d: int) -> Optional[date]:
    try:
        return date(y, m, d)
    except ValueError:
        return None


def normalize_date(raw: Optional[str]) -> DateResult:
    """
    Parse a date as printed on a document into ISO 8601.

    Accepted: ISO (2031-03-12), day-first with . or - (12.03.2031, 12-03-2031),
    textual months in English or Russian (12 MAR 2031, 12 марта 2031), and
    slash dates only when unambiguous (13/03/2031). An ambiguous slash date such as
    03/04/2031 is *not* guessed; it is reported so a person or the MRZ can resolve it.
    """
    if raw is None or not str(raw).strip():
        return DateResult(None, "missing")
    s = re.sub(r"\s+", " ", str(raw).strip().lower())

    m = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if m:
        d = _valid(int(m[1]), int(m[2]), int(m[3]))
        return DateResult(d.isoformat()) if d else DateResult(None, f"not a real date: {raw}")

    # Dots and dashes are day-first across Europe and on Russian documents.
    m = re.fullmatch(r"(\d{1,2})[.\-](\d{1,2})[.\-](\d{4})", s)
    if m:
        d = _valid(int(m[3]), int(m[2]), int(m[1]))
        return DateResult(d.isoformat()) if d else DateResult(None, f"not a real date: {raw}")

    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4})", s)
    if m:
        a, b, y = int(m[1]), int(m[2]), int(m[3])
        if a > 12 and b <= 12:
            d = _valid(y, b, a)
        elif b > 12 and a <= 12:
            d = _valid(y, a, b)
        elif a == b:
            d = _valid(y, a, b)
        else:
            return DateResult(None, f"ambiguous day/month order: {raw}")
        return DateResult(d.isoformat()) if d else DateResult(None, f"not a real date: {raw}")

    m = re.fullmatch(r"(\d{1,2})[ .\-/]?([a-zа-яё]+)\.?[ .\-/]?(\d{4})", s)
    if m and m[2] in _MONTHS:
        d = _valid(int(m[3]), _MONTHS[m[2]], int(m[1]))
        return DateResult(d.isoformat()) if d else DateResult(None, f"not a real date: {raw}")

    return DateResult(None, f"unrecognised date format: {raw}")


def add_months(d: date, months: int) -> date:
    y, m = divmod(d.month - 1 + months, 12)
    y, m = d.year + y, m + 1
    for day in (d.day, 30, 29, 28):
        if (r := _valid(y, m, day)) is not None:
            return r
    raise ValueError("unreachable")


# ----------------------------------------------------------------------- MRZ

_MRZ_WEIGHTS = (7, 3, 1)


def mrz_check_digit(field_: str) -> str:
    total = 0
    for i, ch in enumerate(field_):
        if ch.isdigit():
            v = int(ch)
        elif "A" <= ch <= "Z":
            v = ord(ch) - 55
        else:  # '<' filler
            v = 0
        total += v * _MRZ_WEIGHTS[i % 3]
    return str(total % 10)


def _mrz_date(yymmdd: str, *, expiry: bool, today: date) -> Optional[str]:
    if not re.fullmatch(r"\d{6}", yymmdd):
        return None
    yy, mm, dd = int(yymmdd[:2]), int(yymmdd[2:4]), int(yymmdd[4:])
    century = 2000
    if expiry:
        # Expiry dates are at most ~10 years ahead and rarely decades old.
        if 2000 + yy > today.year + 20:
            century = 1900
    else:
        # Birth dates are in the past.
        if 2000 + yy > today.year:
            century = 1900
    d = _valid(century + yy, mm, dd)
    return d.isoformat() if d else None


@dataclass
class MrzResult:
    valid: bool
    fields: dict[str, Any] = field(default_factory=dict)
    issues: list[str] = field(default_factory=list)


def parse_td3_mrz(line1: Optional[str], line2: Optional[str], today: Optional[date] = None) -> MrzResult:
    """Parse and verify a passport (TD3, 2 x 44 chars) machine-readable zone."""
    today = today or date.today()
    if not line1 or not line2:
        return MrzResult(False, issues=["no MRZ read"])
    l1 = line1.strip().upper().replace(" ", "")
    l2 = line2.strip().upper().replace(" ", "")
    if len(l1) != 44 or len(l2) != 44 or not l1.startswith("P"):
        return MrzResult(False, issues=[f"MRZ has the wrong shape ({len(l1)}/{len(l2)} characters, expected 44/44)"])

    names = l1[5:].split("<<", 1)
    fields = {
        "issuing_country": l1[2:5].replace("<", ""),
        "surname": names[0].replace("<", " ").strip(),
        "given_names": names[1].replace("<", " ").strip() if len(names) > 1 else "",
        "document_number": l2[0:9].replace("<", ""),
        "nationality": l2[10:13].replace("<", ""),
        "date_of_birth": _mrz_date(l2[13:19], expiry=False, today=today),
        "sex": {"M": "M", "F": "F"}.get(l2[20], "X"),
        "expiry_date": _mrz_date(l2[21:27], expiry=True, today=today),
    }
    checks = [
        ("document number", l2[0:9], l2[9]),
        ("date of birth", l2[13:19], l2[19]),
        ("expiry date", l2[21:27], l2[27]),
        ("composite", l2[0:10] + l2[13:20] + l2[21:43], l2[43]),
    ]
    issues = [f"MRZ check digit failed for {name}" for name, value, digit in checks if mrz_check_digit(value) != digit]
    return MrzResult(not issues, fields, issues)


# -------------------------------------------------------------- normalisation

DATE_FIELDS = ("date_of_birth", "issue_date", "expiry_date")


def normalize_extraction(raw: dict[str, Any], today: Optional[date] = None) -> tuple[dict[str, Any], list[dict[str, str]]]:
    """
    Turn the document agent's raw strings into strict fields.

    Returns (normalized, issues). The MRZ, when present and its check digits pass,
    wins over the visually read values because it is machine-verifiable.
    """
    today = today or date.today()
    issues: list[dict[str, str]] = []
    out: dict[str, Any] = {
        "document_kind": raw.get("document_kind") or "other",
        "full_name": (raw.get("full_name") or "").strip() or None,
        "surname": (raw.get("surname") or "").strip().upper() or None,
        "given_names": (raw.get("given_names") or "").strip().upper() or None,
        "sex": {"M": "M", "F": "F", "MALE": "M", "FEMALE": "F", "М": "M", "Ж": "F", "МУЖ": "M", "ЖЕН": "F"}.get((raw.get("sex") or "").strip().upper().rstrip(".")),
        "document_number": re.sub(r"\s+", "", raw.get("document_number") or "") or None,
        "nationality": (raw.get("nationality") or "").strip().upper() or None,
        "place_of_birth": (raw.get("place_of_birth") or "").strip() or None,
        "issuer_name": (raw.get("issuer_name") or "").strip() or None,
        "address": " ".join((raw.get("address") or "").split()) or None,
        "issuing_country": (raw.get("issuing_country") or "").strip().upper() or None,
        "amount": None,
        "currency": (raw.get("currency") or "").strip().upper() or None,
        "mrz_verified": False,
    }
    for f in DATE_FIELDS:
        r = normalize_date(raw.get(f))
        out[f] = r.iso
        if r.issue and r.issue != "missing":
            issues.append({"field": f, "severity": "warning", "message": f"Couldn’t read {f.replace('_', ' ')}: {r.issue}."})

    if raw.get("amount"):
        try:
            out["amount"] = str(Decimal(str(raw["amount"]).replace(" ", "").replace(",", ".")).quantize(Decimal("0.01"), ROUND_HALF_UP))
        except InvalidOperation:
            issues.append({"field": "amount", "severity": "warning", "message": f"Couldn’t read amount: {raw['amount']}."})

    mrz = raw.get("mrz") or {}
    if out["document_kind"] == "passport" and (mrz.get("line1") or mrz.get("line2")):
        res = parse_td3_mrz(mrz.get("line1"), mrz.get("line2"), today)
        if res.valid:
            out["mrz_verified"] = True
            for key in ("document_number", "nationality", "date_of_birth", "expiry_date", "surname", "given_names", "sex", "issuing_country"):
                visual, machine = out.get(key), res.fields.get(key)
                # A printed nationality is often a name ("UTOPIAN"), the MRZ a code ("UTO"): only compare codes.
                # Printed nationality/issuer is often a name ("UTOPIAN"), the MRZ a code ("UTO"): only compare codes.
                comparable = key not in ("nationality", "issuing_country") or (visual and len(visual) == 3)
                if machine and visual and visual != machine and comparable and key not in ("surname", "given_names"):
                    issues.append({"field": key, "severity": "warning", "message": f"Printed {key.replace('_', ' ')} ({visual}) differs from the MRZ ({machine}). Using the MRZ."})
                if machine:
                    out[key] = machine
            if not out["full_name"]:
                out["full_name"] = f"{res.fields['given_names']} {res.fields['surname']}".strip()
        else:
            issues.extend({"field": "mrz", "severity": "warning", "message": m + "."} for m in res.issues)

    if out["expiry_date"]:
        exp = date.fromisoformat(out["expiry_date"])
        if exp < today:
            issues.append({"field": "expiry_date", "severity": "error", "message": f"Expired on {exp.isoformat()}."})
    if out["issue_date"] and out["expiry_date"] and out["issue_date"] > out["expiry_date"]:
        issues.append({"field": "issue_date", "severity": "error", "message": "Issue date is after the expiry date."})
    if out["date_of_birth"] and out["date_of_birth"] > today.isoformat():
        issues.append({"field": "date_of_birth", "severity": "error", "message": "Date of birth is in the future."})
    return out, issues


# --------------------------------------------------------------------- money

def money(amount: Any) -> Optional[Decimal]:
    if amount is None or amount == "":
        return None
    try:
        return Decimal(str(amount)).quantize(Decimal("0.01"), ROUND_HALF_UP)
    except InvalidOperation:
        return None


def sum_fees(fees: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """Totals per currency. Fees without a fixed amount are listed, never guessed."""
    totals: dict[str, Decimal] = {}
    items, unknown = [], []
    for f in fees:
        amt = money(f.get("amount"))
        entry = {"key": f.get("key"), "title": f["title"], "amount": str(amt) if amt is not None else None, "currency": f.get("currency"), "mandatory": f.get("mandatory", True), "note": f.get("note")}
        items.append(entry)
        if amt is None or not f.get("currency"):
            unknown.append(f["title"])
            continue
        if f.get("mandatory", True):
            totals[f["currency"]] = totals.get(f["currency"], Decimal("0")) + amt
    return {
        "items": items,
        "mandatory_totals": {c: str(v) for c, v in sorted(totals.items())},
        "amounts_not_fixed": unknown,
    }


# ------------------------------------------------------------- gap analysis

@dataclass
class UserDoc:
    id: str
    title: str
    category: str
    kind: Optional[str]  # from analysis; falls back to category mapping
    expiry_date: Optional[str]
    issue_date: Optional[str]
    issues: list[dict[str, str]]
    amount: Optional[str] = None
    currency: Optional[str] = None


CATEGORY_TO_KIND = {"Passport": "passport", "Insurance": "insurance", "Finances": "bank_statement", "Housing": "accommodation", "Education": "enrolment", "Visa or permit": "permit"}


def check_requirements(requirements: list[dict[str, Any]], docs: list[UserDoc], travel_date: Optional[date], stay_days: Optional[int], today: Optional[date] = None) -> dict[str, Any]:
    """
    For each guideline requirement: satisfied / problem / missing, with the exact reason.
    Constraints supported: valid_months_after_stay, max_age_days, issued_within_years,
    min_amount (+ min_amount_currency). A constraint that can't be checked because the
    value is unknown is a problem, never a pass.
    """
    today = today or date.today()
    trip_end = travel_date + timedelta(days=stay_days) if travel_date and stay_days else travel_date
    results = []
    for req in requirements:
        kind = req.get("doc_kind")
        candidates = [d for d in docs if (d.kind or CATEGORY_TO_KIND.get(d.category)) == kind]
        c = req.get("constraints") or {}
        best, problems = None, []
        for d in candidates:
            p = []
            months = c.get("valid_months_after_stay")
            if d.expiry_date:
                exp = date.fromisoformat(d.expiry_date)
                if exp < today:
                    p.append(f"expired on {exp.isoformat()}")
                if months and trip_end:
                    need = add_months(trip_end, int(months))
                    if exp < need:
                        p.append(f"must be valid until at least {need.isoformat()} ({months} months after the trip), but expires {exp.isoformat()}")
            elif months:
                p.append("expiry date unknown, so validity after the trip can’t be checked")
            if c.get("max_age_days"):
                if d.issue_date:
                    age = (today - date.fromisoformat(d.issue_date)).days
                    if age > int(c["max_age_days"]):
                        p.append(f"issued {age} days ago; must be at most {c['max_age_days']} days old")
                else:
                    p.append(f"issue date unknown, so it can’t be checked that it’s at most {c['max_age_days']} days old")
            if c.get("issued_within_years"):
                if d.issue_date:
                    if date.fromisoformat(d.issue_date) < add_months(today, -12 * int(c["issued_within_years"])):
                        p.append(f"must be issued within the last {c['issued_within_years']} years")
                else:
                    p.append(f"issue date unknown, so it can’t be checked that it was issued within {c['issued_within_years']} years")
            if c.get("min_amount"):
                need, cur = money(c["min_amount"]), c.get("min_amount_currency")
                have = money(d.amount)
                if have is None:
                    p.append(f"amount unknown; must be at least {need} {cur or ''}".rstrip())
                elif cur and d.currency and d.currency != cur:
                    p.append(f"amount is in {d.currency}; requirement is at least {need} {cur}, convert and check")
                elif have < need:
                    p.append(f"amount {have} is below the required {need} {cur or ''}".rstrip())
            # Expiry is already checked above with the trip in mind; don't repeat it.
            p.extend(i["message"] for i in d.issues if i.get("severity") == "error" and i.get("field") != "expiry_date")
            if not p:
                best = d
                break
            problems.append({"document": d.title, "problems": p})
        status = "satisfied" if best else ("problem" if candidates else "missing")
        results.append({
            "key": req["key"],
            "title": req["title"],
            "mandatory": req.get("mandatory", True),
            "status": status,
            "matched_document": best.title if best else None,
            "problems": problems if not best else [],
            "description": req.get("description"),
        })
    return {
        "trip_end": trip_end.isoformat() if trip_end else None,
        "requirements": results,
        "missing_or_problem": [r["title"] for r in results if r["status"] != "satisfied" and r["mandatory"]],
    }


# ---------------------------------------------------------------- form fill

def _fmt(value: Any, fmt: str) -> Optional[str]:
    if value in (None, ""):
        return None
    if fmt.startswith("date:"):
        iso = normalize_date(str(value)).iso
        if not iso:
            return None
        y, m, d = iso.split("-")
        return fmt[5:].replace("YYYY", y).replace("MM", m).replace("DD", d)
    if fmt == "upper":
        return str(value).upper()
    return str(value)


def fill_form(template: dict[str, Any], sources: dict[str, Any]) -> list[dict[str, Any]]:
    """
    Fill a guideline form template. `source` paths look like "profile.full_name" or
    "passport.expiry_date"; nothing is invented, unknown fields stay empty.
    """
    out = []
    for f in template.get("fields", []):
        value, used = None, None
        for path in [f["source"]] if isinstance(f.get("source"), str) else (f.get("source") or []):
            obj: Any = sources
            for part in path.split("."):
                obj = obj.get(part) if isinstance(obj, dict) else None
            value = _fmt(obj, f.get("format", "text"))
            if value:
                used = path
                break
        out.append({"key": f["key"], "label": f["label"], "value": value, "status": "filled" if value else "missing",
                    "hint": f.get("hint"), "source": used})
    return out
