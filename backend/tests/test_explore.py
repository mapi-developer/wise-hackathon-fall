import pytest

from app.explore import Decision, alpha2, alternatives, decide, distance_km, easiest, geo, pick_guideline, routes
from app.models import CountryGuideline, VisaRequirement
from app.services.visa_matrix import DATA_FILE, parse_requirement, read_csv


def row(dest: str, category: str, days=None, origin="KZ") -> VisaRequirement:
    return VisaRequirement(origin_code=origin, destination_code=dest, category=category, stay_days=days, raw=category)


def guideline(dest="HU", origin="KZ", purpose="tourism", entry_type="visa_required", max_stay=90) -> CountryGuideline:
    return CountryGuideline(
        destination_code=dest, destination_name=dest, origin_code=origin, purpose=purpose, visa_type="C", entry_type=entry_type,
        summary="", max_stay_days=max_stay, requirements=[], fees=[], steps=[], forms=[], sources=[],
    )


def test_parse_requirement():
    assert parse_requirement("90") == ("visa_free", 90)
    assert parse_requirement("visa free") == ("visa_free", None)
    assert parse_requirement("e-visa") == ("evisa", None)
    assert parse_requirement("eta") == ("eta", None)
    assert parse_requirement("no admission") == ("no_admission", None)
    assert parse_requirement("-1") is None
    with pytest.raises(ValueError):
        parse_requirement("maybe")


def test_bundled_snapshot_parses():
    rows = read_csv(DATA_FILE)
    assert len(rows) > 30_000
    assert all(len(r["origin_code"]) == 2 and len(r["destination_code"]) == 2 for r in rows)


def test_alpha2_from_codes_and_names():
    assert alpha2("KAZ") == "KZ"
    assert alpha2("kz") == "KZ"
    assert alpha2("D") == "DE"  # German MRZ code
    assert alpha2("Kazakhstan") == "KZ"
    assert alpha2("Russia") == "RU"
    assert alpha2("Korea") is None  # two countries: don't guess
    assert alpha2("Atlantis") is None
    assert alpha2("") is None


def test_home_and_residence_country():
    assert decide("KZ", "KZ", None, "tourism", None, None, False).status == "home"
    d = decide("HU", "KZ", "HU", "study", row("HU", "visa_required"), None, False)
    assert (d.status, d.notes) == ("home", ["residence_country"])


def test_free_movement_any_purpose():
    d = decide("DE", "HU", None, "work", None, None, False)
    assert (d.status, d.basis) == ("visa_free", "rule")


def test_schengen_residence_permit_tourism_only():
    d = decide("FR", "KZ", "HU", "tourism", row("FR", "visa_required"), None, False)
    assert (d.status, d.basis, d.stay_days) == ("visa_free", "rule", 90)
    # Cyprus and Ireland are not Schengen
    assert decide("IE", "KZ", "HU", "tourism", row("IE", "visa_required"), None, False).status == "visa_required"
    # Not for study
    assert decide("FR", "KZ", "HU", "study", row("FR", "visa_required"), None, False).status == "unknown"


def test_verified_guideline_overrides_matrix():
    d = decide("HU", "KZ", None, "tourism", row("HU", "visa_free", 30), guideline(entry_type="evisa", max_stay=60), True)
    assert (d.status, d.basis, d.stay_days) == ("evisa", "verified", 60)


def test_stale_guideline_is_ignored_and_flagged():
    d = decide("HU", "KZ", None, "tourism", row("HU", "visa_free", 30), guideline(entry_type="evisa"), False)
    assert (d.status, d.basis, d.stay_days) == ("visa_free", "indicative", 30)
    assert "guideline_updating" in d.notes


def test_matrix_only_for_tourism():
    assert decide("US", "KZ", None, "tourism", row("US", "eta"), None, False).status == "evisa"
    assert decide("US", "KZ", None, "tourism", row("US", "no_admission"), None, False).status == "visa_required"
    d = decide("US", "KZ", None, "study", row("US", "visa_free"), None, False)
    assert (d.status, d.notes) == ("unknown", ["purpose_unverified"])


def test_no_passport_is_unknown():
    assert decide("US", None, None, "tourism", None, None, False).notes == ["no_passport"]


def test_pick_guideline_prefers_exact_citizenship():
    rows = [guideline(origin="*", entry_type="visa_required"), guideline(origin="KZ", entry_type="evisa")]
    assert pick_guideline(rows, "HU", "KZ", "tourism").entry_type == "evisa"
    assert pick_guideline(rows, "HU", "RU", "tourism").origin_code == "*"
    assert pick_guideline(rows, "HU", "KZ", "study") is None


def dec(code: str, status: str, basis="indicative", stay=None, notes=None) -> Decision:
    return Decision(code=code, status=status, basis=basis, stay_days=stay, notes=notes or [])


def test_geo_has_globe_countries():
    places = geo()
    assert len(places) > 150 and places["HU"]["region"] == "Europe"
    assert 200 < distance_km(places["HU"], places["AT"]) < 500


def test_alternatives_prefer_visa_free_then_nearer():
    ds = {
        "GB": dec("GB", "visa_required"),
        "IE": dec("IE", "evisa"),          # nearest, but eVisa
        "FR": dec("FR", "visa_free"),      # near and visa-free
        "MA": dec("MA", "visa_free"),      # visa-free, further
        "RS": dec("RS", "visa_required"),  # not an alternative
        "RU": dec("RU", "home", "home"),   # home is never suggested
    }
    got = [a["code"] for a in alternatives("GB", ds)]
    assert got[0] == "FR" and "RS" not in got and "RU" not in got and "GB" not in got
    assert got.index("MA") < got.index("IE") or got.index("FR") < got.index("IE")
    assert all("distance_km" in a for a in alternatives("GB", ds))


def test_easiest_ranks_status_then_stay():
    ds = {"A1": dec("TH", "visa_free", stay=30), "A2": dec("GE", "visa_free", stay=365), "A3": dec("EG", "visa_on_arrival"), "A4": dec("IN", "evisa"), "A5": dec("US", "visa_required")}
    ds = {d.code: d for d in ds.values()}
    assert [d["code"] for d in easiest(ds)] == ["GE", "TH", "EG", "IN"]
    assert [d["code"] for d in easiest(ds, region="Africa")] == ["EG"]


def test_routes():
    tourist = {"origin": "RU", "residence": None, "purpose": "tourism"}
    assert [r["key"] for r in routes("FR", tourist, dec("FR", "visa_required"), None)] == ["apply_visa", "schengen_permit"]
    assert [r["key"] for r in routes("GB", tourist, dec("GB", "visa_required"), None)] == ["apply_visa"]
    assert [r["key"] for r in routes("TR", tourist, dec("TR", "visa_free", stay=60), None)] == ["visa_free"]
    assert [r["key"] for r in routes("CA", tourist, dec("CA", "evisa", notes=["eta"]), None)] == ["eta"]
    # A residence permit in Schengen already opens Schengen: no permit route.
    assert routes("FR", {**tourist, "residence": "HU"}, dec("FR", "visa_free", "rule"), None)[0]["key"] == "visa_free"
    student = {**tourist, "purpose": "study"}
    current = {"status": "current", "visa_type": "D", "processing_days_max": 60}
    r = routes("HU", student, dec("HU", "unknown", "none"), current)
    assert r == [{"key": "purpose_visa", "purpose": "study", "verified": True, "visa_type": "D", "processing_days_max": 60}]
    assert routes("HU", {**tourist, "origin": None}, dec("HU", "unknown", "none"), None) == []
