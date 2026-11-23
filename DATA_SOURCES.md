# Data Sources and Collection

How every field in `public/data/` is collected, where to fix it, and what's still missing.
Update the **Status** table and append to the **Update log** whenever new data lands.

- Run everything: `./run_pipeline.sh` (add `--force` to refetch sources). Python deps come from `uv` (`pyproject.toml`).
- Each step writes a review report to `data/reports/*.md`. Read those after every run; that's where gaps and suspicious matches show up.
- Downloads are cached in `data/raw/` and intermediates in `data/interim/` (both gitignored). Every Wikipedia value carries its exact revision (`oldid`) URL, so results stay traceable after the page changes.
- Hand corrections go in `data/overrides/`, never in the scripts. Overrides always win.

---

## Status (as of 2026-11-22)

| Field | Coverage | Source | Next step |
|---|---|---|---|
| Roster (120th) | 538 members + 3 pending seats (541) | congress-legislators + Wikipedia 2026 results | Fill LA-05, LA-06 (Dec runoffs), MN-01 (recount) |
| Bioguide IDs | 420 real, **118 provisional** (`NEW-<seat>`) | congress-legislators | Swap in real IDs as they're assigned |
| Photos | 411 / 538 | unitedstates/images | 118 new members + 9 recent members have none |
| District shapes | 441 / 441 (2026 lines, incl. DC + territories) | Census TIGER 2026 `cd120` | Done |
| Cities / counties | 440 / 441 districts | Census places/counties + popest 2025 | HI-02 needs a Census API key (CDPs) |
| Redrawn districts | 148 in 9 states | Census cd119 vs cd120, block by block | Decide on 10 tiny changes (see below) |
| WAR | 523 / 538 members; 2,965 / 2,972 CSV rows matched | Split Ticket CSV | 15 have no row (uncontested / same-party / delegates) |
| Kamala 2-way | 107 statewide; **146 pending** (redrawn); **280 missing** | FEC (statewide); district file not yet supplied | Add `data/inputs/pres_2024_by_cd119.csv`; fill `kamala_new_districts.csv` |
| Last 2-way | 300 / 538 | Wikipedia (provisional) | House results still being entered/certified; rerun, then swap to certified |
| Fundraising | 36 / 538 | OpenFEC | Key allows 60 requests/hour: rerun 09 hourly (cached) until done |
| Committees | 407 / 538 (119th) | congress-legislators | New members get assignments with the 120th (flip `COMMITTEE_CONGRESS`) |
| First elected / years | 538 / 538 | Derived from terms + `first_elected.csv` | Done |
| Caucuses | 297 / 538 members (11 caucuses) + independents' party caucus | Wikipedia caucus articles + congress-legislators | Main Street has no current list on Wikipedia; new members join in January |
| 2026 targeting | 64 seats flipped · 86 race roles · 97 members on a committee list · 233 with issue PAC backing (33 Red to Blue) | `data/targeting_2026/` (team-compiled) + Wikipedia gain/hold | Issue PAC gaps: see `data/targeting_2026/README.md` |
| Fun facts | 0 | `fun_facts.yaml` (hand-written) | Write them |

---

## Pipeline

