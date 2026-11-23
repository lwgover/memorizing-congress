"""Join Split Ticket WAR to members, in member perspective, with a trajectory label.

Input: data/split-ticket-war-database-*.csv (Year, Chamber, Geography, Democrat, Republican, WAR, Sortable)
       Sortable = WAR with Democratic overperformance negative.

Who won each race? The CSV lists both candidates but not the winner, so the winner is
whoever held that seat next:
  - Year Y race -> the member whose term for that seat starts in Jan of Y+1
    (congress-legislators terms), or the 120th roster for Y = 2026.
  - That member's column is found by last-name match (fuzzy fallback), with
    data/overrides/war_crosswalk.csv for anything the matcher can't resolve.
Member WAR = -Sortable if they're in the Democrat column, +Sortable if Republican
(independents keep the side of the column they're listed in, e.g. "Dan Osborn (Ind)").

Fails loudly if a current member's race row exists but their name can't be matched.

Output: data/interim/war.csv (one row per member-race), data/interim/war_summary.csv,
        data/reports/war.md
"""

from __future__ import annotations

import json
import re
import sys
from datetime import date

import numpy as np
import pandas as pd
import yaml
from rapidfuzz import fuzz

from common import DATA, INTERIM, NAME_TO_ABBR, OVERRIDES, RAW, log, norm_name, write_report

TRAJ_SLOPE = 0.75      # WAR points per 2-year cycle to call rising/falling
TRAJ_VOLATILE_SD = 2.5  # residual SD above this (and above |slope|) -> volatile


def load_people() -> dict[str, dict]:
    people = {}
    for f in ("legislators-historical.yaml", "legislators-current.yaml"):
        with (RAW / "legislators" / f).open() as fh:
            for p in yaml.load(fh, Loader=getattr(yaml, "CSafeLoader", yaml.SafeLoader)):
                people[p["id"]["bioguide"]] = p
    return people


def geo_to_seat(chamber: str, geo: str) -> tuple[str, int | None]:
    if chamber == "House":
        st, d = geo.split("-")
        return st, 0 if d == "AL" else int(d)
    return NAME_TO_ABBR[re.sub(r"\s+Spec(ial)?$", "", geo)], None


def winners_for(people, roster, year, chamber, st, dist) -> list[str]:
    """bioguide IDs who started a term for this seat in early year+1."""
    if year == 2026:
        if chamber == "House":
            r = roster[(roster.chamber == "house") & (roster.state == st) & (roster.district == dist)]
        else:
            r = roster[(roster.chamber == "senate") & (roster.state == st) & (roster.up_2026)]
        return [b for b in r.bioguide_id.dropna()]
    lo, hi = date(year, 11, 1).isoformat(), date(year + 1, 3, 1).isoformat()  # Mar: late-seated (Tenney 2021)
    out = []
    for bid, p in people.items():
        for t in p["terms"]:
            if t["state"] != st or not (lo <= t["start"] <= hi) or t.get("how") == "appointment":
                continue
            if chamber == "House" and t["type"] == "rep" and (t.get("district") or 0) == dist:
                out.append(bid)
            elif chamber == "Senate" and t["type"] == "sen":
                out.append(bid)
    return out


def name_score(cand: str, variants: list[str], last: str) -> float:
    c = norm_name(cand)
    if not c:
        return 0
    s = max((fuzz.token_sort_ratio(c, v) for v in variants), default=0)
    if last and c.split()[-1] == last.split()[-1]:
        s = max(s, 90)
    elif last and last.split()[-1] in c.split():
        s = max(s, 85)
    return s


def trajectory(series: list[tuple[int, float]]) -> str:
    if len(series) < 2:
        return "single"
    yrs = np.array([y for y, _ in series], float)
    vals = np.array([v for _, v in series], float)
    slope, icpt = np.polyfit(yrs, vals, 1)
    slope *= 2  # per cycle
    resid = vals - (slope / 2 * yrs + icpt)
    sd = float(np.sqrt((resid ** 2).sum() / max(len(vals) - 2, 1))) if len(vals) > 2 else 0.0
    if sd > TRAJ_VOLATILE_SD and sd > abs(slope):
        return "volatile"
    if slope >= TRAJ_SLOPE:
        return "rising"
    if slope <= -TRAJ_SLOPE:
        return "falling"
    return "steady"


