"""Official 2026 House results from state election offices -> data/interim/official_house_2026.csv

Preferred over Wikipedia for last2Way wherever a state publishes machine-readable counts.

States so far
  CA  Secretary of State JSON API: https://api.sos.ca.gov/returns/us-rep/district/{n}
      (the same data behind electionresults.sos.ca.gov). Semi-official until certification
      (Dec 12); the reporting line and time are kept per district.

  PA  Department of State public JSON API (no cookies or browser session needed):
      https://www.electionreturns.pa.gov/api/ElectionReturn/GetCountyData?countyName=X&electionid=117&electiontype=G
      One request per county (67, 1/second); "Representative in Congress" votes are summed per
      district across counties. Unofficial until certification.

Checked and not usable yet (2026-11-23):
  TX, NY  results sites refuse automated requests (HTTP 403)
  IL      only the 2026 primary is posted; the general comes after December certification

Output columns: seat, state, district, candidate, party (D/R/I), votes, pct, reporting,
reporting_time, source_url. Also checks each official winner against the roster and lists
mismatches in data/reports/official_results.md.

Usage: uv run scripts/08b_fetch_official_results.py [--force]
"""

from __future__ import annotations

import json
import re
import sys
import time

import pandas as pd

from common import INTERIM, RAW, http_get, log, norm_name, party_code, seat_key, write_report

CA_URL = "https://api.sos.ca.gov/returns/us-rep/district/{n}"
CA_DISTRICTS = 52
PA_URL = "https://www.electionreturns.pa.gov/api/ElectionReturn/GetCountyData"
PA_ELECTION = {"electionid": 117, "electiontype": "G", "isactive": 1, "methodName": "GetCountyData"}
PA_COUNTIES = """ADAMS ALLEGHENY ARMSTRONG BEAVER BEDFORD BERKS BLAIR BRADFORD BUCKS BUTLER CAMBRIA CAMERON CARBON
CENTRE CHESTER CLARION CLEARFIELD CLINTON COLUMBIA CRAWFORD CUMBERLAND DAUPHIN DELAWARE ELK ERIE FAYETTE FOREST
FRANKLIN FULTON GREENE HUNTINGDON INDIANA JEFFERSON JUNIATA LACKAWANNA LANCASTER LAWRENCE LEBANON LEHIGH LUZERNE
LYCOMING MCKEAN MERCER MIFFLIN MONROE MONTGOMERY MONTOUR NORTHAMPTON NORTHUMBERLAND PERRY PHILADELPHIA PIKE
POTTER SCHUYLKILL SNYDER SOMERSET SULLIVAN SUSQUEHANNA TIOGA UNION VENANGO WARREN WASHINGTON WAYNE WESTMORELAND
WYOMING YORK""".split()


def votes(s) -> int:
    return int(re.sub(r"[^\d]", "", str(s)) or 0)


def fetch_ca(force: bool) -> list[dict]:
    cache_dir = RAW / "official" / "CA"
    cache_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for n in range(1, CA_DISTRICTS + 1):
        path = cache_dir / f"district_{n:02d}.json"
        if force or not path.exists():
            r = http_get(CA_URL.format(n=n), retries=3)
            r.raise_for_status()
            path.write_text(r.text, encoding="utf-8")
            time.sleep(0.5)  # be polite
        d = json.loads(path.read_text(encoding="utf-8"))
        for c in d.get("candidates", []):
            rows.append({"seat": seat_key("house", "CA", n), "state": "CA", "district": n,
                         "candidate": c.get("Name", "").strip(), "party": party_code(c.get("Party")),
                         "votes": votes(c.get("Votes")), "pct": float(c.get("Percent") or 0),
                         "reporting": d.get("Reporting"), "reporting_time": d.get("ReportingTime"),
                         "source_url": CA_URL.format(n=n)})
    return rows


def title(name: str) -> str:
    return " ".join(w.capitalize() if len(w) > 2 or w.isalpha() else w for w in name.split())


def fetch_pa(force: bool) -> list[dict]:
    cache_dir = RAW / "official" / "PA"
    cache_dir.mkdir(parents=True, exist_ok=True)
    totals: dict[tuple[int, str], dict] = {}
    for county in PA_COUNTIES:
        path = cache_dir / f"{county}.json"
        if force or not path.exists():
            r = http_get(PA_URL, params={"countyName": county, **PA_ELECTION}, retries=3)
            r.raise_for_status()
            path.write_text(r.text, encoding="utf-8")
            time.sleep(1.0)  # be polite
        d = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(d, str):  # the API double-encodes its JSON
            d = json.loads(d)
        for block in d.get("Election", {}).get(county, []):
            for office, items in block.items():
                if office != "Representative in Congress":
                    continue
                for item in items:
                    for dist in item.get("Districts", []):
                        m = re.match(r"\s*(\d+)", dist.get("District", ""))
                        if not m:
                            continue
                        n = int(m.group(1))
                        for c in dist.get("Candidates", []):
                            k = (n, c["CandidateName"].strip())
                            t = totals.setdefault(k, {"party": party_code(c.get("PartyName")), "votes": 0})
                            t["votes"] += votes(c.get("Votes"))
    rows = []
    by_dist: dict[int, int] = {}
    for (n, _), t in totals.items():
        by_dist[n] = by_dist.get(n, 0) + t["votes"]
    for (n, name), t in sorted(totals.items()):
        rows.append({"seat": seat_key("house", "PA", n), "state": "PA", "district": n, "candidate": title(name),
                     "party": t["party"], "votes": t["votes"], "pct": round(100 * t["votes"] / max(by_dist[n], 1), 2),
                     "reporting": "summed from all 67 county returns", "reporting_time": None,
                     "source_url": "https://www.electionreturns.pa.gov/"})
    return rows


def main() -> None:
    force = "--force" in sys.argv
    rows = fetch_ca(force) + fetch_pa(force)
    df = pd.DataFrame(rows)
    df.to_csv(INTERIM / "official_house_2026.csv", index=False)

    # sanity: official winner vs our roster (Wikipedia-called) winner
    roster = pd.read_csv(INTERIM / "roster_120.csv").set_index("seat")
    mismatches, incomplete = [], []
    for seat, g in df.groupby("seat"):
        top = g.sort_values("votes", ascending=False).iloc[0]
        member = roster.name.get(seat) if seat in roster.index else None
        if not isinstance(member, str) or norm_name(top.candidate).split()[-1:] != norm_name(member).split()[-1:]:
            mismatches.append(f"- {seat}: official leader {top.candidate} ({top.votes:,}) vs roster {member}")
        if top.state == "CA" and "100%" not in str(top.reporting):
            incomplete.append(f"- {seat}: {top.reporting}")
    write_report("official_results", "Official 2026 House results", {
        "Coverage": [f"- {st}: {g.seat.nunique()} districts" for st, g in df.groupby("state")],
        "Official leader differs from roster winner (check)": mismatches,
        "Not fully reported": incomplete,
    })
    log(f"08b: official results for {df.seat.nunique()} districts ({', '.join(sorted(df.state.unique()))}); "
        f"{len(mismatches)} winner mismatches, {len(incomplete)} not fully reported")


if __name__ == "__main__":
    main()
