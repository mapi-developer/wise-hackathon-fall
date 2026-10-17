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
from app.models import CountryGuideline, VisaRequirement
from app.services import visa_matrix

# Country centroids, regions and subregions (UN M49), for ranking alternatives by distance.
GEO_FILE = Path(__file__).resolve().parents[1] / "data" / "geo" / "countries.json"

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
        "fees": [{"title": f["title"], "amount": f["amount"], "currency": f["currency"]} for f in g.fees],
        "official_links": [{"title": f["title"], "url": f["official_url"]} for f in g.forms if f.get("official_url")],
        "sources": g.sources,
    })
    return out


async def decisions(session: AsyncSession, origin: Optional[str], residence: Optional[str], purpose: str) -> list[dict]:
    """Every destination's decision for one passport, residence permit and purpose (the explore map)."""
    matrix = await visa_matrix.for_origin(session, origin) if origin else {}
    rows = (await session.exec(select(CountryGuideline))).all()
    codes = set(await visa_matrix.passports(session)) | set(matrix) | {g.destination_code for g in rows}
    out = []
    for code in sorted(codes):
        g = pick_guideline(rows, code, origin, purpose)
        current = bool(g) and guideline_store.freshness(g)[0] == "current"
        d = decide(code, origin, residence, purpose, matrix.get(code), g, current)
        out.append({**d.as_dict(), "has_guideline": current})
    return out


# ------------------------------------------------------------ alternatives

# How easy entry is, easiest first. Visa-free beats everything else, as the user asked.
EASE = {"visa_free": 0, "visa_on_arrival": 1, "evisa": 2, "visa_required": 3, "unknown": 4}
REGIONS = ("Africa", "Americas", "Asia", "Europe", "Oceania")


@lru_cache(maxsize=1)
def geo() -> dict[str, dict]:
    return json.loads(GEO_FILE.read_text(encoding="utf-8")) if GEO_FILE.exists() else {}


def distance_km(a: str, b: str) -> Optional[int]:
    """Great-circle distance between two countries' centroids; None if either is unknown."""
    ga, gb = geo().get(a), geo().get(b)
    if not ga or not gb:
        return None
    la1, lo1, la2, lo2 = map(math.radians, (ga["lat"], ga["lng"], gb["lat"], gb["lng"]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return round(6371 * 2 * math.asin(math.sqrt(h)))


def alternatives(
    rows: list[dict],
    instead_of: Optional[str] = None,
    origin: Optional[str] = None,
    region: Optional[str] = None,
    exclude: frozenset[str] = frozenset(),
    limit: int = 8,
) -> list[dict]:
    """
    Destinations easier to enter than `instead_of` (or the easiest anywhere), best first.

    Ranked by ease of entry (visa-free first), then verified guidelines before indicative data,
    then distance to `instead_of` (close to where the user wanted to go) or, without one, to `origin`.
    `rows` are decisions() output; `home` and `unknown` destinations are never suggested.
    """
    target = next((r for r in rows if r["code"] == instead_of), None) if instead_of else None
    # Without a target, or when the target is itself easy, anything visa-free to e-visa will do.
    ceiling = min(EASE.get(target["status"], 4), EASE["evisa"] + 1) if target else EASE["evisa"] + 1
    place = geo()
    near = instead_of or origin
    target_geo = place.get(instead_of or "")
    out = []
    for r in rows:
        ease = EASE.get(r["status"])
        if ease is None or ease >= ceiling or r["code"] in exclude or r["code"] == instead_of:
            continue
        g = place.get(r["code"], {})
        if region and g.get("region") != region:
            continue
        km = distance_km(near, r["code"]) if near else None
        out.append({
            "code": r["code"], "status": r["status"], "basis": r["basis"], "stay_days": r["stay_days"],
            "has_guideline": r["has_guideline"], "region": g.get("region"), "lat": g.get("lat"), "lng": g.get("lng"),
            "distance_km": km,
            "same_subregion": bool(target_geo and g.get("subregion") == target_geo.get("subregion")),
        })
    out.sort(key=lambda a: (EASE[a["status"]], not a["has_guideline"], a["distance_km"] if a["distance_km"] is not None else math.inf, a["code"]))
    return out[:limit]
