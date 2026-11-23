"""Final merge + validation -> public/data/{members,committees,pending_seats,meta}.json

Joins: roster (03), photos (04), district cities (05), redrawn (06), WAR (07),
results (08), FEC (09, optional), committees (congress-legislators), first-elected
overrides, fun facts. Fails on validation errors.
"""

from __future__ import annotations

import json
import sys
from datetime import date

import pandas as pd
import yaml

from common import (DATA, INTERIM, OVERRIDES, PUBLIC_DATA, RAW, log, norm_name, now_iso, write_json,
                    write_report)
from config import COMMITTEE_CONGRESS, CONGRESS, CONGRESS_START, FEC_CYCLE, TOP_CITIES, TOP_COUNTIES

ROLE_TITLES = {"Chairman": "Chair", "Chair": "Chair", "Chairwoman": "Chair", "Ranking Member": "Ranking Member",
               "Vice Chairman": "Vice Chair", "Vice Chair": "Vice Chair", "Co-Chairman": "Co-Chair"}


def yload(name: str):
    with (RAW / "legislators" / name).open() as f:
        return yaml.load(f, Loader=getattr(yaml, "CSafeLoader", yaml.SafeLoader))


def opt_csv(path, **kw) -> pd.DataFrame:
    return pd.read_csv(path, **kw) if path.exists() else pd.DataFrame()


def service(p: dict | None) -> tuple[int | None, int, bool]:
    """(first elected year, whole years served before CONGRESS_START, needs_review)."""
    if not p:
        return None, 0, False
    terms = sorted(p["terms"], key=lambda t: t["start"])
    days = 0
    for t in terms:
        s, e = date.fromisoformat(t["start"]), min(date.fromisoformat(t["end"]), CONGRESS_START)
        if e > s:
            days += (e - s).days
    first = terms[0]
    s = date.fromisoformat(first["start"])
    regular = s.month == 1 and s.year % 2 == 1  # Congress convenes in January of odd years
    if regular:
        return s.year - 1, round(days / 365.25), False
    if first.get("how") == "appointment":
        later = [t for t in terms[1:] if t.get("how") != "appointment"]
        yr = (date.fromisoformat(later[0]["start"]).year - (1 if later and date.fromisoformat(later[0]["start"]).month == 1 else 0)
              ) if later else None
        return yr, round(days / 365.25), True
    # special election: elected the year they took office, unless sworn in Jan/Feb
    # (could be a late-year special or a delayed seating) -> review
    return s.year, round(days / 365.25), s.month <= 2


def state_top_places() -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    """Statewide top cities/counties (for senators), from Census popest."""
    pl = pd.read_csv(RAW / "popest" / "sub-est2025.csv", dtype=str, encoding="latin-1")
    pl = pl[pl.SUMLEV.isin(["162"])].assign(pop=lambda d: d.POPESTIMATE2025.astype(int))
    co = pd.read_csv(RAW / "popest" / "co-est2025-alldata.csv", dtype=str, encoding="latin-1")
    co = co[co.SUMLEV == "050"].assign(pop=lambda d: d.POPESTIMATE2025.astype(int))
    from common import FIPS_TO_ABBR
    cities, counties = {}, {}
    for fips, g in pl.groupby("STATE"):
        names = g.sort_values("pop", ascending=False).NAME.str.replace(
            r" (city|town|village|borough|municipality|CDP|city and borough|metropolitan government.*|consolidated government.*|unified government.*|urban county)$",
            "", regex=True).tolist()
        cities[FIPS_TO_ABBR.get(fips, "")] = list(dict.fromkeys(names))[:TOP_CITIES]
    for fips, g in co.groupby("STATE"):
        counties[FIPS_TO_ABBR.get(fips, "")] = g.sort_values("pop", ascending=False).CTYNAME.tolist()[:TOP_COUNTIES]
    return cities, counties


