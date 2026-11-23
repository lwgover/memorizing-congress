"""Caucus memberships: ideological, identity, and who independents caucus with.

Ideological + identity caucuses come from each caucus's Wikipedia article (revision-pinned).
Method: take every [[link]] inside sections whose heading mentions members/membership/
leadership (skipping "former"/"past"/"history" sections), and keep links whose article title
matches a current member's Wikipedia title (congress-legislators id.wikipedia, or the 2026
results winner link for new members). Lists reflect the 119th Congress until caucuses
publish 120th rosters; members-elect fill in as they join and as Wikipedia updates.

Party caucus for independents: congress-legislators records it per term (`caucus`);
data/overrides/party_caucus.csv (bioguide_id, caucus D/R, note) covers anyone it doesn't.

Corrections: data/overrides/caucus_overrides.csv (bioguide_id, caucus, action add|remove, note).

Output: data/interim/caucuses.csv, data/reports/caucuses.md
"""

from __future__ import annotations

import re
import sys

import pandas as pd
import yaml

from common import INTERIM, OVERRIDES, RAW, log, write_report
from wiki import REF_RE, fetch_page

# code, display name, Wikipedia article, kind, chamber it covers
CAUCUSES = [
    ("HFC", "Freedom Caucus", "Freedom Caucus", "ideological", "house"),
    ("RSC", "Republican Study Committee", "Republican Study Committee", "ideological", "house"),
    ("RMSP", "Main Street Caucus", "Republican Main Street Partnership", "ideological", "house"),
    ("PSC", "Problem Solvers Caucus", "Problem Solvers Caucus", "ideological", "house"),
    ("BDC", "Blue Dog Coalition", "Blue Dog Coalition", "ideological", "house"),
    ("NDC", "New Democrat Coalition", "New Democrat Coalition", "ideological", "house"),
    ("CPC", "Progressive Caucus", "Congressional Progressive Caucus", "ideological", "both"),
    ("CBC", "Congressional Black Caucus", "Congressional Black Caucus", "identity", "both"),
    ("CHC", "Congressional Hispanic Caucus", "Congressional Hispanic Caucus", "identity", "both"),
    ("CHCo", "Congressional Hispanic Conference", "Congressional Hispanic Conference", "identity", "both"),
    ("CAPAC", "Asian Pacific American Caucus", "Congressional Asian Pacific American Caucus", "identity", "both"),
]

MEMBER_HEAD = re.compile(r"member|membership|roster|leadership|current", re.I)
SKIP_HEAD = re.compile(r"former|past|previous|history|alumni|retired|defeated|notable", re.I)
LINK = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]")
SORTNAME = re.compile(r"\{\{\s*sortname\s*\|([^|}]+)\|([^|}]+)((?:\|[^{}]*)?)\}\}", re.I)


def linked_titles(body: str) -> list[str]:
    """Article titles from [[links]] and {{sortname|First|Last|dab=...|link=...}} templates."""
    titles = [m.group(1) for m in LINK.finditer(body)]
    for m in SORTNAME.finditer(body):
        first, last, rest = m.group(1).strip(), m.group(2).strip(), m.group(3) or ""
        params = dict(p.split("=", 1) for p in rest.strip("|").split("|") if "=" in p)
        params = {k.strip(): v.strip() for k, v in params.items()}
        if "nolink" in rest:
            continue
        if params.get("link"):
            titles.append(params["link"])
        elif params.get("dab"):
            titles.append(f"{first} {last} ({params['dab']})")
        else:
            titles.append(f"{first} {last}")
    return titles


def member_sections(text: str) -> str:
    """Concatenate the bodies of member-list sections (by heading), excluding 'former' ones."""
    text = REF_RE.sub("", text)
    heads = [(m.start(), m.end(), len(m.group(1)), m.group(2).strip())
             for m in re.finditer(r"\n(={2,5})\s*([^=\n]+?)\s*\1", text)]
    out = []
    for i, (start, end, level, name) in enumerate(heads):
        if not MEMBER_HEAD.search(name) or SKIP_HEAD.search(name):
            continue
        # section runs until the next heading of the same or higher level
        stop = next((s for s, _, lv, _ in heads[i + 1:] if lv <= level), len(text))
        body = text[end:stop]
        # drop nested "former" subsections
        for s2, e2, lv2, n2 in heads[i + 1:]:
            if s2 >= stop:
                break
            if SKIP_HEAD.search(n2):
                stop2 = next((s for s, _, lv, _ in heads if s > s2 and lv <= lv2), len(text))
                body = body.replace(text[s2:min(stop2, stop)], "")
        out.append(body)
    return "\n".join(out)