| Step | Script | Produces |
|---|---|---|
| 1 | `01_fetch_legislators.py` | `data/raw/legislators/*.yaml` |
| 2 | `02_fetch_results_2026.py` | `data/interim/results_2026_wiki.csv` |
| 3 | `03_build_roster.py` | `data/interim/roster_120.csv`, `reports/roster_120.md` |
| 4 | `04_fetch_photos.py` | `public/photos/*.jpg`, `reports/photos.md` |
| 5 | `05_build_districts.py` | `public/data/{districts,states}.topo.json`, `data/interim/district_places.csv` |
| 6 | `06_detect_redrawn.py` | `data/interim/redrawn.csv`, `reports/redrawn.md` |
| 7 | `07_join_war.py` | `data/interim/war*.csv`, `reports/war.md` |
| 8 | `08_join_results.py` | `data/interim/results.csv`, `reports/results.md` |
| 9 | `09_fetch_fec.py` | `data/interim/fec.csv`, `reports/fec.md` |
| 10 | `10_fetch_caucuses.py` | `data/interim/caucuses.csv`, `reports/caucuses.md` |
| 12a | `12a_fetch_lcv.py` | `data/targeting_2026/generated/lcv_action_fund.csv` |
| 12b | `12b_fetch_schedule_e.py` | `data/targeting_2026/generated/fec_schedule_e.csv` (needs `FEC_API_KEY`) |
| 12 | `12_targeting.py` | `data/interim/targeting.csv`, `reports/targeting.md` |
| 13 | `13_fetch_logos.py` | `public/logos/*`, `public/data/logos.json`, `reports/logos.md` |
| 99 | `99_build_members_json.py` | `public/data/{members,committees,pending_seats,meta}.json`, `reports/members.md` |

Settings live in `scripts/config.py` (`COMMITTEE_CONGRESS`, `COUNT_COURT_MAPS`, simplification tolerance, city counts, and so on).

---

## 1. Roster: who is in the 120th Congress

**Sources**
- `unitedstates/congress-legislators` (`legislators-current.yaml`, `legislators-historical.yaml`): bioguide IDs, names, terms, Senate class, FEC IDs, Wikipedia titles. It still describes the **119th** Congress until January.
- Wikipedia, *2026 United States House of Representatives elections* and *2026 United States Senate elections*: the results tables. The winner is the candidate marked `{{aye}}`/`{{yea}}`. **Provisional**: Wikipedia is user-edited and results are still being certified.

**Method**
1. Enumerate every seat: 435 House + 6 delegates + 100 Senate = 541.
2. Seats not on the 2026 ballot keep their current holder (`status: continuing`). That covers Senate classes I and III (except the FL and OH class III specials) and PR's Resident Commissioner (4-year term, next up in 2028).
3. Seats on the ballot take the called winner. Status is `reelected` if the winner is the seat's incumbent, otherwise `elected`. Uncalled seats are `pending` with their candidates listed (`pending_seats.json`).
4. Winners are matched to bioguide IDs in this order: `bioguide_crosswalk.csv`, then the Wikipedia article title equal to `id.wikipedia`, then a fuzzy name match restricted to the same state, the same first initial, and someone who served after 1980. Every fuzzy match is listed in the report.
5. Anyone unmatched is new to Congress and gets the provisional ID `NEW-<seat>` (e.g. `NEW-DC-AL`).

**Parsing gotchas we hit**
- The House page has a *Special elections* section with the same row format. Those winners only finish the current term (GA-13: Blair won the special, Jasmine Clark won the seat for the 120th). That section is dropped for the House.
- Senate specials (FL, OH class III) are listed under "Special elections during the preceding Congress", but their winners continue into the 120th, so they're kept.
- Some House rows use `rowspan=2` or `{{Ushr`. MP marks its winner with `{{yea}}`.

**Updating**
- A race is called or changes: rerun `02` and `03`, or add a row to `data/overrides/results_2026.csv` (`seat, winner_name, winner_party, winner_wiki_title, status, source, source_url, note`). Overrides beat Wikipedia.
- A new member gets a real bioguide ID: add `state, name, bioguide_id` to `data/overrides/bioguide_crosswalk.csv`, or just rerun after congress-legislators adds them, since the Wikipedia-title join picks them up automatically.
- A multi-word surname is wrong: set `last_name` in `bioguide_crosswalk.csv` (seeded: Trone Garriott, Avila Chevalier, Padilla Stout; verify the last one).
- After the 120th is sworn in (Jan 3, 2027), `legislators-current.yaml` itself becomes the roster. Rerun with `--force` and check the incumbent-mismatch section of the report.

---

## 2. Photos

