"""
Visa eligibility for the explore map. Deterministic: decides each destination's status
for one passport, residence permit and purpose, and says which source decided it.

Precedence, strongest first:
  1. home       the user's own country, or the country of their residence permit
  2. rule       EU/EEA/Swiss free movement; a Schengen residence permit for short Schengen trips
  3. verified   a current Unbound country guideline with an entry_type (app/agents/guidelines.py)
  4. indicative the open visa matrix (app/services/visa_matrix.py), tourism only
  5. none       nothing we can stand behind: "unknown"
"""
from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Optional

import pycountry
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.agents import guidelines as guideline_store
from app.models import CountryGuideline, DocumentAnalysis, User, VisaRequirement
from app.services import visa_matrix

STATUSES = ("visa_free", "visa_on_arrival", "evisa", "visa_required", "unknown", "home")

EU = {
    "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT",
    "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
}
FREE_MOVEMENT = EU | {"IS", "LI", "NO", "CH"}
# Full members since 1 January 2025 (Bulgaria and Romania). Cyprus and Ireland are not in Schengen.
SCHENGEN = (EU - {"CY", "IE"}) | {"IS", "LI", "NO", "CH"}

_MATRIX_STATUS = {
    "visa_free": "visa_free",
    "visa_on_arrival": "visa_on_arrival",
    "evisa": "evisa",
    "eta": "evisa",
    "visa_required": "visa_required",
    "no_admission": "visa_required",
}

# MRZ codes that are not ISO 3166 alpha-3 (ICAO Doc 9303 part 3).
_MRZ_SPECIAL = {"D": "DE", "RKS": "XK", "GBD": "GB", "GBN": "GB", "GBO": "GB", "GBP": "GB", "GBS": "GB"}


def alpha2(value: Optional[str]) -> Optional[str]:
    """ISO alpha-2 from an alpha-2/alpha-3/MRZ code or an English country name; None if unsure."""
    v = (value or "").strip()
    if not v:
        return None
    if v.upper() in _MRZ_SPECIAL:
        return _MRZ_SPECIAL[v.upper()]
    try:
        if len(v) == 2:
            c = pycountry.countries.get(alpha_2=v.upper())
        elif len(v) == 3:
            c = pycountry.countries.get(alpha_3=v.upper())
        else:
            c = pycountry.countries.lookup(v)
    except LookupError:
        c = _by_name_prefix(v)
    return c.alpha_2 if c else None


def _by_name_prefix(name: str):
    """"Russia" -> Russian Federation; accepted only when exactly one country name starts with it."""
    try:
        found = pycountry.countries.search_fuzzy(name)
    except LookupError:
        return None
    q = name.lower()
    names = lambda c: [getattr(c, a, "").lower() for a in ("name", "common_name", "official_name")]
    hits = [c for c in found if any(n.startswith(q) for n in names(c))]
    return hits[0] if len(hits) == 1 else None


@dataclass
class Decision:
    code: str
    status: str
    basis: str  # home, rule, verified, indicative, none
    stay_days: Optional[int] = None
    notes: list[str] = field(default_factory=list)  # note keys, translated by the frontend
    indicative_raw: Optional[str] = None
    has_guideline: bool = False  # a current Unbound guideline exists for this trip

    def as_dict(self) -> dict:
        return asdict(self)


