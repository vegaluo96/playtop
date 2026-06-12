# PlayTop / ZSKY External Calibration Audit - 2026-06-12

> Current slice only. Do not read this as a whole-site completion statement.
> Capture time: 2026-06-12T14:47:48Z / 2026-06-12 22:47 CST.
> Continuation update: 2026-06-12T16:37:29Z / 2026-06-13 00:37 CST.
> Target repo: `/Users/vega/Documents/Codex/playtop-zsky-copy`, branch `main`.

## Scope And Rules

- Platform positioning: football data and information terminal, not a betting service.
- Red line: no fabricated data. If no real source is available, UI must show "积累中", "未公布", "暂无官方数据/返回", or hide the card.
- Public production entry: `https://zsky.com`; `play.top` and `47.82.67.99` are known to redirect to `zsky.com`.
- Public production entry checked: `https://zsky.com`.
- Production deploy completed at commit `d8055e6`; `playtop-web` and `playtop-worker` were online after `scripts/deploy.sh`.
- No secret was written to the repo. AF/API checks used the production server environment.
- AF detail calibration is source-of-truth verification against the platform upstream. It is separate from media/external-source corroboration.

## 2026-06-13 Continuation

Current status: this is a continuation slice, not a whole-site completion claim.

- Production read-only DB check found the current sample finished matches already have non-empty AF detail payloads: Mexico-South Africa has events 18 / statistics 2 / lineups 2 / players 2; South Korea-Czechia has events 14 / statistics 2 / lineups 2 / players 2.
- AF detail public calibration was rerun for fixtures `1489369,1538999,1539000,1489370`: `✓16 △0 ✗0 ⊘0`. Scores, events, stats, official lineup state, and pre-match null states match AF for this slice.
- Public external odds calibration was rerun from `docs/external-odds-samples-2026-06-12.json`: `✓0 △10 ✗0 ⊘0`. This remains WARN because the samples are not same-line/same-time and several are partial tip markets.
- Applied code corrections in this continuation: terminal detail refresh after FT now retries AF `events/statistics/lineups/players` three times over the post-match window; AF empty-result caches for injuries, standings, rankings, ratings, formations, squads, coaches, transfers, and H2H now use a shorter negative TTL; list odds reads only the last two unsuspended live frames per fixture/market instead of scanning all historical live frames.
- Fake-function correction: user recharge dialogs no longer say "演示环境:点击档位即模拟支付到账" while the channel is under maintenance, and the admin overview no longer labels disabled production purchase flow as "演示支付". Real payment integration is still a product-policy OPEN item.
- Selfcheck correction: production L4 selfcheck now skips the demo first-purchase assertion when the purchase channel is maintenance-gated, while still checking gift, unlock, ledger, invite, redemption, and cleanup flows.

## Production Public Fixtures Checked

| Fixture | Match | Production API status | Notes |
|---:|---|---|---|
| 1489369 | Mexico-South Africa | PASS for reachable public detail | Finished 2-0; summary odds AH 1.25 1.10/0.78, OU 2.25 0.98/0.93, EU 1.40/4.50/8.50. |
| 1538999 | South Korea-Czechia | PASS for reachable public detail | Finished 2-1; summary odds AH 0 0.80/1.05, OU 2.25 0.98/0.93, EU 2.62/3.00/3.00. |
| 1539000 | Canada-Bosnia and Herzegovina | PASS for reachable public detail | Pre-match; lineups `ready:false`; timeline/stats null; EU 1.80/3.60/4.50. |
| 1489370 | USA-Paraguay | PASS for reachable public detail | Pre-match; lineups `ready:false`; timeline/stats null; latest sampled EU 2.10/3.20/3.80. |

Production URLs used:

- `https://zsky.com/api/matches?day=today&league=all&tz=UTC%2B8`
- `https://zsky.com/api/matches?day=tmr&league=all&tz=UTC%2B8`
- `https://zsky.com/api/match/1489369?tz=UTC%2B8&deep=1`
- `https://zsky.com/api/match/1538999?tz=UTC%2B8&deep=1`
- `https://zsky.com/api/match/1539000?tz=UTC%2B8&deep=1`
- `https://zsky.com/api/match/1489370?tz=UTC%2B8&deep=1`

