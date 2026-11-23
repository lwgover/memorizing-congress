# Memorizing Congress: Site Scaffold

A static, GitHub Pages hosted site for learning every member of the 120th Congress, built on spaced repetition, plus daily games to keep it fun.

---

## 1. Goals and priorities

| Tier | What | Why |
|---|---|---|
| **1 (core)** | District → Name, Name → District (Senators: State + Class), District Shape -> District number. | The thing that actually matters |
| **2 (identity)** | Face ↔ Name, Party, District shape + cities it contains | Makes Tier 1 stick |
| **3 (fun facts)** | WAR + trajectory, Kamala 2-way share, 2026 (or last) 2-way share, Senate class, years in Congress, first election year, 2026 fundraising, committees (119th for now) | Scored on closeness, not exactness |

Design rules:

- Tier 1 cards unlock first. Tier 2 unlocks per member once their Tier 1 cards are stable. Tier 3 is opt-in.
- Numeric facts are graded on **how close** you were, not right/wrong.
- Every game produces a shareable emoji score with a link back to the site.

---

## 2. Stack

| Piece | Choice | Notes |
|---|---|---|
| Build | Vite + TypeScript | No backend, pure static output |
| Hosting | GitHub Pages via GitHub Actions | `base` set to `/memorizing-congress/` |
| Maps | `d3-geo` + TopoJSON, `geoAlbersUsa` projection | AK/HI insets built in, no tile server |
| Spaced repetition | `ts-fsrs` | FSRS scheduling |
| Fuzzy name matching | `fuse.js` | Accept last-name-only, typos |
| Storage | `localStorage` + JSON export/import button | Backup and move between devices |
| Data pipeline | Python (`pandas`, `geopandas`, `shapely`, `pyyaml`, `requests`) + `mapshaper` | Outputs static JSON/TopoJSON |

---

## 3. Repo layout

```
memorizing-congress/
├── data/
│   ├── raw/                         # downloaded sources (gitignored if large)
│   ├── split-ticket-war-database-20261122.csv
│   ├── overrides/
│   │   ├── war_crosswalk.csv        # candidate name -> bioguide_id fixes
│   │   ├── first_elected.csv        # specials, appointments
│   │   ├── kamala_new_districts.csv # 2024 pres results on redrawn 2026 lines
│   │   ├── new_maps_2026.csv        # states with a new map enacted for 2026
│   │   └── fun_facts.yaml           # hand-written facts per member
│   └── mnemonics.example.json
├── scripts/
│   ├── 01_fetch_legislators.py      # congress-legislators YAML
│   ├── 02_fetch_photos.py           # unitedstates/images
│   ├── 03_build_districts.py        # TIGER shapes -> simplified TopoJSON + cities
│   ├── 04_join_war.py               # Split Ticket CSV -> per-member WAR history
│   ├── 05_join_results.py           # Kamala 2-way, 2026 / last 2-way
│   ├── 06_fetch_fec.py              # OpenFEC 2026 cycle receipts
│   └── 99_build_members_json.py     # final merge + validation
├── public/
│   ├── data/
│   │   ├── members.json
│   │   ├── districts.topo.json
│   │   ├── states.topo.json
│   │   └── committees.json
│   └── photos/{bioguide_id}.jpg
├── src/
│   ├── main.ts
│   ├── router.ts
│   ├── data/load.ts
│   ├── srs/
│   │   ├── cards.ts                 # card generation per member
│   │   ├── scheduler.ts             # ts-fsrs wrapper
│   │   ├── closeness.ts             # numeric scoring functions
│   │   └── confusions.ts            # mixed-up pair tracking
│   ├── games/
│   │   ├── districtTap.ts           # MapTap-style daily
│   │   ├── nameToDistrict.ts
│   │   ├── districtToName.ts
│   │   └── share.ts                 # emoji share strings
│   ├── map/
│   │   ├── usMap.ts                 # render, zoom, click -> lat/lon
│   │   └── geometry.ts              # point-in-polygon, distance to boundary
│   ├── ui/                          # components, views
│   └── styles/palette.css
├── .github/workflows/deploy.yml
├── index.html
├── vite.config.ts
└── SCAFFOLD.md
```

---

## 4. Data

### 4.1 Sources

