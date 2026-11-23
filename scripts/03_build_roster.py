"""Build the 120th Congress roster: one row per seat.

Inputs
  data/raw/legislators/legislators-{current,historical}.yaml   (01)
  data/interim/results_2026_wiki.csv                           (02)
  data/overrides/results_2026.csv      manual results; beat Wikipedia for that seat
  data/overrides/bioguide_crosswalk.csv  winner name -> bioguide (incl. newly assigned IDs)

Rules
  - Seats not on the 2026 ballot (Senate classes 1/3 except specials, PR's 4-year
    Resident Commissioner) keep their current holder: status "continuing".
  - Seats on the ballot use the called winner (override > Wikipedia).
    status "reelected" if the winner is the seat's incumbent, else "elected".
  - Uncalled seats are status "pending" with no member (candidates kept).
  - Winners are matched to bioguide IDs: crosswalk > Wikipedia title == id.wikipedia
    > fuzzy name match among anyone who has ever served from that state.
    Unmatched winners are new to Congress and get a provisional ID "NEW-<seat>"
    until congress-legislators assigns one (add it to bioguide_crosswalk.csv).

Output: data/interim/roster_120.csv, data/reports/roster_120.md
"""

from __future__ import annotations

import json
import re
import sys

import pandas as pd
import yaml
from rapidfuzz import fuzz

from common import (DELEGATE_ABBRS, INTERIM, OVERRIDES, RAW, STATE_ABBRS, log, norm_name,
                    party_code, seat_key, strip_accents, write_report)
from config import FOUR_YEAR_DELEGATES, INCLUDE_DELEGATES, NAME_MATCH_THRESHOLD

PARTICLES = {"von", "van", "de", "del", "della", "der", "la", "le", "da", "di", "st", "st.", "mc", "o"}


def load_yaml(name: str) -> list[dict]:
    path = RAW / "legislators" / name
    with path.open() as f:
        return yaml.load(f, Loader=getattr(yaml, "CSafeLoader", yaml.SafeLoader))


def name_variants(p: dict) -> list[str]:
    n = p["name"]
    first, last = n.get("first", ""), n.get("last", "")
    v = {n.get("official_full", ""), f"{first} {last}", f"{first} {n.get('middle', '')} {last}"}
    if n.get("nickname"):
        v.add(f"{n['nickname']} {last}")
    return [norm_name(x) for x in v if x and x.strip()]


def initials(p: dict) -> set[str]:
    n = p["name"]
    return {x[0].lower() for x in (n.get("first"), n.get("nickname"), n.get("middle"),
                                   ((n.get("official_full") or "").split() or [""])[0]) if x}


def guess_last_name(full: str) -> str:
    toks = re.sub(r",?\s+(Jr\.?|Sr\.?|II|III|IV)$", "", full.strip()).split()
    if len(toks) <= 1:
        return full.strip()
    last = [toks[-1]]
    i = len(toks) - 2
    while i > 0 and toks[i].lower() in PARTICLES:
        last.insert(0, toks[i])
        i -= 1
    return " ".join(last)


def read_override(name: str, cols: list[str]) -> pd.DataFrame:
    path = OVERRIDES / name
    if not path.exists():
        pd.DataFrame(columns=cols).to_csv(path, index=False)
    return pd.read_csv(path, dtype=str, comment="#").fillna("")