## Current Calibration / Correction Status

This table is the operator-facing answer to "which parts are calibrated, which still need correction". PASS means an external source corroborates the production public API for the stated field. WARN means production is not necessarily wrong, but the external source is partial, not same-time, or uses a different taxonomy. OPEN means no acceptable external source has been captured yet.

| Area | Already externally calibrated | Still WARN / not fully corrected |
|---|---|---|
| Finished scores | Mexico-South Africa 2-0; South Korea-Czechia 2-1. | None for the two finished sample matches. Canada-Bosnia and USA-Paraguay remain pre-match. |
| Goals | Mexico goals at 9' and 67'; South Korea-Czechia goals at 59', 67', 80'. | Assist/minute taxonomy can vary by source, so keep exact event metadata WARN unless sourced from an official match centre. |
| Red cards / VAR | Mexico-South Africa three red cards and Zwane VAR card upgrade externally corroborated. South Korea-Czechia offside/VAR disallowed-goal event corroborated. | South Korea-Czechia production has one 90+6' yellow; no full external card table captured. |
| Starting XI personnel | South Africa XI PASS. South Korea and Czechia XI PASS. Mexico XI now PASS/WARN after Times of India corroborated the XI including Alvarado. | Mexico formation remains WARN because external sources label the shape as 4-3-3 / 4-1-2-3 while production normalizes it as 4-1-4-1. |
| Pre-match null states | Canada-Bosnia and USA-Paraguay correctly keep `score:null`, `timeline:null`, `stats:null`, and `lineups.ready:false`. | Re-check after official lineups and match events publish. |
| Standings | Group A table now shows only the shared group rows for the two finished Group A matches; generic duplicate group rows are filtered. | Keep media/external standings WARN until an official standings table snapshot is captured. |
| Odds / handicap | Production AF source audit has no line mismatch: future 48h selfcheck returned ✓9 / △3 water-basis differences / ✗0 / ⊘0. | Media/external odds still have no PASS. 10 samples are WARN only because none is same-line/same-time. AH and live/in-play external evidence remain OPEN. |
| Technical stats | AF detail calibration PASS for the two finished matches: Mexico-South Africa 17 public stat rows match AF; South Korea-Czechia 16 rows match AF. | Media/external exact stat tables remain OPEN; no trusted match-centre table captured with identical full numbers. |
| Team form / injuries | Empty recent-form arrays display "数据积累中"; empty official injuries remain no official report. Leaderboard shells and unusable transfer rows are now filtered in production. | Player ratings and season panels are AF-sourced but still need optional external/media spot checks if non-AF corroboration is required. |
| Fake-function scan | No match-data fabrication FAIL found in this pass; empty modules mostly show "暂无/未公布/数据积累中". Production recharge simulation copy was removed from disabled user/admin states in the continuation update. | Real payment integration remains product-policy WARN/OPEN; production should stay maintenance-gated until a real gateway exists. |

## Corrections Applied In Repo

Status: fixed, pushed to GitHub `main`, and deployed to production.