def main() -> None:
    src = sorted(DATA.glob("split-ticket-war-database-*.csv"))[-1]
    war = pd.read_csv(src, encoding="utf-8-sig")
    roster = pd.read_csv(INTERIM / "roster_120.csv", dtype={"district": "Int64", "senate_class": "Int64"})
    people = load_people()
    xw_path = OVERRIDES / "war_crosswalk.csv"
    if not xw_path.exists():
        pd.DataFrame(columns=["Year", "Chamber", "Geography", "candidate", "bioguide_id", "note"]).to_csv(xw_path, index=False)
    xw = pd.read_csv(xw_path, dtype=str).fillna("")
    xw_map = {(int(r.Year), r.Chamber, r.Geography): r for r in xw.itertuples()}

    roster_names = {r.bioguide_id: (r.name, r.last_name) for r in roster.itertuples() if isinstance(r.bioguide_id, str)}

    def variants(bid):
        if bid in people:
            n = people[bid]["name"]
            v = [n.get("official_full", ""), f"{n['first']} {n['last']}", f"{n.get('nickname', '')} {n['last']}"]
            return [norm_name(x) for x in v if x.strip()], norm_name(n["last"])
        name, last = roster_names.get(bid, ("", ""))
        return [norm_name(name)], norm_name(last or "")

    rows, unmatched, ambiguous = [], [], []
    for r in war.itertuples(index=False):
        st, dist = geo_to_seat(r.Chamber, r.Geography)
        key = (int(r.Year), r.Chamber, r.Geography)
        cands = winners_for(people, roster, int(r.Year), r.Chamber, st, dist)
        best = None
        if key in xw_map:
            o = xw_map[key]
            side = "D" if norm_name(o.candidate) == norm_name(str(r.Democrat)) else "R"
            best = (o.bioguide_id, side, 100.0, "crosswalk")
        else:
            scored = []
            for bid in cands:
                v, last = variants(bid)
                for side, cand in (("D", r.Democrat), ("R", r.Republican)):
                    scored.append((name_score(str(cand), v, last), bid, side))
            scored.sort(reverse=True)
            if scored and scored[0][0] >= 85:
                if len(scored) > 1 and scored[1][0] == scored[0][0] and scored[1][1] != scored[0][1]:
                    ambiguous.append(f"- {key}: {scored[:2]}")
                best = (scored[0][1], scored[0][2], scored[0][0], "terms")
        if not best:
            unmatched.append({"Year": r.Year, "Chamber": r.Chamber, "Geography": r.Geography,
                              "Democrat": r.Democrat, "Republican": r.Republican, "term_winners": ",".join(cands)})
            continue
        bid, side, score, how = best
        member_war = -float(r.Sortable) if side == "D" else float(r.Sortable)
        opp_raw = str(r.Republican if side == "D" else r.Democrat)
        opp_party = "I" if "(Ind)" in opp_raw else ("R" if side == "D" else "D")
        rows.append({"bioguide_id": bid, "year": int(r.Year), "chamber": r.Chamber.lower(), "geography": r.Geography,
                     "column": side, "candidate": r.Democrat if side == "D" else r.Republican,
                     "opponent": re.sub(r"\s*\(Ind\)\s*", "", opp_raw).strip(), "opponent_party": opp_party,
                     "war": round(member_war, 2), "match": how, "score": round(score)})

    df = pd.DataFrame(rows).drop_duplicates(["bioguide_id", "year", "chamber"])
    df.to_csv(INTERIM / "war.csv", index=False)

    # summary per current member
    seated = roster[roster.bioguide_id.notna()]
    summ = []
    for r in seated.itertuples():
        s = df[df.bioguide_id == r.bioguide_id].sort_values("year")
        series = list(zip(s.year, s.war))
        summ.append({"bioguide_id": r.bioguide_id,
                     # every WAR value carries its race: who they ran against
                     "war": json.dumps([{"year": int(y), "value": float(v), "chamber": c, "opponent": o, "opponentParty": op}
                                        for y, v, c, o, op in zip(s.year, s.war, s.chamber, s.opponent, s.opponent_party)],
                                       ensure_ascii=False),
                     "war_trajectory": trajectory(series) if series else None,
                     "n_races": len(series)})
    summ = pd.DataFrame(summ)
    summ.to_csv(INTERIM / "war_summary.csv", index=False)

    # loud failure: a current member's own latest race row exists, but wasn't matched to them
    um = pd.DataFrame(unmatched)
    errors = []
    for r in seated.itertuples():
        if r.status in ("reelected", "elected"):
            year, ch = 2026, "House" if r.chamber == "house" else "Senate"
        elif r.chamber == "senate":
            year, ch = {1: 2024, 3: 2022}.get(int(r.senate_class)), "Senate"
        else:
            continue
        if year is None or year < war.Year.min():
            continue
        has_row = df[(df.bioguide_id == r.bioguide_id) & (df.year == year)]
        if not has_row.empty or um.empty:
            continue
        geo = r.seat if ch == "House" else None
        cand_rows = um[(um.Year == year) & (um.Chamber == ch) &
                       ((um.Geography == geo) if geo else
                        (um.Geography.str.replace(r"\s+Spec(ial)?$", "", regex=True).map(NAME_TO_ABBR) == r.state))]
        if not cand_rows.empty:
            errors.append(f"- {r.seat} {r.name} ({r.bioguide_id}): {year} {ch} row exists but didn't match "
                          f"(D: {cand_rows.iloc[0].Democrat} / R: {cand_rows.iloc[0].Republican}) -> add to war_crosswalk.csv")

    no_war = seated.merge(summ, on="bioguide_id")
    no_war = no_war[no_war.n_races == 0]
    write_report("war", "WAR join", {
        "Errors (current members with an unmatched race row)": errors,
        "Ambiguous matches": ambiguous,
        "Current members with no WAR rows (likely uncontested / not in CSV)": [
            f"- {r.seat}: {r.name}" for r in no_war.itertuples()],
        "Unmatched race rows (all years; mostly non-current winners)": [
            f"- {u['Year']} {u['Chamber']} {u['Geography']}: D {u['Democrat']} / R {u['Republican']} "
            f"(term winners: {u['term_winners'] or 'none found'})" for u in unmatched[:400]],
    })
    log(f"07: {len(df)} member-races matched, {len(unmatched)} race rows unmatched, "
        f"{len(no_war)} current members without WAR, trajectories "
        f"{summ.war_trajectory.value_counts().to_dict()}")
    if errors:
        log("07: ERRORS:\n" + "\n".join(errors))
        sys.exit(1)


if __name__ == "__main__":
    main()
