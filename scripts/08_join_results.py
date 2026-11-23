"""Election results: each member's last 2-way share, and Kamala 2-way by district/state.

last2Way (member's share of the top two candidates in their most recent general):
  - House 2026 winners: per-state Wikipedia pages "2026 United States House of
    Representatives election(s) in <State>", {{Election box}} general-election boxes (votes).
  - PR Resident Commissioner: 2024 page, same parser.
  - Senate: class II + 2026 specials from the 2026 results table (02); class I from the
    2024 Senate page; class III from the 2022 page. Ranked-choice races use the final round.
  - share = member / (member + strongest opponent). Unopposed = 1.0.

kamala2Way = Harris / (Harris + Trump), 2024:
  - Senators, at-large seats, DC: statewide, FEC official results (2024presgeresults.xlsx).
  - Districts, unchanged lines: data/inputs/pres_2024_by_cd119.csv (2024 lines; you supply,
    see DATA_SOURCES.md). Missing file -> null, source "missing".
  - Districts redrawn for 2026 (06): null/"pending" until data/overrides/kamala_new_districts.csv
    has the vote counts -> source "new-lines".
  - Territories (no presidential vote): null, source "n/a".

Output: data/interim/results.csv, data/reports/results.md
"""

from __future__ import annotations

import json
import re
import sys

import pandas as pd

from common import (ABBR_TO_NAME, party_code, DATA, INTERIM, OVERRIDES, RAW, download, log, norm_name, write_report)
from config import COUNT_COURT_MAPS  # noqa: F401  (rule applied in 06)
from wiki import REF_RE, clean_link, fetch_page, parse_senate

FEC_PRES = "https://www.fec.gov/resources/cms-content/documents/2024presgeresults.xlsx"
INPUTS = DATA / "inputs"
AT_LARGE_TITLE = {"DC": "the District of Columbia", "MP": "the Northern Mariana Islands",
                  "VI": "the United States Virgin Islands"}

BOX_RE = re.compile(r"\{\{\s*Election box begin[^}]*?\|\s*title\s*=\s*(?P<title>.*?)\}\}(?P<body>.*?)\{\{\s*Election box end\s*\}\}",
                    re.S | re.I)
CAND_RE = re.compile(r"\{\{\s*Election box (?P<kind>candidate|winning candidate)[^|]*(?P<body>\|.*?)\}\}", re.S | re.I)
ORD_RE = re.compile(r"(\d+)(?:st|nd|rd|th) congressional district", re.I)


def template_fields(body: str) -> dict[str, str]:
    """Split '|a=1|b=[[x|y]]' on top-level pipes (not inside [[ ]] or {{ }})."""
    parts, depth, cur, i = [], 0, [], 0
    while i < len(body):
        two = body[i:i + 2]
        if two in ("[[", "{{"):
            depth += 1; cur.append(two); i += 2; continue
        if two in ("]]", "}}"):
            depth = max(depth - 1, 0); cur.append(two); i += 2; continue
        if body[i] == "|" and depth == 0:
            parts.append("".join(cur)); cur = []; i += 1; continue
        cur.append(body[i]); i += 1
    parts.append("".join(cur))
    out = {}
    for p in parts:
        if "=" in p:
            k, v = p.split("=", 1)
            out[k.strip().lower()] = v.strip()
    return out


def field(body: str, name: str) -> str:
    return template_fields(body).get(name, "")


def num(s: str) -> float | None:
    s = re.sub(r"[^\d.]", "", s.replace("'''", ""))
    try:
        return float(s) if s else None
    except ValueError:
        return None


def house_page(st: str, year: int, force: bool) -> tuple[str, int] | None:
    name = AT_LARGE_TITLE.get(st, ABBR_TO_NAME[st])
    for t in (f"{year} United States House of Representatives elections in {name}",
              f"{year} United States House of Representatives election in {name}",
              f"{year} United States Resident Commissioner election in Puerto Rico" if st == "PR" else None):
        if not t:
            continue
        try:
            text, rev, _ = fetch_page(t, force)
            if text:
                return text, rev
        except (KeyError, IndexError):
            continue
    return None