def main() -> None:
    force = "--force" in sys.argv
    roster = pd.read_csv(INTERIM / "roster_120.csv")
    seated = roster[roster.bioguide_id.notna()]
    with (RAW / "legislators" / "legislators-current.yaml").open() as f:
        cur = yaml.load(f, Loader=getattr(yaml, "CSafeLoader", yaml.SafeLoader))
    with (RAW / "legislators" / "legislators-historical.yaml").open() as f:
        hist = yaml.load(f, Loader=getattr(yaml, "CSafeLoader", yaml.SafeLoader))
    people = {p["id"]["bioguide"]: p for p in hist + cur}

    # Wikipedia title -> bioguide, for seated members only
    title_to_id: dict[str, str] = {}
    for r in seated.itertuples():
        p = people.get(r.bioguide_id)
        t = (p or {}).get("id", {}).get("wikipedia") or (r.wiki_title if isinstance(r.wiki_title, str) else None)
        if t:
            title_to_id[t.replace("_", " ").strip()] = r.bioguide_id

    rows, summary, issues = [], [], []
    chamber_of = dict(zip(seated.bioguide_id, seated.chamber))
    for code, name, article, kind, chamber in CAUCUSES:
        try:
            text, rev, _ = fetch_page(article, force)
        except Exception as e:  # noqa: BLE001
            issues.append(f"- {name}: couldn't fetch '{article}' ({e})")
            continue
        # only list items and table rows: prose in these sections names non-members too
        body = "\n".join(l for l in member_sections(text).split("\n") if l.lstrip()[:1] in ("*", "#", "|", "!", "{"))
        ids = []
        for raw in linked_titles(body):
            t = raw.replace("_", " ").strip()
            t = t[0].upper() + t[1:] if t else t
            if t in title_to_id and (chamber == "both" or chamber_of[title_to_id[t]] == chamber):
                ids.append(title_to_id[t])
        ids = sorted(set(ids))
        for bid in ids:
            rows.append({"bioguide_id": bid, "caucus": code, "kind": kind, "source": f"https://en.wikipedia.org/w/index.php?oldid={rev}"})
        summary.append(f"- {name} ({code}): {len(ids)} current members matched")

    df = pd.DataFrame(rows, columns=["bioguide_id", "caucus", "kind", "source"])

    # manual corrections
    ov_path = OVERRIDES / "caucus_overrides.csv"
    if not ov_path.exists():
        pd.DataFrame(columns=["bioguide_id", "caucus", "action", "note"]).to_csv(ov_path, index=False)
    ov = pd.read_csv(ov_path, dtype=str).fillna("")
    kinds = {c[0]: c[3] for c in CAUCUSES}
    for o in ov.itertuples():
        if o.action == "remove":
            df = df[~((df.bioguide_id == o.bioguide_id) & (df.caucus == o.caucus))]
        elif o.action == "add":
            df = pd.concat([df, pd.DataFrame([{"bioguide_id": o.bioguide_id, "caucus": o.caucus, "kind": kinds.get(o.caucus, "ideological"), "source": "override"}])])

    # party caucus for independents
    pc_path = OVERRIDES / "party_caucus.csv"
    if not pc_path.exists():
        pd.DataFrame(columns=["bioguide_id", "caucus", "note"]).to_csv(pc_path, index=False)
    pc_over = dict(pd.read_csv(pc_path, dtype=str).fillna("")[["bioguide_id", "caucus"]].values)
    party_caucus = []
    for r in seated[seated.party == "I"].itertuples():
        c = pc_over.get(r.bioguide_id)
        if not c:
            p = people.get(r.bioguide_id)
            last = (p or {}).get("terms", [{}])[-1]
            lab = (last.get("caucus") or last.get("party") or "")
            c = "D" if lab.startswith("Democrat") else "R" if lab.startswith("Republican") else ""
        party_caucus.append({"bioguide_id": r.bioguide_id, "caucus": f"PARTY-{c}" if c else "PARTY-?", "kind": "party", "source": "congress-legislators"})
        if not c:
            issues.append(f"- {r.seat} {r.name}: independent with unknown party caucus; add to party_caucus.csv")
    df = pd.concat([df, pd.DataFrame(party_caucus)], ignore_index=True).drop_duplicates(["bioguide_id", "caucus"])
    df.to_csv(INTERIM / "caucuses.csv", index=False)

    names = seated.set_index("bioguide_id").name.to_dict()
    write_report("caucuses", "Caucus memberships", {
        "Matched per caucus": summary,
        "Independents' party caucus": [f"- {names.get(r['bioguide_id'])}: {r['caucus']}" for r in party_caucus],
        "Issues": issues,
    })
    log(f"10: {len(df)} memberships for {df.bioguide_id.nunique()} members")


if __name__ == "__main__":
    main()