- Source-of-truth stance: API-Football is treated as the upstream source of truth. External calibration is used to find our ingestion, merge, cache, taxonomy, and display defects; it is not used to overwrite AF values with media/blog values.
- Fixture detail fetch: `scripts/worker.ts` now fetches match detail slices from the dedicated API-Football endpoints `/fixtures/events`, `/fixtures/statistics`, `/fixtures/lineups`, and `/fixtures/players`, then merges non-empty responses into the fixture payload. This fixes the previous weak assumption that `/fixtures?id=<fixture>` would always carry complete detail arrays.
- On-demand detail self-heal: `matchPanorama` now detects missing `events/statistics/lineups/players` slices when a user opens a match and probes the corresponding AF detail endpoints with a short throttle before rendering. This lets historical or partially cached fixtures repair themselves from AF instead of staying empty until the worker happens to revisit them.
- Lineup polling: pre-match lineup refresh now polls `/fixtures/lineups?fixture=<id>` on its own timer until both team lineups are present. It is no longer throttled by odds polling, so published official lineups should arrive without waiting for an odds refresh.
- Payload merge: `src/server/af/store.ts` added a fixture-detail merge helper so direct endpoint results can update `events/statistics/lineups/players` without rewriting unrelated base fixture fields.
- Fixture upsert merge: `upsertFixture` no longer keeps the longest JSON payload. It now always applies the newest base fixture/status/score frame and only preserves previous `events/statistics/lineups/players` arrays when the new frame lacks them.
- Odds raw retention: `archiveOdds` now stores the raw AF odds payload even when the current normalizer cannot extract a market. This preserves replay material for future parser fixes instead of silently losing source evidence.
- Timeline ordering: real AF events are sorted by elapsed/extra time before score labels are accumulated, so goal score text no longer depends on provider array order.
- Standings display: `src/server/views/detail.ts` now prefers the home/away shared standings group when API-Football returns both a concrete group (for example `Group Stage - Group A`) and an extra generic `Group Stage` block. This prevents the South Korea-Czechia detail table from showing duplicate/out-of-group rows.
- Coach cards: deep coach cards now prefer the fixture-level lineup coach from `/fixtures/lineups` over stale team-level `/coachs` profiles. If the fixture coach differs from the team profile, the UI keeps the match coach name and marks profile/trophy metadata as pending instead of showing the wrong coach's biography.
- Empty data shells: deep league leaderboards now return/render only populated boards; if all boards are empty, mobile and desktop show one official pending state instead of four empty cards. Unusable transfer rows such as missing date, unusable type, or player names like "Data unavailable"/"数据不可用" are converted to an official-pending state, not displayed as concrete transactions.
- AF detail public calibration: added `scripts/af-detail-public-calibrate.ts` and `npm run calibrate:af-detail`. It compares AF `/fixtures`, `/fixtures/events`, `/fixtures/statistics`, and `/fixtures/lineups` with public `/api/match/<fixtureId>?deep=1` without DB/KV writes.
- Post-match AF detail refresh: worker now retries the official AF detail endpoints after FT so final events/statistics/player ratings that arrive after the last live tick can replace partial live payloads.
- AF negative-cache correction: empty official arrays/nulls use short TTL when appropriate, so AF data that appears after an initial empty response is not hidden for 6-24 hours.
- Live odds list performance: list endpoints now read only the last two unsuspended live odds frames per fixture/market from SQLite, instead of loading every historical live frame and slicing in JavaScript.
- Recharge fake-function copy: disabled production purchase flows show maintenance/ledger wording instead of simulation wording.
- Regression tests: added `tests/platform/detail-calibration.test.ts` to lock the standings, coach-card, leaderboard, and transfer fixes; added fixture-payload merge and odds raw-retention coverage in `tests/af/store.test.ts`; added timeline ordering coverage in `tests/af/events-synth.test.ts`; added `tests/af/fixture-details.test.ts` for AF detail fetch planning and non-empty-only merge behavior.
- Test stability: `tests/platform/selfcheck.test.ts` now uses a fixed midday timestamp, avoiding false failures when the test runs late in the day and its seeded `now + 2h` fixture crosses into tomorrow.

API-Football reference note: the public documentation page at `https://www.api-football.com/documentation-v3` returned 403 to direct `curl` in this environment, but the repo's `src/server/af/catalog.ts` is already structured around that documentation and enumerates the relevant source endpoints: `/standings`, `/fixtures`, `/fixtures/statistics`, `/fixtures/events`, `/fixtures/lineups`, `/fixtures/players`, `/injuries`, `/coachs`, `/players`, `/players/squads`, `/players/topscorers`, `/odds`, and `/odds/live`. Treat this as source-provenance support for AF fields, not as external calibration against a second source.

## AF Detail Public Calibration