def decide(
    destination: str,
    origin: Optional[str],
    residence: Optional[str],
    purpose: str,
    matrix: Optional[VisaRequirement],
    guideline: Optional[CountryGuideline],
    guideline_current: bool,
) -> Decision:
    d = Decision(code=destination, status="unknown", basis="none")
    if matrix:
        d.indicative_raw = matrix.raw
    if guideline and not guideline_current:
        d.notes.append("guideline_updating")

    if not origin:
        d.notes.append("no_passport")
        return d
    if destination == origin:
        d.status, d.basis = "home", "home"
        d.notes.append("own_country")
        return d
    if residence and destination == residence:
        d.status, d.basis = "home", "home"
        d.notes.append("residence_country")
        return d
    if origin in FREE_MOVEMENT and destination in FREE_MOVEMENT:
        d.status, d.basis = "visa_free", "rule"
        d.notes.append("free_movement")
        return d

    if guideline and guideline_current and guideline.entry_type in STATUSES:
        d.status, d.basis = guideline.entry_type, "verified"
        d.stay_days = guideline.max_stay_days
        return d

    if purpose == "tourism":
        if residence in SCHENGEN and destination in SCHENGEN:
            d.status, d.basis, d.stay_days = "visa_free", "rule", 90
            d.notes.append("schengen_residence")
            return d
        if matrix:
            d.status, d.basis = _MATRIX_STATUS[matrix.category], "indicative"
            d.stay_days = matrix.stay_days
            if matrix.category == "eta":
                d.notes.append("eta")
            if matrix.category == "no_admission":
                d.notes.append("no_admission")
            return d
        d.notes.append("no_data")
        return d

    d.notes.append("purpose_unverified")
    return d


def pick_guideline(rows: list[CountryGuideline], destination: str, origin: Optional[str], purpose: str) -> Optional[CountryGuideline]:
    """Same matching as guidelines.find: exact citizenship before "*"."""
    matches = [g for g in rows if g.destination_code == destination and g.purpose == purpose and g.origin_code in {origin, "*"}]
    return sorted(matches, key=lambda g: g.origin_code == "*")[0] if matches else None


def guideline_detail(g: CountryGuideline) -> dict:
    status, reason = guideline_store.freshness(g)
    out = {"status": status, "reason": reason, "visa_type": g.visa_type, "verified_at": g.verified_at}
    if status != "current":
        return out  # stale rules are withheld, as for the agents
    out.update({
        "summary": g.summary,
        "entry_type": g.entry_type,
        "max_stay_days": g.max_stay_days,
        "processing_days_min": g.processing_days_min,
        "processing_days_max": g.processing_days_max,
        "requirements": [{"title": r["title"], "description": r["description"], "mandatory": r.get("mandatory", True)} for r in g.requirements],
        "fees": [{"title": f["title"], "amount": f["amount"], "currency": f["currency"], "mandatory": f.get("mandatory", True), "note": f.get("note")} for f in g.fees],
        "official_links": [{"title": f["title"], "url": f["official_url"]} for f in g.forms if f.get("official_url")],
        "sources": g.sources,
    })
    return out


# ------------------------------------------------------------- travel profile

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
            if code := alpha2(a.normalized.get("nationality")):
                origin, source = code, "passport"
                break
    if not origin and (code := alpha2(user.citizenship)):
        origin, source = code, "citizenship"
    # residence="" in the query means "no residence permit" even if the profile has one.
    residence = user.residence_code if residence is None else residence
    return {"origin": origin, "origin_source": source, "residence": residence or None, "purpose": purpose or user.travel_purpose or "tourism"}


async def decide_all(session: AsyncSession, profile: dict) -> dict[str, Decision]:
    """A decision for every country we know of, for one travel profile."""
    o = profile["origin"]
    matrix = await visa_matrix.for_origin(session, o) if o else {}
    rows = (await session.exec(select(CountryGuideline))).all()
    codes = set(await visa_matrix.passports(session)) | set(matrix) | {g.destination_code for g in rows} | set(geo())
    out = {}
    for code in sorted(codes):
        g = pick_guideline(rows, code, o, profile["purpose"])
        current = bool(g) and guideline_store.freshness(g)[0] == "current"
        out[code] = decide(code, o, profile["residence"], profile["purpose"], matrix.get(code), g, current)
        out[code].has_guideline = current
    return out


# ------------------------------------------------------- alternatives and routes