def main() -> None:
    current = load_yaml("legislators-current.yaml")
    historical = load_yaml("legislators-historical.yaml")
    people = {p["id"]["bioguide"]: p for p in historical + current}  # current wins

    by_state: dict[str, list[str]] = {}
    by_wiki: dict[str, str] = {}
    for bid, p in people.items():
        for st in {t["state"] for t in p["terms"]}:
            by_state.setdefault(st, []).append(bid)
        if p["id"].get("wikipedia"):
            by_wiki[p["id"]["wikipedia"].replace("_", " ")] = bid

    # current holders by seat
    holders: dict[str, dict] = {}
    for p in current:
        t = p["terms"][-1]
        key = seat_key("senate" if t["type"] == "sen" else "house", t["state"],
                       t.get("district"), t.get("class"))
        holders[key] = {"bioguide": p["id"]["bioguide"], "party": t.get("party"), "person": p}

    wiki = pd.read_csv(INTERIM / "results_2026_wiki.csv", dtype={"district": "Int64", "senate_class": "Int64"})
    res_override = read_override("results_2026.csv", [
        "seat", "winner_name", "winner_party", "winner_wiki_title", "status", "source", "source_url", "note"])
    xwalk = read_override("bioguide_crosswalk.csv", ["state", "name", "bioguide_id", "last_name", "note"])
    xwalk_map = {(r.state, norm_name(r["name"])): r for _, r in xwalk.iterrows()}

    results = {r.seat: r._asdict() for r in wiki.itertuples(index=False)}
    for _, o in res_override.iterrows():
        base = results.get(o.seat, {"seat": o.seat, "candidates": "[]"})
        base.update({
            "called": o.status != "pending",
            "winner_name": o.winner_name or None,
            "winner_party": party_code(o.winner_party) if o.winner_party else None,
            "winner_wiki_title": o.winner_wiki_title or None,
            "source": o.source or "override", "source_url": o.source_url,
        })
        results[o.seat] = base

    # ---- enumerate every seat
    seats: list[dict] = []
    house_seats = sorted(k for k in set(holders) | {k for k in results if "-S" not in k} if "-S" not in k)
    for k in house_seats:
        st = k.split("-")[0]
        if st in DELEGATE_ABBRS and not INCLUDE_DELEGATES:
            continue
        d = k.split("-")[1]
        seats.append({"seat": k, "chamber": "house", "state": st, "district": 0 if d == "AL" else int(d),
                      "senate_class": None, "up_2026": st not in FOUR_YEAR_DELEGATES})
    specials = {k for k, r in results.items() if r.get("chamber") == "senate" and not k.endswith("S2")}
    for st in STATE_ABBRS:
        if st == "DC":
            continue
        for cls in (1, 2, 3):
            k = seat_key("senate", st, None, cls)
            if k in holders or k in results:
                seats.append({"seat": k, "chamber": "senate", "state": st, "district": None,
                              "senate_class": cls, "up_2026": cls == 2 or k in specials})

    issues: dict[str, list[str]] = {"Fuzzy matches (check)": [], "New members (provisional IDs)": [],
                                    "Multi-word names (confirm last_name in bioguide_crosswalk.csv)": [],
                                    "Pending seats": [], "Incumbent mismatches (Wikipedia vs congress-legislators)": [],
                                    "Errors": []}

    def match(winner: str, wiki_title: str | None, state: str) -> tuple[str | None, str]:
        n = norm_name(winner)
        if (state, n) in xwalk_map and xwalk_map[(state, n)].bioguide_id:
            return xwalk_map[(state, n)].bioguide_id, "crosswalk"
        if wiki_title and wiki_title in by_wiki:
            return by_wiki[wiki_title], "wikipedia_id"
        best, best_score = None, 0.0
        w_initial = strip_accents(winner.strip())[:1].lower()
        for bid in by_state.get(state, []):
            p = people[bid]
            if norm_name(p["name"]["last"]).split()[-1:] != n.split()[-1:]:
                continue
            if p["terms"][-1]["end"] < "1981-01-01" or w_initial not in initials(p):
                continue  # e.g. "J. D. Ford" (2026) must not match George Ford (1880s)
            s = max(fuzz.token_sort_ratio(n, v) for v in name_variants(p))
            if s > best_score or (s == best_score and best and p["terms"][-1]["end"] > people[best]["terms"][-1]["end"]):
                best, best_score = bid, s
        if best and best_score >= NAME_MATCH_THRESHOLD:
            if True:  # report every fuzzy match, even perfect scores
                issues["Fuzzy matches (check)"].append(
                    f"- {state}: '{winner}' -> {best} ({people[best]['name'].get('official_full')}) score {best_score:.0f}")
            return best, "fuzzy"
        return None, "none"

    rows = []
    for s in seats:
        k = s["seat"]
        holder = holders.get(k)
        row = {**s, "bioguide_id": None, "provisional_id": False, "name": None, "last_name": None,
               "party": None, "status": None, "new_to_congress": False, "match_method": None,
               "wiki_title": None, "candidates": "[]", "source": None, "source_url": None}
        if not s["up_2026"]:
            if not holder:
                row["status"] = "vacant"
                issues["Pending seats"].append(f"- {k}: vacant, not on 2026 ballot")
            else:
                p = holder["person"]
                row.update(bioguide_id=holder["bioguide"], name=p["name"].get("official_full") or
                           f"{p['name']['first']} {p['name']['last']}", last_name=p["name"]["last"],
                           party=party_code(holder["party"]), status="continuing",
                           match_method="current", source="congress-legislators")
            rows.append(row)
            continue

        r = results.get(k)
        if not r or not r.get("called") or not r.get("winner_name"):
            row.update(status="pending", candidates=(r or {}).get("candidates", "[]"),
                       source=(r or {}).get("source"), source_url=(r or {}).get("source_url"))
            cands = ", ".join(f"{c['name']} ({c['party']})" for c in json.loads(row["candidates"] or "[]")[:6])
            issues["Pending seats"].append(f"- {k}: {cands or 'no candidates parsed'}")
            rows.append(row)
            continue

        winner, wt = r["winner_name"], r.get("winner_wiki_title")
        wt = wt if isinstance(wt, str) and wt else None
        bid, how = match(winner, wt, s["state"])
        row.update(party=r["winner_party"], wiki_title=wt, source=r.get("source"),
                   source_url=r.get("source_url"), candidates=r.get("candidates", "[]"), match_method=how)
        if bid:
            p = people[bid]
            row.update(bioguide_id=bid, name=p["name"].get("official_full") or winner,
                       last_name=p["name"]["last"])
        else:
            xw = xwalk_map.get((s["state"], norm_name(winner)))
            row.update(bioguide_id=f"NEW-{k}", provisional_id=True, name=winner,
                       last_name=(xw.last_name if xw is not None and xw.last_name else guess_last_name(winner)),
                       new_to_congress=True)
            if len(winner.split()) > 2 and xw is None:
                issues["Multi-word names (confirm last_name in bioguide_crosswalk.csv)"].append(
                    f"- {k}: '{winner}' -> last name '{row['last_name']}'")
            issues["New members (provisional IDs)"].append(
                f"- {k}: {winner} ({row['party']}) -> NEW-{k}, last name '{row['last_name']}'")
        row["status"] = "reelected" if holder and holder["bioguide"] == row["bioguide_id"] else "elected"

        inc = r.get("incumbent_name")
        if holder and isinstance(inc, str) and inc:
            hp = holder["person"]
            if norm_name(inc).split()[-1:] != norm_name(hp["name"]["last"]).split()[-1:]:
                issues["Incumbent mismatches (Wikipedia vs congress-legislators)"].append(
                    f"- {k}: Wikipedia '{inc}' vs current '{hp['name'].get('official_full')}'")
        rows.append(row)

    df = pd.DataFrame(rows)
    for c in ("district", "senate_class"):
        df[c] = df[c].astype("Int64")

    # ---- validation
    n_house = (df.chamber == "house").sum()
    n_vote = ((df.chamber == "house") & df.state.isin(STATE_ABBRS) & (df.state != "DC")).sum()
    n_sen = (df.chamber == "senate").sum()
    if n_vote != 435:
        issues["Errors"].append(f"- expected 435 voting House seats, got {n_vote}")
    if n_sen != 100:
        issues["Errors"].append(f"- expected 100 Senate seats, got {n_sen}")
    dupes = df[df.bioguide_id.notna() & df.bioguide_id.duplicated(keep=False)]
    for _, d in dupes.iterrows():
        issues["Errors"].append(f"- duplicate member {d.bioguide_id} in seat {d.seat}")

    df.to_csv(INTERIM / "roster_120.csv", index=False)
    rpt = write_report("roster_120", "120th Congress roster build", issues)
    counts = df.status.value_counts().to_dict()
    log(f"03: seats={len(df)} (house incl. delegates={n_house}, senate={n_sen}) status={counts} "
        f"new={int(df.new_to_congress.sum())} -> report {rpt}")
    if issues["Errors"]:
        log("03: ERRORS:\n" + "\n".join(issues["Errors"]))
        sys.exit(1)


if __name__ == "__main__":
    main()