**Source**: `https://unitedstates.github.io/images/congress/225x275/{bioguide}.jpg` (public domain, official portraits).
**Gaps**: provisional-ID members (no bioguide yet) and members seated in 2025–26 who aren't in that repo yet. Congress.gov doesn't serve photos to scripts.
**Manual fill**: put a public-domain or official JPEG at `data/overrides/photos/{id}.jpg` (the provisional ID works). It's copied over and wins. Photos of departed members are deleted automatically.

---

## 3. District shapes, cities, counties

**Shapes**: Census TIGER/Line 2026 congressional districts for the **120th Congress** (`tl_2026_{fips}_cd120.zip`) cover all 50 states, DC, AS, GU, MP, PR, and VI. These are the 2026 lines, including every mid-decade redraw.
1. Drop `ZZ` (water / undefined) areas.
2. Clip to land using the Census cartographic-boundary states (`cb_2025_us_state_500k`).
3. `shapely.coverage_simplify` (tolerance in `config.py`) keeps shared borders identical, so nothing gaps or overlaps.
4. Output: TopoJSON (`districts.topo.json` ≈ 2.3 MB; `states.topo.json` is dissolved from the districts so the borders match exactly).
- Each feature has `id` (`TX-35`, `DC-AL`), `state`, `district` (0 = at-large or delegate), and `name`.
- Note for the site: `geoAlbersUsa` drops PR and the island territories. Use a composite projection with territory insets (e.g. `geoAlbersUsaTerritories` from `d3-composite-projections`).

