"""2026 targeting lists -> per-member targeting, issue PAC support, seatFlipped, raceRole.

Inputs (SCAFFOLD 4.5, compiled by the team, see data/targeting_2026/README.md):
  data/targeting_2026/party_committee_lists.csv   DCCC Red to Blue / Frontline / Districts in Play,
                                                  NRCC MAGA Majority / Patriot Program / Target list
  data/targeting_2026/issue_pac_lists.csv         Club for Growth, EMILYs List, New Dem Action Fund,
                                                  Blue Dog PAC, Fairshake
  data/interim/results_2026_wiki.csv              per race: "Incumbent lost re-election", "Democratic gain"
  data/overrides/seat_flipped.csv                 seat, flipped (true/false), note: judgment calls

Joins
  - Seat lists (Districts in Play, NRCC Target list) describe a seat: joined on district.
  - Candidate lists (Red to Blue, MAGA Majority, Frontline, Patriot, issue PACs) name a person:
    joined on state + chamber + last name, so a losing challenger never tags the winner.
    (Some issue PAC rows use pre-redistricting district numbers, another reason to use names.)
  - Only `status == active` rows count; removed rows are listed in the report.

seatFlipped: Wikipedia's explicit "X gain"/"X hold"; "Incumbent re-elected" means held; otherwise
the party of the seat's 119th-Congress holder vs the winner (flagged for review). Overrides win.

raceRole (SCAFFOLD 4.5 table, checked in order, combining matches):
  1. Won as a challenger on Red to Blue / MAGA Majority and the seat flipped
  2. Won an open seat on the other party's target list
  3. Incumbent on the other party's target list who won, and/or on their own party's
     protection list (Frontline / Patriot Program)
  otherwise null.

No race ratings or PVI (SCAFFOLD 4.5): nothing from Cook / Sabato / Inside Elections is used.

Output: data/interim/targeting.csv (one row per member), data/reports/targeting.md
"""

from __future__ import annotations

import json
import re

import pandas as pd
import yaml

from common import DATA, INTERIM, OVERRIDES, RAW, log, norm_name, write_report

TARGETING = DATA / "targeting_2026"
PROTECT = {("DCCC", "Frontline"): "Frontline", ("NRCC", "Patriot Program"): "Patriot Program"}
FLIP_LISTS = {("DCCC", "Red to Blue"): "Red to Blue", ("NRCC", "MAGA Majority"): "MAGA Majority"}
# seat-level offense lists, and whose seats they go after
SEAT_LISTS = {("DCCC", "Districts in Play"): ("D", "DCCC's Districts in Play"), ("NRCC", "Target list"): ("R", "NRCC's target list")}
CANDIDATE_PROGRAMS = set(PROTECT) | set(FLIP_LISTS)


def clean_candidate(s: str) -> str:
    return re.sub(r"\s*\(.*?\)\s*", " ", str(s or "")).strip()


def last_token(s: str) -> str:
    t = norm_name(s).split()
    return t[-1] if t else ""


