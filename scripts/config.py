"""Pipeline configuration. Change values here, then rerun the affected scripts."""

from datetime import date

# Congress being built. The roster is the 119th Congress plus 2026 results.
CONGRESS = 120
CONGRESS_START = date(2027, 1, 3)
RESULTS_YEAR = 2026

# Committee assignments: 119 until the 120th Congress organizes, then flip to 120
# and rerun 01_fetch_legislators.py + 99_build_members_json.py.
COMMITTEE_CONGRESS = 119

# Redistricting: treat court-drawn maps as "redrawn" for the Kamala 2-way rule.
COUNT_COURT_MAPS = True

# FEC: two-year period used for fundraising totals.
FEC_CYCLE = 2026

# Delegates (DC + territories) are included as members.
INCLUDE_DELEGATES = True

# Geometry
# Tolerance in degrees for shapely.coverage_simplify (≈ 0.0025° ≈ 250 m).
SIMPLIFY_TOLERANCE = 0.0025
# TopoJSON quantization (higher = more precise, larger file).
TOPO_QUANTIZATION = 100_000

# Cities: how many places and counties to keep per district.
TOP_CITIES = 5
TOP_COUNTIES = 10
# A place must have at least this share of its area inside the district to count.
MIN_PLACE_AREA_SHARE = 0.05

# Name matching threshold (0-100, rapidfuzz) for winner -> bioguide matching.
NAME_MATCH_THRESHOLD = 88

# Delegates elected to 4-year terms (not on the 2026 ballot).
FOUR_YEAR_DELEGATES = {"PR"}