GEO_FILE = Path(__file__).resolve().parents[1] / "data" / "geo" / "centroids.json"

# How easy each status is to act on; lower is better. Visa-free is always preferred.
EASE = {"visa_free": 0, "visa_on_arrival": 1, "evisa": 2}
# A harder status counts as this many extra kilometres when ranking nearby alternatives.
EASE_PENALTY_KM = 1500


@lru_cache(maxsize=1)
def geo() -> dict[str, dict]:
    """Region, subregion and a rough centre per country (Natural Earth 1:110m, same as the globe)."""
    return json.loads(GEO_FILE.read_text()) if GEO_FILE.exists() else {}


def distance_km(a: dict, b: dict) -> int:
    lat1, lng1, lat2, lng2 = map(math.radians, (a["lat"], a["lng"], b["lat"], b["lng"]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return round(2 * 6371 * math.asin(math.sqrt(h)))


def _option(d: Decision, km: Optional[int] = None) -> dict:
    out = {"code": d.code, "status": d.status, "basis": d.basis, "stay_days": d.stay_days}
    if km is not None:
        out["distance_km"] = km
    return out


def alternatives(target: str, decisions: dict[str, Decision], limit: int = 6) -> list[dict]:
    """
    Easier destinations near `target`: visa-free first, then visa on arrival, then eVisa, nearer
    first. Home countries are left out (the user is there already).
    """
    places = geo()
    here = places.get(target)
    if not here:
        return []
    scored = []
    for code, d in decisions.items():
        if code == target or d.status not in EASE or code not in places:
            continue
        km = distance_km(here, places[code])
        scored.append((km + EASE[d.status] * EASE_PENALTY_KM, EASE[d.status], km, code))
    return [_option(decisions[c], km) for _, _, km, c in sorted(scored)[:limit]]


def easiest(decisions: dict[str, Decision], region: Optional[str] = None, limit: int = 12) -> list[dict]:
    """Where the user can go most easily: visa-free first, longer permitted stays first."""
    places = geo()
    pick = [d for d in decisions.values() if d.status in EASE and (not region or places.get(d.code, {}).get("region") == region)]
    pick.sort(key=lambda d: (EASE[d.status], -(d.stay_days or 0), d.code))
    return [_option(d) for d in pick[:limit]]


def routes(target: str, profile: dict, d: Decision, guideline: Optional[dict]) -> list[dict]:
    """
    Ways in for this traveller, most direct first. Keys are translated by the frontend
    (explore.route.<key>); `verified` says whether a current guideline backs the details.
    """
    current = guideline if guideline and guideline.get("status") == "current" else None
    origin, residence, purpose = profile["origin"], profile["residence"], profile["purpose"]
    out: list[dict] = []
    if not origin or d.status == "home":
        return out
    if d.status == "visa_free":
        out.append({"key": "visa_free", "stay_days": d.stay_days, "verified": d.basis in ("rule", "verified")})
    elif d.status == "visa_on_arrival":
        out.append({"key": "on_arrival", "stay_days": d.stay_days, "verified": d.basis == "verified"})
    elif d.status == "evisa":
        out.append({"key": "eta" if "eta" in d.notes else "evisa", "stay_days": d.stay_days, "verified": d.basis == "verified"})
    if purpose != "tourism" and d.basis not in ("home", "rule"):
        out.append({"key": "purpose_visa", "purpose": purpose, "verified": bool(current),
                    "visa_type": current and current["visa_type"], "processing_days_max": current and current.get("processing_days_max")})
    elif d.status in ("visa_required", "unknown"):
        out.append({"key": "apply_visa", "verified": bool(current),
                    "visa_type": current and current["visa_type"], "processing_days_max": current and current.get("processing_days_max")})
    if purpose == "tourism" and target in SCHENGEN and residence not in SCHENGEN and d.status not in ("visa_free",):
        out.append({"key": "schengen_permit", "verified": True})
    return out