Status: PASS for the current production slice.

Command run on production:

```text
npm run calibrate:af-detail -- --base https://zsky.com --max 8
```

Result:

```text
■ AF detail public calibration · fixtures 8 · ✓32 △0 ✗0 ⊘0
```

Covered:

- Mexico-South Africa: score 2-0, event counts, 17 stat rows, and XI/substitute player IDs all match AF.
- South Korea-Czechia: score 2-1, event counts, 16 stat rows, and XI/substitute player IDs all match AF.
- Canada-Bosnia, USA-Paraguay, Qatar-Switzerland, Brazil-Morocco, Haiti-Scotland, Australia-Turkiye: AF has no score/events/stats/official lineups yet; production public correctly keeps score/timeline/stats null and `lineups.ready:false`.

This closes the AF-source calibration for current scores, events, stats, and official lineups in this slice. It does not close media/external corroboration where no public match-centre table was captured.

## Public Odds Calibration

Status: WARN overall.

Added `scripts/odds-public-calibrate.ts` and `npm run calibrate:public`. The script only reads `docs/external-odds-samples-2026-06-12.json` and production public `/api/match/<fixtureId>`. It does not import DB helpers and does not write SQLite/KV.

Run result:

```text
■ Public external odds calibration · samples 10 · ✓0 △10 ✗0 ⊘0
```

Key observations:

| Match | Market | External source | External sample | ZSKY public | Status |
|---|---|---|---|---|---|
| Mexico-South Africa | 1X2 | [The Sun Ireland / Paddy Power](https://www.thesun.ie/betting/17078702/mexico-vs-south-africa-betting-tips-world-cup-2026/) | 1.40/4.00/8.00 | 1.40/4.50/8.50 | WARN, not same-time; draw/away differ. |
| Mexico-South Africa | OU | [The Sun Ireland / Puntit](https://www.thesun.ie/betting/17078702/mexico-vs-south-africa-betting-tips-world-cup-2026/) | O/U 2.5, over 6/5, under 4/6 | O/U 2.25, 0.98/0.93 | WARN, line mismatch and not same-time. |
| Mexico-South Africa | 1X2 partial | [New York Post / FanDuel](https://nypost.com/2026/06/11/betting/mexico-vs-south-africa-prediction-odds-picks-best-bet-for-world-cup-opener/) | Mexico -260, South Africa +800 | 1.40/4.50/8.50 | WARN, no draw price. |
| South Korea-Czechia | 1X2 partial | [New York Post / FanDuel](https://nypost.com/2026/06/11/betting/south-korea-vs-czechia-world-cup-prediction-odds-picks-and-best-bets-for-thursdays-nightcap/) | Czechia +175 | 2.62/3.00/3.00 | WARN, no home/draw prices. |
| South Korea-Czechia | OU | [The Sun UK / Betfair](https://www.thesun.co.uk/sport/39337711/south-korea-czechia-world-cup-betting-tips/) | Under 1.5 at 15/8 | O/U 2.25, 0.98/0.93 | WARN, different line/tip market. |
| Canada-Bosnia | 1X2 partial | [The Sun UK / Betfair](https://www.thesun.co.uk/sport/39310810/canada-vs-bosnia-preview-betting-tips-predictions-world-cup/) | Draw 5/2 | 1.80/3.60/4.50 | WARN, partial tip market. |
| Canada-Bosnia | OU | [The Sun UK / Playzee](https://www.thesun.co.uk/betting/39314635/world-cup-2026-acca-tips-11-12-june/) | Under 2.5 at 16/25 | O/U 2.25, 1.07/0.85 | WARN, different line/tip market. |
| USA-Paraguay | 1X2 partial | [New York Post / bet365](https://nypost.com/2026/06/12/betting/bet365-bonus-code-bet-10-get-365-in-bonus-bets-for-usa-vs-paraguay/) | USA -110, Paraguay +320 | 2.10/3.20/3.80 | WARN, no draw price. |

OPEN:

- No publicly accessible, same-line, same-time Asian handicap source was found in this pass.
- No live/in-play 1X2/AH/OU source with URL, capture time, market, line, h/a/d was found.
- Therefore no odds row was allowed to PASS.

## Match State Calibration

### Mexico-South Africa

- Score/goals: PASS. Production 2-0, goals at 9' Julian Quinones and 67' Raul Jimenez match [Guardian live report](https://www.theguardian.com/football/live/2026/jun/11/mexico-v-south-africa-world-cup-2026-opening-match-live), [AP](https://apnews.com/article/4c9de5961b70f1b2cc6e754ff2db57c2), and [FMF State of Mind](https://www.fmfstateofmind.com/world-cup/27214/mexico-defeat-south-africa-to-finally-win-a-world-cup-opener).
- Cards/VAR: PASS/WARN. Production has South Africa reds at 49' and 84', Mexico red at 90+2', plus VAR card upgrade at 82'. Guardian and FMF both corroborate the three reds and Zwane VAR upgrade; minute naming differs slightly by source, so keep WARN for exact minute.
- Substitutions: PASS/WARN. FMF narrative corroborates the major second-half changes, including Luis Chavez/Gilberto Mora, Edson Alvarez/Armando Gonzalez, Alexis Vega, and South Africa changes. Not a full substitution table from an official match centre.
- Technical stats: OPEN. Production exposes 17 stats (61%-39% possession, 16-3 shots, 4-2 shots on target, 3-1 corners, 1-2 red cards, etc.), but this pass did not find an external match-centre page with exact same full numeric stats. Economic Times only corroborates the score/red-card/points snapshot, not the full stat table.

### South Korea-Czechia

- Score/goals: PASS. Production 2-1, Czechia 59' Ladislav Krejci, South Korea 67' Hwang In-beom and 80' Oh Hyeon-gyu match [Guardian](https://www.theguardian.com/football/live/2026/jun/12/fifa-world-cup-2026-live-south-korea-v-czechia-updates-kor-vs-cze-group-a-match-score-latest) and [AP](https://apnews.com/article/world-cup-south-korea-czech-republic-score-496e7772dde95ca0af90b5074fdb13d9).
- VAR/offside: PASS/WARN. Production records a 77' VAR disallowed goal for offside; Guardian and AP both describe the late Czech set-piece header being ruled offside. Exact VAR event taxonomy remains source-specific.
- Cards: PASS/WARN. Production records only a 90+6' South Korea yellow. Guardian noted no cards by 90+2; no conflicting external card table found.
- Technical stats: OPEN. Production exposes 17 stats (62%-38% possession, 15-7 shots, 6-4 shots on target, 4-5 corners, etc.). AP and Economic Times corroborate Korea's comeback and match direction, but no exact full stat table was captured.

### Canada-Bosnia / USA-Paraguay

- Schedule/venue: PASS. [Guardian day-two guide](https://www.theguardian.com/football/2026/jun/12/how-to-watch-world-cup-usa-paraguay-canada-bosnia-and-herzegovina) corroborates Canada-Bosnia at Toronto Stadium/BMO Field and USA-Paraguay at Los Angeles/SoFi with the expected kickoff windows.
- Match state: PASS for pre-match nulls. Production correctly has `score:null`, `timeline:null`, `stats:null`, and `lineups.ready:false`; no predicted lineup was treated as official.
- Injuries/team news: WARN/OPEN. Guardian notes Canada injury concerns around Alphonso Davies and Moise Bombito, and a separate Guardian USMNT piece says Mauricio Pochettino stated all 26 players were available while keeping the starting lineup undisclosed. Production `intel:[]` displays "暂无官方伤停通报"; this is acceptable if AF official injuries are empty, but it needs an official injury source to close.

## Lineups Calibration

| Match | Personnel | Formation | Notes |
|---|---|---|---|
| Mexico-South Africa | PASS/WARN | WARN | [Times of India](https://timesofindia.indiatimes.com/sports/football/fifa-world-cup/mexico-vs-south-africa-confirmed-line-ups-will-six-time-world-cup-icon-and-tournaments-youngest-player-feature-tonight/articleshow/131667166.cms) corroborates the production XI, including Raul Rangel, Israel Reyes, Cesar Montes, Johan Vasquez, Jesus Gallardo, Erik Lira, Alvaro Fidalgo, Brian Gutierrez, Roberto Alvarado, Raul Jimenez, and Julian Quinones. Guardian's lineup text had a Reyes/Alvarado mismatch, so keep a small WARN until an official FIFA/FotMob/SofaScore lineup table is captured. Formation differs: production 4-1-4-1 vs external 4-3-3 / 4-1-2-3. |
| South Africa side | PASS | PASS | Production 5-3-2 and starting XI align with Guardian's South Africa XI. |
| South Korea-Czechia | PASS | WARN | Guardian lists both XIs and production personnel align. Guardian calls both 3-4-3, production normalizes to 3-4-2-1; treat formation as wording/shape WARN. |
| Canada-Bosnia | PASS | OPEN | Production keeps lineups unpublished. External previews are predicted XIs only and were not used as official lineups. |
| USA-Paraguay | PASS | OPEN | Production keeps lineups unpublished. External previews are predicted XIs only and were not used as official lineups. |

## Team Form And Deep Modules

| Module | Status | Evidence / Decision |
|---|---|---|
| Standings | PASS/WARN | Group A production table reflects Mexico and South Korea wins. Group B/D pre-match tables are 0-point tables. Need FIFA/Guardian standings table snapshot for full external closure. |
| Recent form (`formHome/formAway`) | PASS | Production returns empty arrays and UI shows "数据积累中"; no fake form streaks injected. |
| Injuries / intel | WARN | Empty official-injury state is displayed as no official report. Canada preview injury concerns require official source before failing production. |
| Player ratings | OPEN | Production shows ratings, but no external player-rating source was captured this pass. Need FotMob/SofaScore/FIFA match centre or AF source audit. |
| League leaderboards | WARN | Production now collapses four empty leaderboard shells into one official-pending state. Still WARN until AF/source provenance for populated rows is spot-checked. |
| Transfers | WARN/OPEN | Production now filters unusable transfer rows and shows official-pending state instead of concrete-looking "Data unavailable" transactions. National-team transfer relevance remains weak. |
| Season panel | WARN | Production values for played/record now reflect early tournament state; external standings source still needed for full closure. |
| Weather | PASS/WARN | Canada/USA weather appears with MET Norway attribution; Mexico/South Korea weather null and hidden. Need location/time spot-check if this becomes user-critical. |

## User / Admin Fake-Function Scan

Status: WARN, no immediate data-fabrication FAIL found.

- Match data modules generally use "暂无", "未公布", "数据积累中", or hidden/null states when source data is absent.
- Production recharge is gated by `demoRechargeEnabled()`; when production demo recharge is not enabled, public config reports recharge maintenance. Continuation update removed the user/admin simulation wording from disabled states. Real payment remains a product-policy OPEN item until a gateway exists or recharge stays hidden/maintenance-gated.
- `src/server/views/common.ts` has a disclosed "盘口推导" fallback for predictions when AF model direction is missing. This is not external calibration and should remain clearly labelled.

## External Source Links

- [Guardian - Mexico 2-0 South Africa live report](https://www.theguardian.com/football/live/2026/jun/11/mexico-v-south-africa-world-cup-2026-opening-match-live)
- [AP - Mexico 2-0 South Africa report](https://apnews.com/article/4c9de5961b70f1b2cc6e754ff2db57c2)
- [FMF State of Mind - Mexico defeats South Africa](https://www.fmfstateofmind.com/world-cup/27214/mexico-defeat-south-africa-to-finally-win-a-world-cup-opener)
- [Times of India - Mexico vs South Africa confirmed lineups](https://timesofindia.indiatimes.com/sports/football/fifa-world-cup/mexico-vs-south-africa-confirmed-line-ups-will-six-time-world-cup-icon-and-tournaments-youngest-player-feature-tonight/articleshow/131667166.cms)
- [The Sun Ireland - Mexico vs South Africa betting tips](https://www.thesun.ie/betting/17078702/mexico-vs-south-africa-betting-tips-world-cup-2026/)
- [New York Post - Mexico vs South Africa odds/pick](https://nypost.com/2026/06/11/betting/mexico-vs-south-africa-prediction-odds-picks-best-bet-for-world-cup-opener/)
- [Guardian - South Korea 2-1 Czechia live report](https://www.theguardian.com/football/live/2026/jun/12/fifa-world-cup-2026-live-south-korea-v-czechia-updates-kor-vs-cze-group-a-match-score-latest)
- [AP - South Korea 2-1 Czech Republic report](https://apnews.com/article/world-cup-south-korea-czech-republic-score-496e7772dde95ca0af90b5074fdb13d9)
- [The Sun UK - South Korea vs Czechia betting tips](https://www.thesun.co.uk/sport/39337711/south-korea-czechia-world-cup-betting-tips/)
- [New York Post - South Korea vs Czechia odds/pick](https://nypost.com/2026/06/11/betting/south-korea-vs-czechia-world-cup-prediction-odds-picks-and-best-bets-for-thursdays-nightcap/)
- [Guardian - Canada/USA day-two guide](https://www.theguardian.com/football/2026/jun/12/how-to-watch-world-cup-usa-paraguay-canada-bosnia-and-herzegovina)
- [Guardian - USMNT Pochettino press conference](https://www.theguardian.com/football/2026/jun/11/usmnt-pochettino-press-conference-paraguay-world-cup)
- [The Sun UK - Canada vs Bosnia preview](https://www.thesun.co.uk/sport/39310810/canada-vs-bosnia-preview-betting-tips-predictions-world-cup/)
- [The Sun UK - 11-12 June acca tips](https://www.thesun.co.uk/betting/39314635/world-cup-2026-acca-tips-11-12-june/)
- [New York Post - USA vs Paraguay bet365 odds](https://nypost.com/2026/06/12/betting/bet365-bonus-code-bet-10-get-365-in-bonus-bets-for-usa-vs-paraguay/)
- [talkSPORT - Friday 12 June betting tips](https://talksport.com/football/4322037/football-tips-best-football-bets-friday-12-june/)
- [Economic Times - Mexico vs South Africa stats snapshot](https://economictimes.indiatimes.com/news/new-updates/fifa-world-cup-2026-stats-mexico-vs-south-africa-first-match-full-time-score-goal-scorers-match-statistics-and-what-the-results-mean/articleshow/131672153.cms)
- [Economic Times - South Korea vs Czechia highlights/stats snapshot](https://economictimes.indiatimes.com/news/new-updates/south-korea-vs-czechia-fifa-world-cup-2026-highlights-stats-scores-and-how-the-match-unfolded/articleshow/131674064.cms)
- [API-Football Documentation v3](https://www.api-football.com/documentation-v3) — official source reference; direct page extraction was blocked/empty in this environment.

## OPEN Items

1. Find at least one real AH source with URL, capture time, market, line, h/a for each sampled match.
2. Find live/in-play sources with URL, capture time, market, line, h/a/d; otherwise keep live odds calibration OPEN.
3. Capture an official or trusted match-centre full stat table for Mexico-South Africa and South Korea-Czechia to close exact possession/shots/cards/corners/xG values.
4. Capture an official FIFA/FotMob/SofaScore lineup table for Mexico-South Africa to close the remaining formation wording conflict and remove the residual Guardian text mismatch WARN.
5. Re-check Canada-Bosnia and USA-Paraguay after official lineups and match events are published.
6. Decide product policy for recharge: connect real payment, keep demo explicitly gated for non-production, or keep recharge hidden/maintenance-gated in production.
7. Continue media/external odds sourcing; without same-line/same-time public evidence, odds rows remain WARN rather than PASS even though AF-source audit has no line mismatch.