def parse_house_boxes(text: str, st: str) -> list[dict]:
    """General-election boxes only. District from the box title, else the section heading."""
    text = REF_RE.sub("", text)
    out = []
    heads = [(m.start(), m.group(1)) for m in re.finditer(r"\n==+\s*([^=\n]+?)\s*==+", text)]
    for m in BOX_RE.finditer(text):
        title = m.group("title")
        if re.search(r"primary|runoff|special|convention|caucus", title, re.I):
            continue
        om = ORD_RE.search(title)
        if om:
            dist = int(om.group(1))
        elif re.search(r"at-large|at large|delegate|resident commissioner", title, re.I):
            dist = 0
        else:
            h = [n for p, n in heads if p < m.start()]
            hm = re.search(r"District (\d+)", h[-1]) if h else None
            if not hm:
                continue
            dist = int(hm.group(1))
        for c in CAND_RE.finditer(m.group("body")):
            b = c.group("body")
            raw = field(b, "candidate")
            name, _ = clean_link(raw.replace("'''", ""))
            name = re.sub(r"\s*\((?:incumbent|write-in)\)", "", name, flags=re.I).strip()
            if not name:
                continue
            out.append({"state": st, "district": dist, "candidate": name, "party": field(b, "party"),
                        "votes": num(field(b, "votes")), "pct": num(field(b, "percentage")),
                        "bold": raw.startswith("'''") or c.group("kind").lower().startswith("winning")})
    return out


def two_way(member_last: str, rows: list[dict], key: str) -> tuple[float | None, str, str | None, str | None]:
    """Member share of the top two, plus the top opponent's name and party (D/R/I).

    rows have candidate, party (label) and key (votes or pct).
    """
    # Max per name: fusion ballots (CT/NY) list each party line then a total; ranked-choice
    # races list round 1 then the final round. Both totals are >= any partial line.
    tally: dict[str, float] = {}
    party: dict[str, str] = {}
    for r in rows:
        v = r.get(key)
        if v is None or pd.isna(v):
            continue
        name = r["candidate"].replace("''", "").strip()
        tally[name] = max(tally.get(name, 0.0), float(v))
        lab = r.get("party")
        if isinstance(lab, str) and lab and name not in party:
            party[name] = party_code(lab)
    if not tally:
        return None, "no_votes", None, None
    last = norm_name(member_last).split()[-1:] if member_last else []
    mine = [n for n in tally if norm_name(n).split()[-1:] == last]
    if not mine:
        return None, "member_not_found", None, None
    me = tally[mine[0]]
    others = {n: v for n, v in tally.items() if n != mine[0]}
    if not others or max(others.values()) == 0:
        return 1.0, "unopposed", None, None
    opp = max(others, key=others.get)
    return round(me / (me + others[opp]), 4), "ok", opp, party.get(opp)