**Cities in a district**: Census places (`cb_2025_us_place_500k`) intersected with full-resolution districts in an equal-area projection. Each place's population is split by area share.
- A place counts if at least 5% of its area is in the district or at least 50k of its people are (Manhattan is < 5% of NYC's area).
- The top 5 are kept. NYC is replaced by its borough names (Manhattan, Brooklyn, …).
- Populations: Census Population Estimates **Vintage 2025** (`sub-est2025.csv`), which covers incorporated places only.
- **CDPs** (unincorporated places such as Honolulu, Bethesda, Silver Spring, Paradise NV) need a free Census API key: set `CENSUS_API_KEY` in `.env` and rerun `05`. Until then HI-02 has no cities, and some suburban districts list smaller incorporated towns.
- PR and the territories use their municipios / islands / districts.

**Counties**: Census counties with Vintage 2025 populations (PR municipios from `cc-est2025-agesex-72.csv`). Up to 10 are kept, ranked by people in the district. Boundary slivers (< 1% of the district's people) are dropped.

**Senators** get statewide top cities and counties.

---

## 4. Redrawn districts (for the Kamala rule)

**Definition** (SCAFFOLD 4.3): a district is redrawn if any 2020 Census block moved into or out of it under a new map enacted for 2026. There's no size threshold.

**Method**
1. **Screen every state**: compare TIGER 2025 `cd119` (2024 lines) with TIGER 2026 `cd120` polygon by polygon.
2. **Exact test** for states in `data/overrides/new_maps_2026.csv`: each block's internal point (TIGER 2026 `TABBLOCK20` attributes, read remotely with GDAL `/vsicurl/` without downloading the shapes) is assigned to a cd119 and a cd120 district. Blocks nest inside districts, so this is exact.
3. States not in the CSV count as unchanged. If one of them moved at least 1% of a district's people, the build **fails**, meaning a new map is missing from the CSV.
4. `COUNT_COURT_MAPS = False` in `config.py` treats `method=court` states (UT) as unchanged.

**Current result**: 148 districts in 9 states (AL 4, CA 49, FL 23, LA 6, NC 4, OH 13, TN 8, TX 37, UT 4).

**Decision needed**: 10 districts inside listed states changed by a handful of blocks. They count as redrawn under the no-threshold rule, but they look like Census technical corrections rather than the new map:
CA-11, CA-12, CA-15, CA-19, CA-36, FL-03, FL-06 (all 0 people), NC-10 / NC-14 (27 people), TN-02 (145 people).
Similar technical changes in IL, MO, and SC (≤ 225 people) are already treated as unchanged because those states have no new map.

**`new_maps_2026.csv`** was seeded from Wikipedia's "Summary district map changes" table. `plan_name` and `enacted_date` are blank for several states; fill them from the state sources. TX plan `PLANC2333` needs verifying.

---

## 5. WAR

**Source**: `data/split-ticket-war-database-20261122.csv` (Split Ticket). 2014–2026, House + Senate, 2,972 races. The file has a BOM, so it's read as `utf-8-sig`.

**Who won?** The CSV lists both candidates but no winner, so the winner is whoever held the seat next. For a race in year Y, that's the member whose term for that seat started between November of Y and March 1 of Y+1 (congress-legislators), or the roster for 2026. Appointment terms are excluded (McSally 2018). The member's column is then found by last name, with a fuzzy fallback; `war_crosswalk.csv` handles the rest.
- Member-perspective WAR = `-Sortable` in the Democrat column, `+Sortable` in the Republican column. Independents listed in a party's column (`Dan Osborn (Ind)`) take that column's sign.
- `Nebraska Special` / `Oklahoma Spec` labels are normalized to the state.
- **Fails loudly** if a current member's own latest race row exists but didn't match them. That caught the GA-13 special-election mix-up.

**Trajectory**: linear fit over a member's races. A slope of ±0.75 or more WAR points per cycle is `rising`/`falling`. A residual SD above 2.5 that also exceeds |slope| is `volatile`. Otherwise it's `steady`, and a single race is `single`. Thresholds are at the top of `07_join_war.py`.

**Unmatched rows (7)** are races whose winner never held or kept the seat (Gaetz 2024, McEachin 2022, Letlow 2020, NC-09 2018, Doug Jones 2017 special, Grimm 2014) plus MN-01 2026 (pending).

---

## 6. Election results

### Last 2-way (`last2Way`)
- **Definition**: the member's share of the top two candidates in their most recent general election. Unopposed = 1.0. Same-party top-two races (CA, WA) use winner vs. runner-up.
- **Fusion ballots** (CT, NY) list each party line plus a total, and **ranked-choice** races (AK, ME) list round 1 plus the final round. The parser keeps each candidate's maximum, which is the total or the final round.
- **House 2026**: Wikipedia per-state pages (*2026 United States House of Representatives election(s) in <State>*), general-election `{{Election box}}` vote counts. Fallback: percentages from the national results table.
- **PR**: 2024 Resident Commissioner page.
- **Senate**: class II and the 2026 specials from the 2026 table; class I from *2024 United States Senate elections*; class III from *2022 United States Senate elections*.
- **Gap**: about 240 House races have no numbers on Wikipedia yet. California's district results aren't on its state page, and TX, NY, FL, IL, PA, and others have empty boxes pending certification. Rerun `08 --force` as pages fill in. **Long term**: replace with certified results (state SOS / MIT Election Data + Science Lab). Add a loader and keep Wikipedia as the fallback.

### Kamala 2-way (`kamala2Way` = Harris / (Harris + Trump), 2024)
| Case | Source | `kamala2WaySource` |
|---|---|---|
| Senators, at-large seats, DC | FEC official results, `2024presgeresults.xlsx` | `statewide` |
| District, lines unchanged | `data/inputs/pres_2024_by_cd119.csv` (**not yet supplied**) | `2024-lines` (or `missing` until supplied) |
| District redrawn for 2026 | `data/overrides/kamala_new_districts.csv` | `new-lines`, or `pending` until filled |
| AS, GU, MP, PR, VI | no presidential vote | `n/a` |

**To supply `pres_2024_by_cd119.csv`**: columns `state, district, harris, trump, source, source_url`, with 2024 presidential votes by congressional district **on the 2024 lines**. Candidate sources: The Downballot's 2024 presidential results by congressional district, or Daily Kos Elections' equivalent. Use vote counts, not percentages, so shares are computed and traceable. ME and NE districts belong in this file too.

**To fill redrawn districts** (`kamala_new_districts.csv`: `state, district, dem_votes, rep_votes, source, source_url`), in order of preference: the state's own redistricting reports (e.g. the Texas Legislative Council's election data for the adopted plan), then published tabulations by others, then Lucas's own calculation.

---

## 7. Fundraising (FEC)

- **Source**: OpenFEC `/candidate/{id}/totals/?cycle=2026&election_full=false`: total receipts for 2025–2026, so House and Senate figures are comparable. Cash on hand and disbursements are kept for the reveal screen.
- **Candidate IDs**: congress-legislators `id.fec`, filtered to the current office (prefix H/S + state). New members are found through FEC candidate search (listed in the report for verification). Fixes go in `data/overrides/fec_ids.csv`.
- **Key**: `FEC_API_KEY=...` in `.env` (free from api.data.gov). Without it the public DEMO_KEY allows only 10 requests an hour. Responses are cached, so reruns resume.
- **Refresh**: `09 --refresh` after post-general reports (early December), and again at year-end.

---

## 8. Caucuses

**Ideological** (Freedom Caucus, Republican Study Committee, Main Street, Problem Solvers, Blue Dogs, New Democrats, Progressive Caucus) and **identity** caucuses (Black, Hispanic, Hispanic Conference, Asian Pacific American), from each caucus's Wikipedia article, pinned to a revision.
- **Method:** links inside sections headed member/membership/leadership/current, skipping anything headed former/past/history. Only list items and table rows count, because prose in those sections names non-members (Schumer and Jayapal came up as "Freedom Caucus" before this rule). `{{sortname|First|Last|dab=…}}` templates are resolved to article titles.
- **Matching:** the article title must equal a current member's Wikipedia title, and House-only caucuses only match House members.
- **Current counts:** HFC 24, RSC 86, PSC 29, Blue Dogs 22, New Dems 97, Progressives 83, CBC 48, CHC 37, Hispanic Conference 6, CAPAC 72.
- **Main Street: 0.** Its article lists no current House members; add them by hand.
- **Lists reflect the 119th Congress** (plus members-elect where Wikipedia lists them, e.g. Blue Dog endorsees). Rerun `10 --force` as 120th rosters appear.
- **Corrections:** `data/overrides/caucus_overrides.csv` (`bioguide_id, caucus, action add|remove, note`).

**Party caucus for independents:** from congress-legislators' `caucus` field on the latest term (Sanders, King → Democrats). `data/overrides/party_caucus.csv` covers new independents.

## 9. 2026 targeting lists, seat flips, race role

**Inputs:** the team's lists in `data/targeting_2026/` (SCAFFOLD 4.5; columns, totals and gaps in its README).
- **Party committees:** DCCC Red to Blue, Frontline, Districts in Play; NRCC MAGA Majority, Patriot Program, target list.
- **Issue PACs:** Club for Growth, EMILYs List, New Dem Action Fund, Blue Dog PAC, Fairshake.
- Only `active` rows count. `removed` rows are listed in the report.

**Joins (`12_targeting.py`):**
- **Seat lists** (Districts in Play, NRCC target list) describe a seat, so they join on `district` (2026 lines).
- **Candidate lists** (Red to Blue, MAGA Majority, Frontline, Patriot, issue PACs) name a person, so they join on state + chamber + last name. A losing challenger never tags the winner, and pre-redistricting district numbers in some PAC rows don't matter. Ties on last name are broken by district (Johnny vs. Sylvia Garcia).
- **About 89 candidate rows match nobody.** These are people who lost (e.g. Patriot incumbents Lawler and Kiggans, Club for Growth's Paxton). They're listed in the report.

**`seatFlipped`:**
1. `data/overrides/seat_flipped.csv` (`seat, flipped, note`) wins.
2. Otherwise, Wikipedia's explicit "Democratic gain" / "Republican hold" on the results row.
3. Otherwise, "Incumbent re-elected" means held.
4. Otherwise, the party of the seat's 119th-Congress holder vs. the winner. These are listed in the report for review; the current six are all correct holds.
- Senators not on the 2026 ballot are `false`.
- The incumbent's result ("re-elected", "lost re-election", "retired", "New member elected") is captured in step 02 as `result_text`. It decides incumbent vs. challenger vs. open seat.

**`raceRole`** (SCAFFOLD 4.5, checked in order, matches combined):
1. Won as a challenger on Red to Blue / MAGA Majority and the seat flipped → "Red to Blue, flipped it".
2. Won an open seat on the other party's seat list → "Won a targeted open seat (NRCC target list)".
3. Incumbent who won while on the other party's seat list and/or their own protection list (Frontline / Patriot) → "Frontline incumbent on NRCC's target list, survived", "On DCCC's Districts in Play, survived", "Frontline incumbent, held on".
4. Otherwise `null`.

**On the site:** a "2026 race" block on the answer card and in the mastery map panel (role, a "Flipped to …" badge, list chips, "Backed by: …"), a "Red to Blue '26" chip, and a Tier 3 "2026 race" quiz card.

**Logos (`13_fetch_logos.py`):** each group's own site icon, fetched from its official domain (largest `apple-touch-icon`/`icon` link, else `/favicon.ico`). They're saved in `public/logos/` so the site never hotlinks, and shown at 16px beside the group's name in the list and "Backed by" chips.
- Used only to identify the group. These are the groups' trademarks, and nothing suggests they endorse this site.
- All 10 groups resolved. United Democracy Project's homepage blocks scripts, but its favicon downloaded from its own domain.
- To set or replace a logo, put a file at `data/overrides/logos/<slug>.png` (slugs are in `reports/logos.md`).
- The SVG logos were checked for scripts (there were none). Browsers don't run scripts in `<img>` SVGs anyway.

**No race ratings or PVI:** nothing from Cook, Sabato or Inside Elections is used.

**Filling the README's gaps** (pipeline-generated files in `data/targeting_2026/generated/`, same columns as the team's CSVs; the team's files are never edited):
- **LCV Action Fund (`12a`):** lcv.org/2025-2026-endorsements/. **140 endorsements** (125 House, 15 Senate), of whom 128 are seated members. The page serves the same full list regardless of `?result_page`, so the README's "192" couldn't be reproduced; it may count something else. Worth a manual look.
- **FEC Schedule E (`12b`):** every 2026 independent expenditure by Fairshake / Protect Progress / Defend American Jobs, United Democracy Project, Leading the Future / Think Big / American Mission, Club for Growth Action, LCV Victory Fund, and Women Vote!. It pages through `/schedules/schedule_e/`, sums per candidate and support/oppose, and skips memo lines.
  - **Only support counts toward "Backed by".**
- **"Opposed by"** (45 members): a group either (a) spent against the member (Schedule E "oppose", which can include primary spending), or (b) endorsed or spent for the person the member beat in the 2026 **general** election. (b) only counts candidates on that seat's general-election ballot, so primary rivals don't show up. The reason ("spent against them" / "backed Scott Perry") is shown with each group. A group never appears on both sides; backing wins.
  - **Status: complete for all 10 committees** (283 candidate rows: 197 support, 86 oppose). Each committee name resolved to the right FEC super PAC (type O), and look-alikes such as "Think Big America PAC" and "Women Vote Smart" were rejected.
    - Leading the Future's own committee has no IEs; it spends through Think Big and American Mission.
    - The key comes from `FEC_API_KEY` in the environment (it's set in `~/.Renviron`, outside the repo). That key's limit is **60 requests/hour**.
  - If a committee name search picks the wrong FEC committee, pin its ID in `data/overrides/fec_committees.csv`.
- **Still manual:** a newer NRCC Patriot Program roster, and the rest of EMILYs List / New Dem / Blue Dog (see the targeting README).

## 10. Committees, service, aliases, fun facts

- **Committees**: `committee-membership-current.yaml` + `committees-current.yaml`, full committees only (4-letter codes). Roles come from titles (Chair, Ranking Member, Vice Chair). The 119th applies until the 120th organizes; then set `COMMITTEE_CONGRESS = 120` and rerun 01 + 99. New members have none until then.
- **First elected / years**: derived from terms. A January start in an odd year is a regular term (elected the previous year). A special election counts as the year sworn in. An appointment counts as the next election. Corrections go in `data/overrides/first_elected.csv` (`bioguide_id, first_elected_year, years_in_congress, note`), seeded with Barrasso, Markey (a source-data quirk), Meeks, Bonamici, Menefee, and Schatz.
- **Aliases**: official name, first + last, and nickname + last from congress-legislators.
- **Fun facts**: `data/overrides/fun_facts.yaml` (`id: [fact, …]`).

---

## `members.json` schema notes (changes from SCAFFOLD 4.5)

Added: `provisionalId`, `status` (`continuing | reelected | elected`), `newToCongress`.
Changed:
- `last2Way` and `warTrajectory` can be `null`.
- `last2Way` adds `opponent` and `opponentParty` (top opponent in that race). The site uses them to place the race on the red-to-blue "How blue" meter, so a D-vs-D race isn't drawn as a Democratic landslide.
- `caucuses` (list of `{code, name, kind}`) and `partyCaucus` (independents only).
- `seatFlipped`, `raceRole`, `targeting` (`{committee, program, dateAdded}`), `issuePacSupport` (SCAFFOLD 4.5/4.6), and `issuePacOpposition` (`{group, why}`).
- `redToBlue`: `2026` for members on the DCCC's Red to Blue list (from the targeting lists). Absent otherwise.
- `war[]` items carry `chamber`, `opponent` and `opponentParty`: WAR is always a two-candidate race, so the site shows every value with who they ran against (from the CSV's other column; `(Ind)` → `I`).
- `kamala2WaySource` adds `statewide | missing | n/a`.

Seats with no member yet live in `pending_seats.json`. Coverage counts are in `meta.json`.

---

## Overrides reference (`data/overrides/`)

| File | Purpose |
|---|---|
| `results_2026.csv` | Manual race calls; beat Wikipedia |
| `bioguide_crosswalk.csv` | Winner name → bioguide ID; last-name fixes |
| `new_maps_2026.csv` | States with a 2026 map (plan, date, method) |
| `kamala_new_districts.csv` | 2024 pres votes on redrawn 2026 lines |
| `war_crosswalk.csv` | WAR row → member fixes |
| `fec_ids.csv` | FEC candidate ID fixes |
| `first_elected.csv` | First-elected year / years-in-Congress fixes |
| `fun_facts.yaml` | Hand-written facts |
| `photos/{id}.jpg` | Manual photos |

Inputs you supply go in `data/inputs/` (`pres_2024_by_cd119.csv`).

---

## Update log

Append newest first: date, what changed, and why.

- **2026-11-23**: Added "Opposed by" (45 members): groups that spent against a member or backed their general-election opponent.
- **2026-11-23**: Added endorser logos (step 13) to list and "Backed by" chips.
- **2026-11-23**: FEC Schedule E pulled for all 10 committees (283 rows); issue PAC backing now 233 members. Fundraising 36/538 (key limited to 60 req/hour).
- **2026-11-23**: Filled targeting gaps: LCV Action Fund scrape (12a, 140 endorsements), FEC Schedule E step (12b; Fairshake committee done, rest awaits FEC_API_KEY). Issue PAC backing now covers 163 members.
- **2026-11-23**: Added the team's 2026 targeting lists (new step 12): seatFlipped (64), raceRole (86), committee lists, issue PAC backing (50). Red to Blue now comes from these lists (33 members); the earlier dccc.org scrape (step 11) was retired.
- **2026-11-22**: Added caucus memberships (new step 10) and the last race's opponent and party (08).
- **2026-11-22**: WAR points now include the opponent's name and party (07 → members.json).
- **2026-11-22**: Initial pipeline built. Roster from congress-legislators + Wikipedia (House rev 1387217115). 3 seats pending (LA-05, LA-06 runoffs; MN-01 recount). Census TIGER 2026 cd120 shapes. 148 districts flagged redrawn. WAR CSV 20261122 joined. Kamala statewide from FEC; district file pending. FEC partial (DEMO_KEY).
