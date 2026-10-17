import pytest

from app.explore import alpha2, decide, pick_guideline
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


def _row(code, status, basis="indicative", has_guideline=False, stay=None):
    return {"code": code, "status": status, "basis": basis, "stay_days": stay, "has_guideline": has_guideline}


def test_alternatives_prefer_visa_free_then_nearest():
    from app.explore import alternatives

    rows = [
        _row("HU", "visa_required"), _row("RS", "visa_free", stay=30), _row("TR", "visa_free", stay=60),
        _row("AL", "evisa"), _row("TH", "visa_free", stay=30), _row("AT", "visa_required"), _row("RU", "home", "home"),
    ]
    found = [a["code"] for a in alternatives(rows, instead_of="HU", origin="RU")]
    # Visa-free ones first, nearest to Hungary first; never the blocked one, other visa countries or home.
    assert found == ["RS", "TR", "TH", "AL"]


def test_alternatives_verified_before_indicative_and_region_filter():
    from app.explore import alternatives

    rows = [_row("RS", "visa_free"), _row("TH", "visa_free", "verified", True), _row("GE", "visa_on_arrival")]
    assert [a["code"] for a in alternatives(rows, origin="RU")] == ["TH", "RS", "GE"]
    assert [a["code"] for a in alternatives(rows, origin="RU", region="Europe")] == ["RS"]


def test_alternatives_only_easier_than_target():
    from app.explore import alternatives

    rows = [_row("GE", "visa_free"), _row("AM", "visa_free"), _row("IN", "evisa"), _row("EG", "visa_on_arrival")]
    # Going to an e-visa country: only visa-free and visa-on-arrival options are easier.
    assert {a["code"] for a in alternatives(rows, instead_of="IN")} == {"GE", "AM", "EG"}
