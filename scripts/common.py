"""Shared paths, state metadata, download helpers and name normalization."""

from __future__ import annotations

import json
import re
import sys
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RAW = DATA / "raw"
INTERIM = DATA / "interim"
OVERRIDES = DATA / "overrides"
REPORTS = DATA / "reports"
PUBLIC = ROOT / "public"
PUBLIC_DATA = PUBLIC / "data"
PHOTOS = PUBLIC / "photos"

for _d in (RAW, INTERIM, OVERRIDES, REPORTS, PUBLIC_DATA, PHOTOS):
    _d.mkdir(parents=True, exist_ok=True)

USER_AGENT = "memorizing-congress-pipeline/0.1 (static study site data build)"

# (abbr, fips, name, is_state)
STATES: list[tuple[str, str, str, bool]] = [
    ("AL", "01", "Alabama", True), ("AK", "02", "Alaska", True),
    ("AZ", "04", "Arizona", True), ("AR", "05", "Arkansas", True),
    ("CA", "06", "California", True), ("CO", "08", "Colorado", True),
    ("CT", "09", "Connecticut", True), ("DE", "10", "Delaware", True),
    ("DC", "11", "District of Columbia", False), ("FL", "12", "Florida", True),
    ("GA", "13", "Georgia", True), ("HI", "15", "Hawaii", True),
    ("ID", "16", "Idaho", True), ("IL", "17", "Illinois", True),
    ("IN", "18", "Indiana", True), ("IA", "19", "Iowa", True),
    ("KS", "20", "Kansas", True), ("KY", "21", "Kentucky", True),
    ("LA", "22", "Louisiana", True), ("ME", "23", "Maine", True),
    ("MD", "24", "Maryland", True), ("MA", "25", "Massachusetts", True),
    ("MI", "26", "Michigan", True), ("MN", "27", "Minnesota", True),
    ("MS", "28", "Mississippi", True), ("MO", "29", "Missouri", True),
    ("MT", "30", "Montana", True), ("NE", "31", "Nebraska", True),
    ("NV", "32", "Nevada", True), ("NH", "33", "New Hampshire", True),
    ("NJ", "34", "New Jersey", True), ("NM", "35", "New Mexico", True),
    ("NY", "36", "New York", True), ("NC", "37", "North Carolina", True),
    ("ND", "38", "North Dakota", True), ("OH", "39", "Ohio", True),
    ("OK", "40", "Oklahoma", True), ("OR", "41", "Oregon", True),
    ("PA", "42", "Pennsylvania", True), ("RI", "44", "Rhode Island", True),
    ("SC", "45", "South Carolina", True), ("SD", "46", "South Dakota", True),
    ("TN", "47", "Tennessee", True), ("TX", "48", "Texas", True),
    ("UT", "49", "Utah", True), ("VT", "50", "Vermont", True),
    ("VA", "51", "Virginia", True), ("WA", "53", "Washington", True),
    ("WV", "54", "West Virginia", True), ("WI", "55", "Wisconsin", True),
    ("WY", "56", "Wyoming", True),
    ("AS", "60", "American Samoa", False), ("GU", "66", "Guam", False),
    ("MP", "69", "Northern Mariana Islands", False),
    ("PR", "72", "Puerto Rico", False), ("VI", "78", "U.S. Virgin Islands", False),
]
ABBR_TO_FIPS = {a: f for a, f, _, _ in STATES}
FIPS_TO_ABBR = {f: a for a, f, _, _ in STATES}
NAME_TO_ABBR = {n: a for a, _, n, _ in STATES}
NAME_TO_ABBR.update({"Virgin Islands": "VI", "United States Virgin Islands": "VI"})
ABBR_TO_NAME = {a: n for a, _, n, _ in STATES}
STATE_ABBRS = [a for a, _, _, s in STATES if s]
DELEGATE_ABBRS = [a for a, _, _, s in STATES if not s]


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def http_get(url: str, *, params: dict | None = None, retries: int = 6, timeout: int = 120,
             retry_429: bool = True) -> requests.Response:
    last = None
    for attempt in range(retries):
        try:
            r = requests.get(url, params=params, timeout=timeout, headers={"User-Agent": USER_AGENT})
            if r.status_code == 429 and not retry_429:
                return r
            if r.status_code == 429 or r.status_code >= 500:
                wait = float(r.headers.get("Retry-After") or 0) or (5 * 2 ** attempt)
                log(f"  {r.status_code} from {url.split('?')[0]}; waiting {wait:.0f}s")
                time.sleep(min(wait, 120))
                last = requests.HTTPError(f"{r.status_code} for {url}")
                continue
            return r
        except requests.RequestException as e:
            last = e
            time.sleep(2 ** attempt)
    raise RuntimeError(f"GET failed after {retries} tries: {url}: {last}")


def download(url: str, dest: Path, *, force: bool = False) -> Path:
    """Download url to dest unless it already exists. Returns dest."""
    if dest.exists() and dest.stat().st_size > 0 and not force:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    log(f"  downloading {url}")
    r = http_get(url)
    r.raise_for_status()
    tmp = dest.with_suffix(dest.suffix + ".part")
    tmp.write_bytes(r.content)
    tmp.replace(dest)
    return dest


def write_json(path: Path, obj, *, compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        if compact:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        else:
            json.dump(obj, f, ensure_ascii=False, indent=2, allow_nan=False)
            f.write("\n")


def write_report(name: str, title: str, sections: dict[str, list[str]]) -> Path:
    """Write a markdown report to data/reports/<name>.md."""
    path = REPORTS / f"{name}.md"
    lines = [f"# {title}", "", f"_Generated {now_iso()}_", ""]
    for heading, items in sections.items():
        lines.append(f"## {heading} ({len(items)})")
        lines.append("")
        lines.extend(items if items else ["_none_"])
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


# ---------------------------------------------------------------- names

_SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}


def strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def norm_name(s: str) -> str:
    """Lowercase, accentless, no punctuation, no suffixes, no single-letter initials."""
    s = strip_accents(s or "").lower()
    s = re.sub(r"\(.*?\)", " ", s)          # drop "(Ind)" and nicknames in parens
    s = re.sub(r"[\"“”]", " ", s)
    s = s.replace("’", "'").replace("'", "")
    s = re.sub(r"[^a-z\s-]", " ", s)
    s = s.replace("-", " ")
    toks = [t for t in s.split() if t not in _SUFFIXES and len(t) > 1]
    return " ".join(toks)


def last_token(s: str) -> str:
    n = norm_name(s)
    return n.split()[-1] if n else ""


def seat_key(chamber: str, state: str, district: int | None = None, senate_class: int | None = None) -> str:
    """Stable seat identifier: 'TX-35', 'DC-AL', 'TX-S2'."""
    if chamber == "senate":
        return f"{state}-S{senate_class}"
    return f"{state}-{'AL' if not district else f'{district:02d}'}"


def party_code(p: str | None) -> str:
    p = (p or "").strip().lower()
    if p.startswith("dem") or p in {"d", "dfl", "democratic-farmer-labor", "democratic–farmer–labor"}:
        return "D"
    if p.startswith("rep") or p in {"r", "gop"}:
        return "R"
    return "I"
