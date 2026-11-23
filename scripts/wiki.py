"""Wikipedia wikitext fetching (revision-pinned) and results-table parsers."""

import json
import re
import time

from common import NAME_TO_ABBR, RAW, http_get, log, now_iso

API = "https://en.wikipedia.org/w/api.php"

REF_RE = re.compile(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>", re.S)
AYE_RE = re.compile(r"\{\{\s*(?:aye|yea|yes2?)\s*\}\}", re.I)


def fetch_page(title: str, force: bool) -> tuple[str, int, str]:
    cache = RAW / "wikipedia" / (title.replace(" ", "_") + ".json")
    if cache.exists() and not force:
        d = json.loads(cache.read_text())
    else:
        log(f"  fetching wikitext: {title}")
        r = http_get(API, params={
            "action": "query", "prop": "revisions", "rvprop": "ids|timestamp|content",
            "rvslots": "main", "format": "json", "formatversion": "2", "titles": title, "redirects": 1,
        })
        r.raise_for_status()
        time.sleep(1.0)  # be polite to the Wikipedia API
        page = r.json()["query"]["pages"][0]
        if page.get("missing"):
            raise KeyError(f"missing page: {title}")
        rev = page["revisions"][0]
        d = {"title": title, "revid": rev["revid"], "timestamp": rev["timestamp"],
             "content": rev["slots"]["main"]["content"], "fetched_at": now_iso()}
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(d))
    return d["content"], d["revid"], d["timestamp"]


def clean_link(s: str) -> tuple[str, str | None]:
    """'[[Title|Display]]' -> ('Display', 'Title'); plain text passes through."""
    m = re.search(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]", s)
    if m:
        return (m.group(2) or m.group(1)).strip(), m.group(1).strip()
    return s.strip(), None


def parse_sortname(s: str) -> str | None:
    m = re.search(r"\{\{\s*sortname\s*\|([^|}]+)\|([^|}]+)", s, re.I)
    if m:
        return f"{m.group(1).strip()} {m.group(2).strip()}"
    m = re.search(r"\[\[[^\]]+\]\]", s)
    return clean_link(m.group(0))[0] if m else None


JUNK_PARTIES = {"special", "retired", "retiring", "flip", "appointed", "lost renomination", "louisiana politician"}

CAND_RE = re.compile(
    r"^\s*[*|]\s*(?:\{\{\s*Party stripe\|[^}]*\}\})?\s*(?:\{\{\s*Party stripe\|[^}]*\}\})*\s*(?P<aye>\{\{\s*(?:aye|yea|yes2?)\s*\}\})?\s*"
    r"(?P<name>'''.*?'''|\[\[[^\]]+\]\]|[^(\n]+?)\s*\((?P<party>[^)]+)\)\s*(?P<pct>[\d.]+%)?",
    re.I | re.M,
)


def parse_candidates(cell: str) -> list[dict]:
    out = []
    for m in CAND_RE.finditer(cell):
        raw = m.group("name").strip("' ").strip()
        name, link = clean_link(raw)
        name = name.strip("' ").strip()
        party = m.group("party").strip()
        if (not name or len(name) > 80 or any(ch in name for ch in "{}[]|")
                or name.isdigit() or "http" in name or party.lower() in JUNK_PARTIES or "|" in party):
            continue
        out.append({
            "name": name, "wiki_title": link, "party": party,
            "winner": bool(m.group("aye")),
            "pct": float(m.group("pct")[:-1]) if m.group("pct") else None,
        })
    return out


OUTCOME_RE = re.compile(r"(Democratic|Republican|Independent)\s+(gain|hold)")
RESULT_RE = re.compile(r"(Incumbent [^.<\n|]*|New (?:seat|member)[^.<\n|]*|Interim appointee[^.<\n|]*)")


def row_outcome(chunk: str) -> dict:
    """'Incumbent lost re-election' + 'Democratic gain' style text from a results row."""
    o = OUTCOME_RE.search(chunk)
    r = RESULT_RE.search(chunk)
    return {"result_text": re.sub(r"\[\[[^\]|]*\|([^\]]*)\]\]", r"\1", r.group(1)).strip() if r else None,
            "outcome": o.group(0) if o else None}


def parse_house(text: str) -> list[dict]:
    rows = []
    for chunk in text.split("\n|-"):
        chunk = REF_RE.sub("", chunk)
        m = re.match(r"\s*!\s*(?:rowspan=\"?\d\"?\s*\|\s*)?\{\{\s*ushr\|([A-Z]{2})\|(\w+)\|X\}\}", chunk, re.I)
        if not m:
            continue
        st, dist = m.group(1), m.group(2)
        district = 0 if dist.upper() in {"AL", "AT-LARGE"} else int(dist)
        lines = chunk.split("\n")
        incumbent = next((parse_sortname(l) for l in lines[1:6] if "sortname" in l.lower()), None)
        cands = parse_candidates(chunk)
        rows.append(dict(chamber="house", state=st, district=district, senate_class=None, **row_outcome(chunk),
                         incumbent_name=incumbent, candidates=cands))
    return rows


def parse_senate(text: str, year: int = 2026, regular_class: int = 2) -> list[dict]:
    rows = []
    for chunk in text.split("\n|-"):
        chunk = REF_RE.sub("", chunk)
        m = re.match(rf"\s*!\s*\[\[{year} United States Senate (special )?election in [^|\]]+\|([^\]]+)\]\]"
                     r"(?:<br\s*/?>\s*\(Class (\d)\))?", chunk)
        if not m or not AYE_RE.search(chunk) and "Plainlist" not in chunk:
            continue
        state = NAME_TO_ABBR.get(m.group(2).strip())
        if not state:
            continue
        cls = int(m.group(3)) if m.group(3) else regular_class
        lines = [l for l in chunk.strip().split("\n")[1:] if l.strip().startswith("|")]
        inc_line = lines[0] if lines else ""
        incumbent = parse_sortname(inc_line) or clean_link(inc_line.lstrip("| "))[0]
        rows.append(dict(chamber="senate", state=state, district=None, senate_class=cls, **row_outcome(chunk),
                         incumbent_name=incumbent, candidates=parse_candidates(chunk)))
    return rows


def drop_special_sections(text: str) -> str:
    """Remove '== Special elections ... ==' sections from the House page.

    House specials only fill the rest of the current term (ends Jan 3), so the general
    election row decides the next Congress. Not applied to the Senate page: Senate
    specials (e.g. FL/OH 2026, class 3) seat the winner through the next Congress.
    """
    heads = [(m.start(), len(m.group(1)), m.group(2)) for m in re.finditer(r"\n(=+)\s*([^=\n]+?)\s*=+", text)]
    keep, cut_level, last = [], None, 0
    for pos, level, name in heads:
        if cut_level is not None and level <= cut_level:
            cut_level, last = None, pos
        if cut_level is None and re.match(r"special elections", name, re.I):
            keep.append(text[last:pos])
            cut_level = level
    if cut_level is None:
        keep.append(text[last:])
    return "".join(keep)