| Field | Source | Notes |
|---|---|---|
| bioguide ID, name, party, state, district, Senate class, terms | `unitedstates/congress-legislators` (`legislators-current.yaml`) | Senate terms carry a `class` field |
| Years in Congress, first election year | Derived from `terms` | First term start minus 1 is a good default; specials and appointments need `first_elected.csv` |
| Committees (119th) | `committee-membership-current.yaml` + `committees-current.yaml` | Swap to 120th when assignments are made |
| Photos | `unitedstates/images` (keyed by bioguide ID) | Public domain official photos |
| District shapes | Census TIGER/Line congressional districts for the 2026 lines | Several states redrew before 2026, so confirm every state is on its 2026 map. Simplify with `mapshaper` |
| Cities in district | Census places intersected with districts | Store top ~5 by population inside the district, plus counties |
| WAR + trajectory | `data/split-ticket-war-database-20261122.csv` | Multi-year, both chambers. See 4.2 |
| Kamala 2-way | 2024 presidential results by district on the **2024** lines | Statewide for Senators and at-large seats. Redrawn districts are `null` for now, see 4.3 |
| 2026 (or last) 2-way | Certified results (state SOS, MIT Election Lab later) | Class II Senators: 2026. Class I: 2024. Class III: 2022. Specials: their own year |
| Fundraising | OpenFEC API, candidate totals | **Total receipts for the 2026 two-year cycle** (2025 to 2026), for every member including Senators not on the 2026 ballot. FEC IDs are in `congress-legislators` (`id.fec`). See 4.4 |
| Fun facts | `fun_facts.yaml` | Hand-written |

### 4.2 WAR join notes

- The CSV is keyed by `Year, Chamber, Geography` with candidate names in `Democrat` / `Republican` columns and includes challengers. `Sortable` is WAR with D as negative.
- Pick the winner's column, convert to a **member-perspective WAR** (positive = overperformed for their party).
- Independents are labeled `(Ind)` in a party column. Handle explicitly.
- Name matching to bioguide IDs: fuzzy match within the same state, then `war_crosswalk.csv` for anything left over. The build should fail loudly on unmatched current members.
- Trajectory: all of a member's races, sorted by year. Store raw series plus a label (`rising`, `falling`, `steady`, `volatile`) from slope and variance.

### 4.3 Kamala 2-way and redrawn districts

- Base value: 2024 presidential 2-way (`D / (D + R)`) for each district **as drawn in 2024**.
- **Definition of redrawn:** any district whose boundaries changed at all under a new map enacted for 2026. No size threshold.
- `data/overrides/new_maps_2026.csv` lists the states with a new map: `state, plan_name, enacted_date, method, source_url`. `method` is one of `legislature`, `commission`, `ballot_measure`, `court`. All four count as redrawn by default; set `COUNT_COURT_MAPS = false` in the pipeline config to treat court-drawn maps differently.
- Within those states, compare **block assignment files** (2020 Census blocks → district) for the 2024 and 2026 plans. If even one block moved into or out of a district, it's redrawn. This is exact, so there's no shapefile-precision noise to tolerate.
- States not in `new_maps_2026.csv` are treated as unchanged without a comparison.
- Unchanged district: use the 2024-lines value.
- Redrawn district: `kamala2Way = null`, `kamala2WaySource = "pending"` for now. Fill later from `data/overrides/kamala_new_districts.csv`, in this order:
  1. The state's own redistricting documentation (Texas, for example, publishes election-result reports for its adopted plans).
  2. Tabulations other people have published for the new maps.
  3. Lucas calculates it himself.
- `kamala_new_districts.csv` columns: `state, district, dem_votes, rep_votes, source, source_url`. The pipeline computes the share from the vote counts so every value is traceable.
- Cards and games skip a member's Kamala card while it's `null`.

### 4.4 Fundraising (FEC)

- Endpoint: OpenFEC candidate totals for each member's FEC candidate ID, two-year period 2026 (not the full 6-year Senate election cycle, so House and Senate numbers are comparable).
- Store `receipts` (total raised) as the memorized number. Keep `cashOnHand` and `disbursements` in the JSON for the reveal screen only.
- Members with several FEC IDs (e.g. past House runs for current Senators): use the ID for their current office.
- Pull after the post-general reports are filed. Rerun at year-end, since 2026 totals will keep moving until the final reports for the cycle are in.
- API key lives in a local `.env`, never committed.