def main() -> None:
    roster = pd.read_csv(INTERIM / "roster_120.csv", dtype={"district": "Int64", "senate_class": "Int64"})
    seated = roster[roster.bioguide_id.notna()].copy()
    people = {p["id"]["bioguide"]: p for p in yload("legislators-historical.yaml") + yload("legislators-current.yaml")}

    photos = opt_csv(INTERIM / "photos.csv").set_index("bioguide_id")
    places = pd.read_csv(INTERIM / "district_places.csv").set_index("id")
    war = pd.read_csv(INTERIM / "war_summary.csv").set_index("bioguide_id")
    # keep_default_na=False: the literal source label "n/a" must not become NaN
    results = pd.read_csv(INTERIM / "results.csv", keep_default_na=False, na_values=[""]).set_index("bioguide_id")
    fec = opt_csv(INTERIM / "fec.csv")
    fec = fec.set_index("bioguide_id") if len(fec) else fec
    fe_path = OVERRIDES / "first_elected.csv"
    if not fe_path.exists():
        pd.DataFrame(columns=["bioguide_id", "first_elected_year", "years_in_congress", "note"]).to_csv(fe_path, index=False)
    fe = pd.read_csv(fe_path, dtype=str).fillna("")
    first_elected = {r.bioguide_id: int(r.first_elected_year) for r in fe.itertuples() if r.first_elected_year}
    years_override = {r.bioguide_id: int(r.years_in_congress) for r in fe.itertuples()
                      if getattr(r, "years_in_congress", "")}
    ff_path = OVERRIDES / "fun_facts.yaml"
    if not ff_path.exists():
        ff_path.write_text("# bioguide_id (or provisional NEW-<seat> id): [fact, fact, ...]\n# N000147:\n#   - Has represented DC since 1991.\n")
    fun = yaml.safe_load(ff_path.read_text()) or {}

    # caucuses (10): code -> display name; "PARTY-D"/"PARTY-R" = who an independent caucuses with
    CAUCUS_NAMES = {"HFC": "Freedom Caucus", "RSC": "Republican Study Committee", "RMSP": "Main Street Caucus",
                    "PSC": "Problem Solvers Caucus", "BDC": "Blue Dog Coalition", "NDC": "New Democrat Coalition",
                    "CPC": "Progressive Caucus", "CBC": "Congressional Black Caucus", "CHC": "Congressional Hispanic Caucus",
                    "CHCo": "Congressional Hispanic Conference", "CAPAC": "Asian Pacific American Caucus"}
    caucus_df = opt_csv(INTERIM / "caucuses.csv")
    member_caucuses: dict[str, list[dict]] = {}
    party_caucus: dict[str, str] = {}
    for c in caucus_df.itertuples() if len(caucus_df) else []:
        if c.caucus.startswith("PARTY-"):
            if c.caucus[-1] in "DR":
                party_caucus[c.bioguide_id] = c.caucus[-1]
        elif c.caucus in CAUCUS_NAMES:
            member_caucuses.setdefault(c.bioguide_id, []).append({"code": c.caucus, "name": CAUCUS_NAMES[c.caucus], "kind": c.kind})
    st_cities, st_counties = state_top_places()

    # committees (full committees only; subcommittee codes are longer)
    comm_meta = {c["thomas_id"]: c for c in yload("committees-current.yaml")}
    membership = yload("committee-membership-current.yaml")
    member_comms: dict[str, list[dict]] = {}
    committees_out = []
    seated_ids = set(seated.bioguide_id)
    for code, members in membership.items():
        if len(code) != 4 or code not in comm_meta:
            continue
        c = comm_meta[code]
        ids = []
        for mm in members:
            bid = mm.get("bioguide")
            if bid not in seated_ids:
                continue
            ids.append(bid)
            entry = {"code": code, "name": c["name"]}
            role = ROLE_TITLES.get(mm.get("title", ""))
            if role:
                entry["role"] = role
            member_comms.setdefault(bid, []).append(entry)
        committees_out.append({"code": code, "name": c["name"], "chamber": c.get("type"), "members": ids})

    errors, review = [], []
    members = []
    for m in seated.itertuples():
        bid = m.bioguide_id
        p = None if m.provisional_id else people.get(bid)
        fy, yrs, needs_review = service(p)
        if bid in first_elected:
            fy, needs_review = first_elected[bid], False
        yrs = years_override.get(bid, yrs)
        if m.new_to_congress or fy is None:
            fy = fy or 2026
        if needs_review:
            review.append(f"- {m.seat} {m.name} ({bid}): first term was a special/appointment; using {fy}. "
                          f"Confirm in first_elected.csv")
        names = p["name"] if p else {}
        aliases = {m.name, f"{names.get('first', '')} {names.get('last', '')}".strip(),
                   f"{names.get('nickname', '')} {names.get('last', '')}".strip(), names.get("official_full", "")}
        aliases = sorted(a for a in aliases if a and a != m.name and len(a.split()) > 1)

        if m.chamber == "house":
            pl = places.loc[m.seat] if m.seat in places.index else None
            cities = json.loads(pl.cities) if pl is not None else []
            counties = json.loads(pl.counties) if pl is not None else []
        else:
            cities, counties = st_cities.get(m.state, []), st_counties.get(m.state, [])

        w = war.loc[bid] if bid in war.index else None
        r = results.loc[bid] if bid in results.index else None
        rec = {
            "id": bid,
            "provisionalId": bool(m.provisional_id),
            "name": m.name,
            "lastName": m.last_name,
            "aliases": aliases,
            "party": m.party,
            "chamber": m.chamber,
            "state": m.state,
            **({"district": int(m.district)} if m.chamber == "house" else {"senateClass": int(m.senate_class)}),
            "status": m.status,
            "newToCongress": bool(m.new_to_congress),
            "photo": (photos.photo.get(bid) if bid in photos.index and isinstance(photos.photo.get(bid), str) else None),
            "firstElectedYear": int(fy),
            "yearsInCongress": int(yrs),
            "committees": member_comms.get(bid, []),
            "committeeCongress": COMMITTEE_CONGRESS,
            "districtCities": cities,
            "districtCounties": counties,
            "kamala2Way": (None if r is None or pd.isna(r.kamala2way) else float(r.kamala2way)),
            "kamala2WaySource": (r.kamala2way_source if r is not None else "missing"),
            "last2Way": (None if r is None or pd.isna(r.last2way_share) else
                         {"year": int(r.last2way_year), "share": float(r.last2way_share),
                          "opponent": (r.last2way_opponent if isinstance(r.last2way_opponent, str) and r.last2way_opponent else None),
                          "opponentParty": (r.last2way_opponent_party if isinstance(r.last2way_opponent_party, str) and r.last2way_opponent_party else None)}),
            "caucuses": sorted(member_caucuses.get(bid, []), key=lambda c: (c["kind"] != "ideological", c["name"])),
            **({"partyCaucus": party_caucus[bid]} if bid in party_caucus else {}),
            "war": json.loads(w.war) if w is not None else [],
            "warTrajectory": (w.war_trajectory if w is not None and isinstance(w.war_trajectory, str) else None),
            "funFacts": fun.get(bid, []) or [],
        }
        if len(fec) and bid in fec.index:
            f = fec.loc[bid]
            rec["fundraising"] = {"cycle": FEC_CYCLE, "receipts": float(f.receipts),
                                  "cashOnHand": float(f.cash_on_hand or 0), "disbursements": float(f.disbursements or 0)}
        members.append(rec)

    # ---- validation
    topo = json.loads((PUBLIC_DATA / "districts.topo.json").read_text())
    district_ids = {g["properties"]["id"] for g in topo["objects"]["districts"]["geometries"]}
    seat_ids = set(roster[roster.chamber == "house"].seat)
    if district_ids != seat_ids:
        errors.append(f"- district shapes vs House seats mismatch: shapes-only {sorted(district_ids - seat_ids)}, "
                      f"seats-only {sorted(seat_ids - district_ids)}")
    ids = [x["id"] for x in members]
    if len(ids) != len(set(ids)):
        errors.append("- duplicate member ids")
    for x in members:
        for k in ("kamala2Way",):
            if x[k] is not None and not 0 <= x[k] <= 1:
                errors.append(f"- {x['id']} {k} out of range: {x[k]}")
        if x["last2Way"] and not 0 <= x["last2Way"]["share"] <= 1:
            errors.append(f"- {x['id']} last2Way out of range")
        if x["party"] not in ("D", "R", "I"):
            errors.append(f"- {x['id']} bad party {x['party']}")
    expected = 541
    if len(roster) != expected:
        errors.append(f"- roster has {len(roster)} seats, expected {expected}")

    pending = roster[roster.status.isin(["pending", "vacant"])]
    pending_out = [{"seat": r.seat, "chamber": r.chamber, "state": r.state,
                    **({"district": int(r.district)} if r.chamber == "house" else {"senateClass": int(r.senate_class)}),
                    "status": r.status,
                    "candidates": [{"name": c["name"], "party": c["party"]} for c in json.loads(r.candidates or "[]")]}
                   for r in pending.itertuples()]

    members.sort(key=lambda x: (x["state"], x["chamber"] != "senate", x.get("district", 0), x.get("senateClass", 0)))
    write_json(PUBLIC_DATA / "members.json", members, compact=True)
    write_json(PUBLIC_DATA / "committees.json", committees_out, compact=True)
    write_json(PUBLIC_DATA / "pending_seats.json", pending_out)

    def count(f):
        return sum(1 for x in members if f(x))
    coverage = {
        "members": len(members),
        "pending_seats": len(pending_out),
        "photo": count(lambda x: x["photo"]),
        "war": count(lambda x: x["war"]),
        "kamala2Way": count(lambda x: x["kamala2Way"] is not None),
        "last2Way": count(lambda x: x["last2Way"]),
        "caucuses": count(lambda x: x["caucuses"]),
        "fundraising": count(lambda x: "fundraising" in x),
        "committees": count(lambda x: x["committees"]),
        "funFacts": count(lambda x: x["funFacts"]),
        "provisionalIds": count(lambda x: x["provisionalId"]),
    }
    meta = {"generated_at": now_iso(), "congress": CONGRESS, "committee_congress": COMMITTEE_CONGRESS,
            "fec_cycle": FEC_CYCLE, "coverage": coverage,
            "sources_doc": "DATA_SOURCES.md"}
    write_json(PUBLIC_DATA / "meta.json", meta)
    write_report("members", "members.json build", {
        "Errors": errors,
        "Coverage": [f"- {k}: {v}" for k, v in coverage.items()],
        "First-elected year needs review": review,
    })
    log(f"99: members.json written: {coverage}")
    if errors:
        log("99: ERRORS:\n" + "\n".join(errors))
        sys.exit(1)


if __name__ == "__main__":
    main()
