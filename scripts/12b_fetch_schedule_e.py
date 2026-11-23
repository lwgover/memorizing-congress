"""FEC Schedule E (independent expenditures), 2026 cycle -> data/targeting_2026/generated/fec_schedule_e.csv

Fills the spending-based gaps in data/targeting_2026/README.md: which candidates each group
spent for (S) or against (O), with the summed amount. Groups and their committees:

  Fairshake (crypto):            Fairshake, Protect Progress, Defend American Jobs
  United Democracy Project:      United Democracy Project (AIPAC)
  Leading the Future (AI):       Leading the Future, Think Big, American Mission
  Club for Growth Action, LCV Victory Fund, Women Vote! (EMILYs List)

Method: look up each committee ID by name (/committees/?q=), then
/schedules/schedule_e/by_candidate/ with cycle=2026 (one row per candidate + support/oppose,
already summed). Rows use the same columns as issue_pac_lists.csv, with side = support|oppose
and the amount in `note`, so 12_targeting.py reads them alongside the team's lists.

Committee IDs can be pinned in data/overrides/fec_committees.csv (group, committee_name, committee_id)
if the name search picks the wrong one.

Needs FEC_API_KEY in .env (free from api.data.gov). DEMO_KEY allows ~10 requests/hour; responses
are cached in data/raw/fec_sched_e/, so reruns resume.

Usage: uv run scripts/12b_fetch_schedule_e.py [--refresh]
"""

from __future__ import annotations

import json
import os
import re
import sys

import pandas as pd
from dotenv import load_dotenv

from common import DATA, OVERRIDES, RAW, http_get, log

API = "https://api.open.fec.gov/v1"
CYCLE = 2026
CACHE = RAW / "fec_sched_e"
OUT = DATA / "targeting_2026" / "generated" / "fec_schedule_e.csv"
GROUPS = {
    "Fairshake": ["Fairshake", "Protect Progress", "Defend American Jobs"],
    "United Democracy Project (AIPAC)": ["United Democracy Project"],
    "Leading the Future": ["Leading the Future", "Think Big", "American Mission"],
    "Club for Growth Action": ["Club for Growth Action"],
    "LCV Victory Fund": ["LCV Victory Fund"],
    "Women Vote! (EMILYs List)": ["Women Vote!"],
}


class RateLimited(Exception):
    pass


def get(path: str, params: dict, key: str, cache_name: str, refresh: bool) -> dict:
    cache = CACHE / cache_name
    if cache.exists() and not refresh:
        return json.loads(cache.read_text())
    r = http_get(f"{API}{path}", params={**params, "api_key": key}, retries=2, retry_429=False)
    if r.status_code == 429:
        raise RateLimited()
    r.raise_for_status()
    d = r.json()
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(d))
    return d


def committee_id(name: str, pinned: dict, key: str, refresh: bool) -> str | None:
    if name in pinned:
        return pinned[name]
    d = get("/committees/", {"q": name, "per_page": 20, "cycle": CYCLE}, key, f"committee_{name.replace(' ', '_').replace('!', '')}.json", refresh)
    exact = [c for c in d.get("results", []) if c.get("name", "").upper().strip(" .") == name.upper().strip(" .!") or c.get("name", "").upper().startswith(name.upper().rstrip("!"))]
    return (exact or d.get("results", [None]))[0]["committee_id"] if (exact or d.get("results")) else None


def fec_name(s: str) -> str:
    """'TRAN, DEREK REP.' -> 'Derek Tran'."""
    s = re.sub(r"\b(REP|SEN|MR|MRS|MS|DR|HON|JR|SR|III|II)\.?(?=\s|$)", "", s.upper()).strip(" ,")
    if "," in s:
        last, first = [x.strip() for x in s.split(",", 1)]
        s = f"{first} {last}"
    return " ".join(w.capitalize() if w.isupper() else w for w in s.split())


def main() -> None:
    refresh = "--refresh" in sys.argv
    load_dotenv()
    key = os.getenv("FEC_API_KEY") or "DEMO_KEY"
    if key == "DEMO_KEY":
        log("12b: FEC_API_KEY not set; using DEMO_KEY (~10 requests/hour). Progress is cached.")
    pin_path = OVERRIDES / "fec_committees.csv"
    if not pin_path.exists():
        pd.DataFrame(columns=["group", "committee_name", "committee_id"]).to_csv(pin_path, index=False)
    pinned = {r.committee_name: r.committee_id for r in pd.read_csv(pin_path, dtype=str).fillna("").itertuples() if r.committee_id}

    rows, done, stopped = [], [], False
    try:
        for group, names in GROUPS.items():
            for name in names:
                cid = committee_id(name, pinned, key, refresh)
                if not cid:
                    log(f"12b: no FEC committee found for {name!r}; pin it in {pin_path.name}")
                    continue
                # page through every Schedule E transaction (keyset pagination), summing per candidate
                totals: dict[tuple, dict] = {}
                params = {"committee_id": cid, "cycle": CYCLE, "per_page": 100, "sort": "-expenditure_date"}
                page = 1
                while True:
                    d = get("/schedules/schedule_e/", params, key, f"sched_e_{cid}_{page}.json", refresh)
                    res = d.get("results", [])
                    for r in res:
                        if r.get("memo_code") == "X" or not r.get("candidate_id"):
                            continue  # memo lines repeat amounts already counted
                        k = (r["candidate_id"], r.get("support_oppose_indicator"))
                        t = totals.setdefault(k, {"r": r, "total": 0.0})
                        t["total"] += r.get("expenditure_amount") or 0
                    last = d.get("pagination", {}).get("last_indexes")
                    if not res or not last or len(res) < params["per_page"]:
                        break
                    params = {**params, **last}
                    page += 1
                for (cand, so), t in totals.items():
                    r = t["r"]
                    office, state, dist = r.get("candidate_office"), r.get("candidate_office_state") or "", r.get("candidate_office_district") or ""
                    side = "support" if so == "S" else "oppose"
                    rows.append({"committee": group, "program": f"Independent expenditures ({name})", "side": side,
                                 "state": state, "district": f"{state}-SEN" if office == "S" else f"{state}-{dist.zfill(2) if dist and dist != '00' else 'AL'}",
                                 "candidate": fec_name(r.get("candidate_name", "")), "party": "",
                                 "date_added": "", "date_precision": "unknown", "status": "active",
                                 "note": f"${round(t['total']):,} {'for' if side == 'support' else 'against'}; FEC {cand}",
                                 "source_url": f"https://www.fec.gov/data/independent-expenditures/?committee_id={cid}&cycle={CYCLE}"})
                done.append(name)
    except RateLimited:
        stopped = True
        log("12b: rate limited; rerun later to continue (cached so far)")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(rows).to_csv(OUT, index=False)
    log(f"12b: {len(rows)} candidate-level IE rows from {len(done)} committees" + (" (partial)" if stopped else ""))


if __name__ == "__main__":
    main()