def main() -> None:
    force = "--force" in sys.argv
    roster = pd.read_csv(INTERIM / "roster_120.csv", dtype={"district": "Int64", "senate_class": "Int64"})
    seated = roster[roster.bioguide_id.notna()].copy()
    issues: dict[str, list[str]] = {"last2Way not found": [], "Kamala missing": [], "Notes": []}

    # ---------------- House boxes (2026, plus PR 2024)
    boxes, revs = [], {}
    for st in sorted(seated[seated.chamber == "house"].state.unique()):
        year = 2024 if st == "PR" else 2026
        page = house_page(st, year, force)
        if not page:
            issues["Notes"].append(f"- {st}: no {year} House results page found")
            continue
        text, rev = page
        revs[st] = rev
        for b in parse_house_boxes(text, st):
            boxes.append({**b, "year": year, "source_url": f"https://en.wikipedia.org/w/index.php?oldid={rev}"})
    hb = pd.DataFrame(boxes)
    hb.to_csv(INTERIM / "house_boxes.csv", index=False)

    # ---------------- Senate tables
    senate_rows: dict[tuple[str, int, int], list[dict]] = {}
    for year, cls in ((2024, 1), (2022, 3)):
        text, rev, _ = fetch_page(f"{year} United States Senate elections", force)
        for r in parse_senate(text, year, cls):
            if any(c["winner"] for c in r["candidates"]):
                senate_rows.setdefault((r["state"], r["senate_class"], year), [
                    {"candidate": c["name"], "pct": c["pct"], "party": c["party"]} for c in r["candidates"]])
    w26 = pd.read_csv(INTERIM / "results_2026_wiki.csv", dtype={"senate_class": "Int64"})
    for r in w26[w26.chamber == "senate"].itertuples():
        senate_rows[(r.state, int(r.senate_class), 2026)] = [
            {"candidate": c["name"], "pct": c["pct"], "party": c["party"]} for c in json.loads(r.candidates)]

    # ---------------- last2Way
    out = []
    for m in seated.itertuples():
        share, how, year, src, opp, opp_party = None, "", None, "", None, None
        if m.chamber == "house":
            year = 2024 if m.state == "PR" else 2026
            rows = hb[(hb.state == m.state) & (hb.district == int(m.district)) & (hb.year == year)] if len(hb) else hb
            if len(rows):
                share, how, opp, opp_party = two_way(m.last_name, rows.to_dict("records"), "votes")
                if share is None:
                    share, how, opp, opp_party = two_way(m.last_name, rows.to_dict("records"), "pct")
                src = rows.source_url.iloc[0]
            if share is None and year == 2026:  # fall back to the national results table (pct)
                main = w26[w26.seat == m.seat]
                if len(main):
                    cands = [{"candidate": c["name"], "pct": c["pct"], "party": c["party"]} for c in json.loads(main.candidates.iloc[0])]
                    s2, h2, o2, op2 = two_way(m.last_name, cands, "pct")
                    if s2 is not None:
                        share, how, src, opp, opp_party = s2, f"{h2} (national table)", main.source_url.iloc[0], o2, op2
        else:
            cls = int(m.senate_class)
            year = 2026 if m.status in ("reelected", "elected") else {1: 2024, 2: 2026, 3: 2022}[cls]
            rows = senate_rows.get((m.state, cls, year))
            if rows:
                share, how, opp, opp_party = two_way(m.last_name, rows, "pct")
        if share is None:
            issues["last2Way not found"].append(f"- {m.seat} {m.name}: {how or 'no race found'} ({year})")
        out.append({"bioguide_id": m.bioguide_id, "last2way_year": year, "last2way_share": share,
                    "last2way_note": how, "last2way_source": src,
                    "last2way_opponent": opp, "last2way_opponent_party": opp_party})
    res = pd.DataFrame(out)

    # ---------------- Kamala
    fec = pd.read_excel(download(FEC_PRES, RAW / "fec" / "2024presgeresults.xlsx", force=force), header=0)
    fec = fec[fec.STATE.astype(str).str.len() == 2]
    statewide = {r.STATE: round(r.HARRIS / (r.HARRIS + r.TRUMP), 4) for r in fec.itertuples()}

    INPUTS.mkdir(exist_ok=True)
    cd_path = INPUTS / "pres_2024_by_cd119.csv"
    cd = pd.read_csv(cd_path, dtype={"state": str}) if cd_path.exists() else pd.DataFrame(
        columns=["state", "district", "harris", "trump", "source", "source_url"])
    cd_share = {(r.state, int(r.district)): round(r.harris / (r.harris + r.trump), 4) for r in cd.itertuples()}
    newl_path = OVERRIDES / "kamala_new_districts.csv"
    if not newl_path.exists():
        pd.DataFrame(columns=["state", "district", "dem_votes", "rep_votes", "source", "source_url"]).to_csv(newl_path, index=False)
    newl = pd.read_csv(newl_path)
    new_share = {(r.state, int(r.district)): round(r.dem_votes / (r.dem_votes + r.rep_votes), 4) for r in newl.itertuples()}
    redrawn = pd.read_csv(INTERIM / "redrawn.csv")
    redrawn_ids = set(redrawn[redrawn.counts_as_redrawn].id)

    kam = []
    for m in seated.itertuples():
        st = m.state
        if st in {"AS", "GU", "MP", "PR", "VI"}:
            v, s = None, "n/a"
        elif m.chamber == "senate" or int(m.district) == 0:
            v, s = statewide.get(st), "statewide"
        elif m.seat in redrawn_ids:
            key = (st, int(m.district))
            v, s = (new_share[key], "new-lines") if key in new_share else (None, "pending")
        else:
            key = (st, int(m.district))
            v, s = (cd_share[key], "2024-lines") if key in cd_share else (None, "missing")
        if v is None and s == "missing":
            issues["Kamala missing"].append(f"- {m.seat}")
        kam.append({"bioguide_id": m.bioguide_id, "kamala2way": v, "kamala2way_source": s})
    res = res.merge(pd.DataFrame(kam), on="bioguide_id")
    res.to_csv(INTERIM / "results.csv", index=False)

    counts = res.kamala2way_source.value_counts().to_dict()
    issues["Notes"].append(f"- Kamala sources: {counts}")
    if not cd_path.exists():
        issues["Notes"].append(f"- {cd_path.relative_to(DATA.parent)} not found: district-level Kamala values are null")
    write_report("results", "Election results join", issues)
    log(f"08: last2Way found {res.last2way_share.notna().sum()}/{len(res)}, kamala {counts}")


if __name__ == "__main__":
    main()
