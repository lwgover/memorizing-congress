"""2026-cycle fundraising totals from OpenFEC.

For each seated member: total receipts for the two-year period 2025-2026
(cycle=2026, election_full=false, so House and Senate numbers are comparable),
plus cash on hand and disbursements for the reveal screen.

Candidate ID choice
  - congress-legislators id.fec list, filtered to the member's current office
    (H/S prefix + state), e.g. a senator's old House ID is ignored.
  - New members (no IDs yet): OpenFEC candidate search by name + state + office,
    2026 election year. Fix bad picks in data/overrides/fec_ids.csv (bioguide_id, fec_id).
  - If several IDs qualify, the one with the largest 2026 receipts wins.

API key: FEC_API_KEY in .env (free from https://api.data.gov/signup/). Without it the
public DEMO_KEY is used (10 requests/hour), so expect many runs; responses are cached
in data/raw/fec/ so each run picks up where the last stopped. Rerun with --refresh
after new reports are filed (post-general, then year-end).

Output: data/interim/fec.csv, data/reports/fec.md
"""

from __future__ import annotations

import json
import os
import sys

import pandas as pd
import yaml
from dotenv import load_dotenv

from common import INTERIM, OVERRIDES, RAW, http_get, log, norm_name, write_report
from config import FEC_CYCLE

API = "https://api.open.fec.gov/v1"
CACHE = RAW / "fec"


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


def main() -> None:
    refresh = "--refresh" in sys.argv
    load_dotenv()
    key = os.getenv("FEC_API_KEY") or "DEMO_KEY"
    if key == "DEMO_KEY":
        log("09: FEC_API_KEY not set; using DEMO_KEY (10 req/hour). Progress is cached.")

    roster = pd.read_csv(INTERIM / "roster_120.csv")
    seated = roster[roster.bioguide_id.notna()]
    with (RAW / "legislators" / "legislators-current.yaml").open() as f:
        cur = {p["id"]["bioguide"]: p for p in yaml.load(f, Loader=getattr(yaml, "CSafeLoader", yaml.SafeLoader))}
    with (RAW / "legislators" / "legislators-historical.yaml").open() as f:
        hist = {p["id"]["bioguide"]: p for p in yaml.load(f, Loader=getattr(yaml, "CSafeLoader", yaml.SafeLoader))}
    ov_path = OVERRIDES / "fec_ids.csv"
    if not ov_path.exists():
        pd.DataFrame(columns=["bioguide_id", "fec_id", "note"]).to_csv(ov_path, index=False)
    overrides = dict(pd.read_csv(ov_path, dtype=str).dropna(subset=["fec_id"])[["bioguide_id", "fec_id"]].values)

    rows, issues, stopped = [], {"No FEC candidate found": [], "Search-based IDs (verify)": [], "No 2026 totals": []}, False
    for m in seated.itertuples():
        office = "H" if m.chamber == "house" else "S"
        if stopped:
            break
        try:
            if m.bioguide_id in overrides:
                ids, how = [overrides[m.bioguide_id]], "override"
            else:
                p = cur.get(m.bioguide_id) or hist.get(m.bioguide_id)
                all_ids = (p or {}).get("id", {}).get("fec", []) if p else []
                ids = [i for i in all_ids if i[0] == office and i[2:4] == m.state]
                how = "congress-legislators"
                if not ids:
                    d = get("/candidates/search/", {"q": m.name, "state": m.state, "office": office,
                                                    "election_year": FEC_CYCLE, "per_page": 10},
                            key, f"search/{m.bioguide_id}.json", refresh)
                    last = norm_name(str(m.last_name)).split()[-1:]
                    ids = [r["candidate_id"] for r in d.get("results", [])
                           if norm_name(r["name"].split(",")[0]).split()[-1:] == last]
                    how = "search"
                    if ids:
                        issues["Search-based IDs (verify)"].append(f"- {m.seat} {m.name}: {ids}")
            if not ids:
                issues["No FEC candidate found"].append(f"- {m.seat} {m.name}")
                continue
            best = None
            for cid in ids:
                d = get(f"/candidate/{cid}/totals/", {"cycle": FEC_CYCLE, "election_full": "false"},
                        key, f"totals/{cid}_{FEC_CYCLE}.json", refresh)
                for t in d.get("results", []):
                    if best is None or (t.get("receipts") or 0) > (best.get("receipts") or 0):
                        best = t
            if not best:
                issues["No 2026 totals"].append(f"- {m.seat} {m.name}: {ids}")
                continue
            rows.append({"bioguide_id": m.bioguide_id, "fec_id": best["candidate_id"], "fec_id_source": how,
                         "receipts": best.get("receipts"), "cash_on_hand": best.get("last_cash_on_hand_end_period"),
                         "disbursements": best.get("disbursements"), "coverage_end": best.get("coverage_end_date")})
        except RateLimited:
            log(f"09: rate limited at {m.seat}; rerun later to continue (cached so far)")
            stopped = True

    df = pd.DataFrame(rows, columns=["bioguide_id", "fec_id", "fec_id_source", "receipts", "cash_on_hand",
                                     "disbursements", "coverage_end"])
    df.to_csv(INTERIM / "fec.csv", index=False)
    write_report("fec", "FEC 2026 fundraising", {**issues, "Status": [
        f"- {len(df)}/{len(seated)} members with totals" + (" (stopped early: rate limit)" if stopped else "")]})
    log(f"09: totals for {len(df)}/{len(seated)} members" + (" (partial)" if stopped else ""))


if __name__ == "__main__":
    main()