def main() -> None:
    roster = pd.read_csv(INTERIM / "roster_120.csv", dtype={"district": "Int64", "senate_class": "Int64"})
    seated = roster[roster.bioguide_id.notna()].copy()
    results = pd.read_csv(INTERIM / "results_2026_wiki.csv", dtype={"senate_class": "Int64"})
    party = pd.read_csv(TARGETING / "party_committee_lists.csv", dtype=str).fillna("")
    issue = pd.read_csv(TARGETING / "issue_pac_lists.csv", dtype=str).fillna("")
    # pipeline-generated lists that fill README gaps (e.g. 12a LCV Action Fund), same columns
    for f in sorted((TARGETING / "generated").glob("*.csv")):
        issue = pd.concat([issue, pd.read_csv(f, dtype=str).fillna("")], ignore_index=True)
    with (RAW / "legislators" / "legislators-current.yaml").open() as f:
        cur = yaml.load(f, Loader=getattr(yaml, "CSafeLoader", yaml.SafeLoader))
    # 119th-Congress holder party per seat (for flips not spelled out on Wikipedia)
    holder_party = {}
    for p in cur:
        t = p["terms"][-1]
        if t["type"] == "rep":
            d = t.get("district") or 0
            holder_party[f"{t['state']}-{'AL' if not d else f'{d:02d}'}"] = (t.get("party") or "")[:1]

    issues: dict[str, list[str]] = {"Removed rows (ignored)": [], "Candidate rows not matched to a member (lost, or name mismatch)": [],
                                    "Seat flips computed (no gain/hold on Wikipedia; confirm)": [], "Ambiguous name matches": []}
    for df in (party, issue):
        for r in df[df.status != "active"].itertuples():
            issues["Removed rows (ignored)"].append(f"- {r.committee} {r.program}: {r.district} {r.candidate} ({r.note})")
    party_a = party[party.status == "active"]
    # "Backed by" counts support only; spending against someone (FEC Schedule E "oppose") goes in the report
    opposed = issue[(issue.status == "active") & (issue.side == "oppose")]
    issue_a = issue[(issue.status == "active") & (issue.side != "oppose")]
    issues["Spent against (FEC Schedule E, not shown on the site)"] = [
        f"- {r.committee}: {r.district} {r.candidate} ({r.note})" for r in opposed.itertuples()]

    def match_candidate(row) -> str | None:
        """bioguide of the seated member this candidate row names, else None."""
        chamber = "senate" if row.district.endswith("SEN") else "house"
        name = clean_candidate(row.candidate)
        if not name or name.upper() == "OPEN":
            return None
        pool = seated[(seated.state == row.state) & (seated.chamber == chamber)]
        hits = pool[pool.name.map(last_token) == last_token(name)]
        if len(hits) > 1:
            same_seat = hits[hits.seat == row.district]
            issues["Ambiguous name matches"].append(f"- {row.committee}: {row.district} {name} -> {list(hits.name)}")
            hits = same_seat if len(same_seat) else hits.iloc[:0]
        return hits.bioguide_id.iloc[0] if len(hits) == 1 else None

    # candidate-specific rows -> member
    cand_rows: dict[str, list[dict]] = {}
    for df, kind in ((party_a[party_a.apply(lambda r: (r.committee, r.program) in CANDIDATE_PROGRAMS, axis=1)], "party"), (issue_a, "issue")):
        for r in df.itertuples():
            bid = match_candidate(r)
            if bid:
                cand_rows.setdefault(bid, []).append({"committee": r.committee, "program": r.program, "dateAdded": r.date_added or None, "kind": kind})
            else:
                issues["Candidate rows not matched to a member (lost, or name mismatch)"].append(
                    f"- {r.committee} {r.program}: {r.district} {clean_candidate(r.candidate)} ({r.party or '?'})")
    # seat-level rows -> seat
    seat_rows: dict[str, list[dict]] = {}
    for r in party_a.itertuples():
        if (r.committee, r.program) in SEAT_LISTS:
            seat_rows.setdefault(r.district, []).append({"committee": r.committee, "program": r.program, "dateAdded": r.date_added or None, "kind": "seat"})

    flip_over_path = OVERRIDES / "seat_flipped.csv"
    if not flip_over_path.exists():
        pd.DataFrame(columns=["seat", "flipped", "note"]).to_csv(flip_over_path, index=False)
    flip_over = {r.seat: str(r.flipped).strip().lower() in ("true", "1", "yes") for r in pd.read_csv(flip_over_path, dtype=str).fillna("").itertuples() if r.seat}

    res_by_seat = {r.seat: r for r in results.itertuples()}
    out = []
    for m in seated.itertuples():
        up = bool(m.up_2026)
        res = res_by_seat.get(m.seat) if up else None
        text = (res.result_text if res is not None and isinstance(res.result_text, str) else "") or ""
        outcome = (res.outcome if res is not None and isinstance(res.outcome, str) else "") or ""
        won_as_incumbent = text.startswith(("Incumbent re-elected", "Incumbent reelected", "Interim appointee elected"))
        incumbent_ran = won_as_incumbent or text.startswith(("Incumbent lost re-election", "Incumbent lost reelection", "Interim appointee lost"))
        open_seat = up and res is not None and not incumbent_ran

        # seatFlipped
        if not up:
            flipped, how = False, "not on the 2026 ballot"
        elif m.seat in flip_over:
            flipped, how = flip_over[m.seat], "override"
        elif "gain" in outcome:
            flipped, how = True, "wikipedia"
        elif "hold" in outcome or won_as_incumbent:
            flipped, how = False, "wikipedia"
        else:
            prior = holder_party.get(m.seat, "") if m.chamber == "house" else ""
            flipped, how = (bool(prior) and prior != m.party), "computed"
            issues["Seat flips computed (no gain/hold on Wikipedia; confirm)"].append(f"- {m.seat} {m.name}: prior {prior or '?'} -> {m.party}: {'flipped' if flipped else 'held'}")

        mine = cand_rows.get(m.bioguide_id, [])
        seat_lists = seat_rows.get(m.seat, []) if m.chamber == "house" else []
        targeting = [{k: v for k, v in r.items() if k != "kind"} for r in mine if r["kind"] != "issue"] + \
                    [{k: v for k, v in r.items() if k != "kind"} for r in seat_lists]
        issue_support = sorted({r["committee"] for r in mine if r["kind"] == "issue"})

        # raceRole
        role = None
        if up and m.party in ("D", "R"):
            other = "R" if m.party == "D" else "D"
            flip_prog = next((FLIP_LISTS[(r["committee"], r["program"])] for r in mine if (r["committee"], r["program"]) in FLIP_LISTS), None)
            protect = next((PROTECT[(r["committee"], r["program"])] for r in mine if (r["committee"], r["program"]) in PROTECT), None)
            # seat lists that go after this member's party (i.e. the other party's target list)
            hostile = next((SEAT_LISTS[(r["committee"], r["program"])][1] for r in seat_lists
                            if SEAT_LISTS[(r["committee"], r["program"])][0] == other), None)
            if flip_prog and flipped and not won_as_incumbent:
                role = f"{flip_prog}, flipped it"
            elif open_seat and hostile:
                role = f"Won a targeted open seat ({hostile.replace("'s", '')})"  # "(NRCC target list)"
            elif won_as_incumbent and (protect or hostile):
                if protect and hostile:
                    role = f"{protect} incumbent on {hostile}, survived"
                elif hostile:
                    role = f"On {hostile}, survived"
                else:
                    role = f"{protect} incumbent, held on"

        out.append({"bioguide_id": m.bioguide_id, "seat_flipped": flipped, "seat_flipped_how": how, "race_role": role,
                    "targeting": json.dumps(targeting), "issue_pac_support": json.dumps(issue_support),
                    "red_to_blue": any(r["program"] == "Red to Blue" for r in mine)})

    df = pd.DataFrame(out)
    df.to_csv(INTERIM / "targeting.csv", index=False)
    names = seated.set_index("bioguide_id").name.to_dict(); seats = seated.set_index("bioguide_id").seat.to_dict()
    roles = df[df.race_role.notna()]
    write_report("targeting", "2026 targeting lists, seat flips, race roles", {
        "Summary": [f"- seats flipped: {int(df.seat_flipped.sum())}", f"- members with a race role: {len(roles)}",
                    f"- members on any list: {int((df.targeting != '[]').sum())}", f"- members with issue PAC support: {int((df.issue_pac_support != '[]').sum())}",
                    f"- Red to Blue members: {int(df.red_to_blue.sum())}"],
        "Race roles": [f"- {seats[r.bioguide_id]} {names[r.bioguide_id]}: {r.race_role}" for r in roles.itertuples()],
        **issues,
    })
    log(f"12: flipped={int(df.seat_flipped.sum())} roles={len(roles)} on-lists={int((df.targeting != '[]').sum())} "
        f"issue-PAC={int((df.issue_pac_support != '[]').sum())} R2B={int(df.red_to_blue.sum())}")


if __name__ == "__main__":
    main()