### 4.5 2026 targeting lists

Saved in `data/targeting_2026/` (see its README for columns, totals and gaps):

- `party_committee_lists.csv`: DCCC Red to Blue, Frontline, Districts in Play; NRCC MAGA Majority, Patriot Program, target list. Every row has a source URL, date added, and `active`/`removed` status.
- `issue_pac_lists.csv`: Club for Growth PAC (complete), EMILYs List, New Democrat Coalition Action Fund, Blue Dog PAC, Fairshake (partial). LCV Action Fund, United Democracy Project (AIPAC) and Leading the Future still need pulling; the README says how (FEC Schedule E for the spending-based groups).

**No race ratings or PVI.** Don't pull Cook, Sabato or Inside Elections ratings or Cook PVI into the site. Use our own numbers (Kamala 2-way, 2-way results, WAR) instead.

Join to members on `district` (Senate rows use `XX-SEN`), then derive two fields per member:

**`seatFlipped`** (boolean): the 2026 winner's party differs from the party that held the seat going into the election. For districts in redrawn states, compare against the incumbent who ran in (or represented most of) the new district; put any judgment calls in `data/overrides/seat_flipped.csv`.

**`raceRole`** (string, shown on the reveal screen and usable as a quiz card). Rules, checked in order:

| Condition | Label example |
|---|---|
| Won as a challenger on Red to Blue / MAGA Majority and the seat flipped | "Red to Blue, flipped it" / "MAGA Majority, flipped it" |
| Won an open seat that was on the other party's target list | "Won a targeted open seat (NRCC target list)" |
| Incumbent on the other party's target list who won | "On NRCC's target list, survived" / "On DCCC's Districts in Play, survived" |
| Incumbent on own party's protection list (Frontline / Patriot) who won | "Frontline incumbent, held on" / "Patriot Program incumbent, held on" |
| None of the above | `null` (don't show) |

A member can match more than one row (e.g. Frontline and on the NRCC target list); combine them: "Frontline incumbent on NRCC's target list, survived". Issue PAC backing is shown as a separate line ("Backed by: Club for Growth, Fairshake"), not folded into `raceRole`.

### 4.6 `members.json` schema

```ts
interface Member {
  id: string;                 // bioguide
  name: string;
  lastName: string;
  aliases: string[];          // nicknames for fuzzy match
  party: "D" | "R" | "I";
  chamber: "house" | "senate";
  state: string;              // "TX"
  district?: number;          // 0 for at-large
  senateClass?: 1 | 2 | 3;
  photo: string;
  firstElectedYear: number;
  yearsInCongress: number;
  committees: { code: string; name: string; role?: string }[];
  committeeCongress: 119 | 120;
  districtCities: string[];
  districtCounties: string[];
  kamala2Way: number | null;  // D / (D + R), 0 to 1, 2024 lines; null if redrawn and not yet filled
  kamala2WaySource: "2024-lines" | "new-lines" | "pending";
  last2Way: { year: number; share: number };   // member's party share
  war: { year: number; value: number }[];      // member perspective
  warTrajectory: "rising" | "falling" | "steady" | "volatile" | "single";
  fundraising?: { cycle: 2026; receipts: number; cashOnHand: number; disbursements: number };
  seatFlipped: boolean;
  raceRole: string | null;     // see 4.5
  targeting: { committee: string; program: string; dateAdded: string | null }[];
  issuePacSupport: string[];   // e.g. ["Club for Growth PAC", "Fairshake"]
  funFacts: string[];
}
```

Config flag in `src/config.ts`: `COMMITTEE_CONGRESS = 119`. Flip to 120 and rerun the pipeline when assignments land.

---

## 5. Learning engine

### 5.1 Card types

| Card | Prompt | Answer | Tier | Grading |
|---|---|---|---|---|
| `district->name` | Highlighted district (+ label) | Type name | 1 | Exact (fuzzy) |
| `name->district` | Name | State + district, or map click | 1 | Exact, partial for right state |
| `senator->class` | Senator name | I / II / III | 1 | Exact |
| `face->name` | Photo | Type name | 2 | Exact (fuzzy) |
| `name->face` | Name | Pick from 4 photos | 2 | Exact |
| `name->party` | Name | D / R / I | 2 | Exact |
| `shape->district` | Silhouette only | State + district | 2 | Exact |
| `district->cities` | District | Pick cities inside it | 2 | Partial credit |
| `war` | Name | Slider | 3 | Closeness |
| `war-trajectory` | Name | Pick from 4 sparklines | 3 | Exact |
| `kamala-2way` | District | Slider | 3 | Closeness |
| `last-2way` | Name | Slider | 3 | Closeness |
| `first-elected` | Name | Year | 3 | Closeness |
| `fundraising` | Name | Log slider (2026 total raised) | 3 | Closeness |
| `committees` | Name | Multi-select | 3 | Partial credit |

### 5.2 Closeness scoring (`closeness.ts`)

Every numeric answer gets a 0 to 100 score. Starting values, tune later:

| Fact | Error measure | 100 at | 0 at |
|---|---|---|---|
| WAR | absolute points | ≤ 0.5 | ≥ 5 |
| 2-way shares | absolute pct points | ≤ 1 | ≥ 10 |
| First election year | years | 0 | ≥ 10 |
| Fundraising | `abs(log10(guess / actual))` | ≤ 0.05 | ≥ 1 (10x off) |

Linear between the two endpoints. Score maps to an FSRS rating:

| Score | FSRS rating |
|---|---|
| ≥ 90 | Easy |
| 70 to 89 | Good |
| 40 to 69 | Hard |
| < 40 | Again |

Exact cards: correct and fast = Good (Easy if very fast), correct and slow = Hard, wrong = Again.

### 5.3 Introducing new members

- Unit = state delegation, in geographic order (contiguous states, a fixed route around the map).
- Default 15 new members per day, configurable.
- A member's Tier 2 cards unlock when their Tier 1 cards hit a stability threshold (e.g. 7 days).
- Tier 3 toggled on per fact in settings.

### 5.4 Memory aids

- **Mnemonic field** per member. You write your own; it shows after a miss.
- **Confusion log:** if you answer member B when the answer was A, store the pair. A "Confusables" drill shows them side by side.
- **Reveal screen** after every answer: photo, name, district on map, party, top cities, one fun fact. This is where elaboration happens.

---

## 6. Games

All games share `share.ts`, which builds the emoji string, copies to clipboard, and uses the Web Share API on mobile.

### 6.1 District Tap (MapTap-style daily)

Five names a day, tap where you think their district is.

- **Daily seed:** hash the date string into a seeded PRNG and pick 5 members (default 4 House + 1 Senator). Everyone gets the same 5 each day. Puzzle number = days since launch.
- **Prompt:** name only. Optional hint toggle shows photo. No party color.
- **Answer:** one tap on a pannable/zoomable US map.
  - House: inside the district = perfect.
  - Senate: inside the state = perfect.
- **Scoring per round (0 to 100):** distance `d` in miles from tap to the nearest point of the target polygon (0 if inside). `score = round(100 * exp(-d / 150))`. Total out of 500.
- **Reveal:** draw the target district, a line from your tap, the distance, and the score.
- **Emoji tiers:**

| Result | Emoji |
|---|---|
| Inside the district (or state, for Senators) | 🎯 |
| < 25 mi | 🔥 |
| < 75 mi | 🌶️ |
| < 150 mi | ☀️ |
| < 400 mi | 🧊 |
| ≥ 400 mi | 💀 |

- **Share string:**

```
District Tap #12 · Nov 22
🎯🔥🧊🎯💀
341/500 · streak 4
https://<username>.github.io/memorizing-congress/#/tap
```

- One official play per day (stored locally), unlimited practice mode with random seeds.
- Streak counter, best score, histogram of past scores.

### 6.2 Name → District test

- **Prompt:** member name (photo off by default).
- **Answer modes:**
  - Typeahead: `TX-35`, or for Senators `TX` + class `I / II / III`.
  - Map mode: click the district.
- **Scoring:** exact = 100. Right state, wrong district = 40 (in map mode, use the District Tap distance formula instead). Senator right state, wrong class = 60.
- **Formats:** Quick 10, single state, full sweep (all 535), 60-second sprint.
- Share string: same pattern, with 10 emoji squares for Quick 10.

### 6.3 District → Name test

- **Prompt:** district highlighted and zoomed to its state, with label (`TX-35`). Hard mode hides the label and shows the silhouette only.
- **Senators:** prompt is `TX · Class II`.
- **Answer:** free text with fuzzy matching. No autocomplete in hard mode, since a filtered list gives the answer away. Last name alone is accepted.
- **Scoring:** 100 exact. Answering a member of the same delegation logs a confusion pair and scores 0.
- Same formats and share string as 6.2.

### 6.4 Backlog game ideas

- **Silhouette:** daily, one district shape, 6 guesses, Wordle-style feedback (distance + direction arrow).
- **Higher or Lower:** two members, who has higher WAR / Kamala share / cash on hand.
- **Over/Under:** guess a member's 2-way share within a band.
- **Roll Call:** name every member of one committee in 2 minutes.
- **Odd One Out:** 4 members, one doesn't share a committee/state/class.

---

## 7. Motivation features

- Daily streak (study and games tracked separately).
- Daily goal ring (reviews due + new members).
- **Mastery map:** choropleth of every district shaded by your mastery, in the blue palette. Watching it fill in is the main progress view.
- State badges when a full delegation is mastered.
- Stats page: retention rate, cards due forecast, most-confused pairs.

---

## 8. Styling

```css
:root {
  --blue-900: #001F8A;   /* dark blue: headers, primary */
  --blue-600: #0288FF;   /* lighter blue: buttons, Dem */
  --blue-400: #00BBFF;   /* accents, highlights */
  --blue-100: #CDF2FF;   /* backgrounds, mastery low */
  --black: #000000;
  --white: #FFFFFF;
  --good: #1A9E4B;       /* correct */
  --bad: #D7263D;        /* wrong, GOP on party maps */
}
```

Mastery map scale: `--blue-100` (new) to `--blue-900` (mastered).

---

## 9. Deployment

`vite.config.ts`:

```ts
import { defineConfig } from "vite";
export default defineConfig({ base: "/memorizing-congress/" });
```

`.github/workflows/deploy.yml`:

```yaml
name: Deploy
on:
  push:
    branches: [main]
permissions:
  contents: read
  pages: write
  id-token: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment: { name: github-pages }
    steps:
      - uses: actions/deploy-pages@v4
```

Use hash routing (`#/tap`, `#/study`) so deep links work on Pages without a 404 redirect.

The data pipeline runs locally and commits the outputs in `public/data/`. Hosting stays static and the FEC API key never ships.

---

## 10. Milestones

| # | Milestone | Done when |
|---|---|---|
| M0 | Data pipeline (roster, photos, shapes, WAR join) | `members.json` validates for all 535 + shapes render |
| M1 | District Tap + share | Playable daily, share string copies |
| M2 | Name → District, District → Name tests | All three formats work |
| M3 | SRS engine with Tier 1 cards | Daily study session with FSRS scheduling |
| M4 | Tier 2 cards + mastery map | Faces, party, shapes, cities |
| M5 | Tier 3 data + closeness cards | Kamala (2024 lines), 2-way results, FEC 2026 receipts, committees |
| M5b | Fill Kamala for redrawn districts | No `pending` values left in `members.json` |
| M5c | Targeting lists + race role | `seatFlipped` and `raceRole` set for every House member; issue PAC gaps filled per `data/targeting_2026/README.md` |
| M6 | Backlog games, polish | Silhouette, Higher or Lower |
| M7 | Switch to 120th committees | Flip config, rerun pipeline |

---

## 11. Open questions

1. **Non-voting delegates** (DC, territories): include them or not?
2. **Roster churn:** results are still being certified, and vacancies or specials will happen during the term. Plan is a `status` field and a rerun of the pipeline.
3. **Repo visibility:** public is fine for photos and data, but mnemonics should live only in localStorage/exports.

### Decided

- Targeting: all DCCC and NRCC lists plus the issue PACs, saved in `data/targeting_2026/`. Derive `raceRole` and `seatFlipped`. No Cook/Sabato/Inside Elections ratings or PVI.

- Hometown/birthplace: cut.
- Fundraising: total receipts, 2026 two-year cycle, from the FEC.
- Kamala 2-way: 2024 district lines. Redrawn districts null until filled from state docs, public tabulations, or Lucas's own calculation.
- Redrawn = any boundary change under a new 2026 map, checked block by block. No threshold.
- District Tap emoji scale: hot and cold (🎯 🔥 🌶️ ☀️ 🧊 💀).
