# 2026 targeting lists

Pulled 2026-11-23 from committee press releases, committee web pages and news coverage. Every row has a `source_url`.

## Files

| File | What | Completeness |
|---|---|---|
| `party_committee_lists.csv` | DCCC Red to Blue, Frontline, Districts in Play; NRCC MAGA Majority, Patriot Program, target list | Matches each committee's latest published totals (see below) |
| `issue_pac_lists.csv` | Club for Growth PAC, EMILYs List, New Democrat Coalition Action Fund, Blue Dog PAC, Fairshake | Mixed, see the `note` column and the table below |

## Columns

| Column | Meaning |
|---|---|
| `committee`, `program` | Who published the list and which list it is |
| `side` | `offense` (challenger or target seat), `defense` (protected incumbent), `support` (issue PAC endorsement/backing) |
| `state`, `district` | `TX-35`, `AK-AL` for at-large, `GA-SEN` for Senate. District numbers are as the source wrote them (2026 lines) |
| `candidate`, `party` | Person named. For target-seat lists this is the incumbent at listing time, or `OPEN` |
| `date_added` | Date of the announcement that added the row |
| `date_precision` | `exact`, `first_seen` (earliest list we found it on), or `unknown` |
| `status` | `active` = on the latest list; `removed` = was on an earlier list and dropped off |
| `note` | Context, including why something was removed |

## Party committee totals (active rows)

| List | Rows | Published total |
|---|---|---|
| DCCC Districts in Play | 66 | 66 (Oct 2, 2026) |
| DCCC Red to Blue | 46 | 46 (Oct 5, 2026) |
| DCCC Frontline | 26 | 26 (current Frontline page) |
| NRCC target list | 36 | 36 (Jul 20, 2026) |
| NRCC MAGA Majority | 28 | 29 announced, Oberacker removed |
| NRCC Patriot Program | 17 | 17 (September 2026 NRCC Patriots PDF) |

## Gaps to fill

| Group | Status | How to finish |
|---|---|---|
| EMILYs List | 17 named; their own count is 26 "Majority Makers" plus incumbents | emilyslist.org candidate pages |
| New Democrat Coalition Action Fund | 27 of 50 named | newdemactionfund.com press releases |
| Blue Dog PAC | 17 of 23 named | bluedogdems.com news posts |
| Fairshake | 6 of 32 named (the $1M tier) | FEC Schedule E, see below |
| LCV Action Fund | Not included: 192 endorsements behind pagination | lcv.org/2025-2026-endorsements/ (`?result_page=N`) |
| United Democracy Project (AIPAC) | Not included: spending-based, no published list | FEC Schedule E |
| Leading the Future (AI) | Not included: spending-based, no published list | FEC Schedule E |

### FEC Schedule E (independent expenditures)

For the spending-based groups, the cleanest list is every candidate they spent for or against in the 2026 cycle. Query OpenFEC `/schedules/schedule_e/` with `cycle=2026` and each committee's ID (look the IDs up by name with `/committees/?q=`):

- Fairshake, Protect Progress, Defend American Jobs
- United Democracy Project
- Leading the Future, Think Big, American Mission
- Club for Growth Action
- LCV Victory Fund
- Women Vote! (EMILYs List)

Keep `support_oppose_indicator` (S/O) and the summed amount per candidate. The FEC API wasn't reachable from the machine these lists were pulled on, so this step is left for the build pipeline.
