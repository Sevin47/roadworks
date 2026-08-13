# Roadworks — Core Game Plan

The design bet: **the real data is the game.** Every mechanic below either makes the
daily the daily report report more interesting to act on, or gives players a reason to come back
for tomorrow's. Anything that could exist in a generic clicker gets cut.

Hard constraints every mechanic must respect:

1. **Serverless.** Everything is a Postgres RPC, a pg_cron job, or lazy accrual from
   timestamps. If a mechanic needs a resident process, it's designed wrong.
2. **Co-op stays sacred.** The crowd multiplier is the soul of the game. No mechanic
   may make a player unhappy to see another crew arrive on their job. Competition is
   allowed *between districts*, never within a job.
3. **Break-room sessions.** The core loop must pay off in 5–10 minutes. Long arcs live
   on top of short sessions, never instead of them.
4. **One shared board.** No instancing, no private content. Scarcity (who closes what)
   is the multiplayer.
5. **Slow reveal.** New players see exactly today's game: map, dispatch, leaderboard.
   Every added system is rank-gated *in the UI itself* — the overtime button does not
   render until Foreman, the garage until County Supervisor. Complexity is the reward
   for staying, never the price of starting.

---

## 1. Territory: county identity, district turf

- **Your county is who you are.** Chosen at signup; it's your name tag, your HQ, and
  your travel origin.
- **Your district is where you work.** Jobs are dispatchable anywhere in your the highway department
  district. Jobs outside it don't offer a dispatch button (grayed, "outside D4").
- **Home-county bonus:** +25% XP on jobs in your own county, so you patrol your own
  turf first and fan out second.
- **Incidents are statewide.** Any incident, anywhere, is fair game for everyone —
  emergencies don't respect district lines and neither do we.

Why district and not a hard county lock: the reports are organized by maintenance HQ
and crews genuinely work across county lines (the reports themselves note it). More
practically, on a typical day **15 of 55 counties have fewer than 6 work orders** —
Hancock and Upshur have had exactly 1 — and a county-locked player there has nothing
to do by 9am. District turf also lets coworkers who picked different counties still
pile onto the same job, which is the whole game. County pride stays (bonus, report
card, leaderboard grouping); county walls don't.

Implementation: one `where` clause in `dispatch_crew()` (`player.district =
job.district OR job.incident`), plus the XP bonus factor at payout.

## 1b. Facilities & real driving routes

Crews stop teleporting from an abstract county centroid. Both halves ride on real
data, verified working:

### Real dispatch origins
`Transportation/MapServer/4` (WV_DOT_Facilities) carries **218 real the highway department
facilities**: 10 district HQs, ~63 county headquarters, ~57 substations, plus the
interstate/corridor section garages ("I-79 Section 1", "Corridor G Section 2").
The ingest job loads them into a `facilities` table (name, kind, district, county,
point). Materials-division labs are excluded — labs don't dispatch plows.

- Facility markers render on the map (small garage icons; district HQs larger).
  Your county HQ is your "home" pin.
- **Crews roll from the nearest facility in your district to the job**, not from a
  county centroid. A Boone County job gets a crew from Seth Substation; an I-79 job
  gets one from the I-79 section garage. Substations exist in the data precisely so
  response times are short — now that's gameplay.

### Crews drive real roads
On dispatch, the client asks OSRM (`router.project-osrm.org`, free, https, verified
reachable from the Pages origin) for the driving route facility → job. The crew
marker then animates *along the actual roadway* — down Corridor G, over the bridge,
around the hollow — interpolated between `dispatched_at` and `arrives_at` by
cumulative distance, so every player's screen shows the same truck at the same spot.

Serverless mechanics:
- `dispatch_crew(p_job, p_route, p_secs)` accepts the simplified polyline + drive
  time from the client. The server **clamps** `p_secs` against its own straight-line
  estimate (×1–×3 band, plus absolute 8–75s bounds after game-scaling) — the route
  is cosmetic, the clock stays server-authoritative, so a patched client can't buy
  meaningful speed.
- Game time scale: ~2 s per real driving minute. A 37-minute real drive plays as a
  ~74 s trip → clamped to 75 s. Hot-shot dispatch ($75) skips it entirely.
- **Route cache table**: facility→job pairs are stored on first fetch; the first
  dispatcher pays the OSRM call, everyone else (and every later crew) reuses it.
  Keeps us a polite light user of the public demo server; if it ever flakes, the
  fallback is the straight line we ship today.

## 2. The three currencies

| | Earned by | Spent on | Resets |
|---|---|---|---|
| **XP** | Closing jobs | Never spent — drives Rank | Never |
| **Budget ($)** | Closing jobs | Overtime, equipment | Never |
| **Commendations (★)** | Daily/weekly goals, SLA saves, storms | Prestige cosmetics + county perks | Never |

XP is the *treadmill*, budget is the *decisions*, commendations are the *trophies*.

## 3. Pace

Base work rate drops to **0.5 units/sec per crew** (half the launch rate). A routine
maintenance job runs ~2 min solo, ~45 s with a 4-crew pile-on; the day's big
construction jobs become genuine 15–30 minute crowd efforts. Rationale: closes should
feel earned, the board should never run dry mid-afternoon, and the crowd multiplier
reads better when solo work is visibly slow.

Tuning note: rate, equipment prices, and cert thresholds are three knobs that all
lengthen the grind. Rate and prices are set deliberately conservative here; **revisit
all three against live `day_scores` after the first real week** rather than stacking
guesses.

## 4. Progression: Career Ranks

the highway department-flavored ranks on a curve a casual break-room player can *finish* in a season
(~2–3 months), with the UI revealing systems as they're earned:

| Rank | XP | Unlocks |
|---|---|---|
| Flagger | 0 | 3 crews |
| Crew Leader | 40 | 4th crew |
| Foreman | 160 | Overtime button appears |
| County Supervisor | 400 | 5th crew, equipment garage appears |
| Maintenance Superintendent | 800 | Specialist certification slot 1 |
| County Administrator | 1,400 | 6th crew |
| District Engineer | 2,200 | Specialist slot 2 |
| Regional Engineer | 3,200 | 7th crew |
| Deputy Director | 4,400 | +10% budget payouts |
| **Highway Director** | 5,800 | 8th crew, gold name in feed, prestige |

- **Prestige ("Transfer")**: at Highway Director, optionally transfer to a new county
  (new district = genuinely new board). XP resets, you keep equipment and
  commendations, gain a permanent +2% work rate (stacking, cap +10%), and a service
  stripe: "Director (2nd term)".

### Specialist certifications

Earned by doing, not buying — and rare enough to mean something. Thresholds scale
with how often each category actually appears in the reports (Bridge runs ~11 rows
per day *statewide*; Maintenance runs ~400):

| Certification | Closes required | Effect |
|---|---|---|
| Maintenance | 75 | +25% rate on Maintenance |
| Closures | 40 | +25% rate on Closures |
| Construction | 30 | +25% rate on Construction Projects |
| Utilities | 25 | +25% rate on Utilities/Oil & Gas |
| Heavy Maintenance | 20 | +25% rate on Heavy Maintenance |
| Bridge | 20 | +25% rate on Bridge |
| Incident Response | 50 | +25% rate on Incidents |
| Winter Ops | 40 (winter rows) | +25% rate on Winter Ops |

Limited equip slots (1 at Superintendent, 2 at District Engineer) force identity:
the bridge person, the storm chaser. A certified specialist joining your job speeds
it up more than a generalist — cooperation gets *deeper*, not just wider.

## 5. Budget: what money is for

Two sinks. (Project bidding was considered and cut — auction mechanics on day one is
exactly the too-much-too-soon complexity rule #5 exists to prevent.)

### 5a. Overtime (moment-to-moment, unlocked at Foreman)
- **Hot-shot dispatch** ($75): this crew travels instantly.
- **Double shift** ($150): one crew works at 2× for 10 minutes. Lazy-accrual
  friendly: `boost_until` on the crew row is just another rate-change timestamp in
  `settle_job()`'s span walk.
- **Emergency contractor** ($400): a temporary NPC crew on one job for 15 minutes.
  Counts toward the crowd multiplier — buys the *feeling* of a pile-on when you're
  the only one on at 7am.

### 5b. Equipment garage (permanent, unlocked at County Supervisor)

| Item | Cost | Effect |
|---|---|---|
| Crew-cab pickup | $2,000 | −25% travel time |
| Equipment trailer | $3,500 | +10% work rate, all categories |
| Mobile message board | $3,000 | +20% XP from Closures |
| Thermal patcher | $5,000 | +30% rate on Maintenance |
| Under-bridge rig | $8,000 | +30% rate on Bridge |
| Snow plow rig | $8,000 | +30% rate on Winter Ops |
| Milling machine | $12,000 | +30% rate on Construction Projects |
| **County garage upgrade** | $25,000 | 9th crew (the only crew money can buy) |

At ~$120–520 per close, the first tool is a first-week goal, the garage upgrade is an
end-game monument. Effects are per-player rate multipliers — one more factor in
`settle_job()`'s span math (rate = Σ per-crew rates × crowd multiplier instead of
n × multiplier). That refactor is the keystone: certifications, boosts, equipment,
and prestige bonuses all drop into the same integral.

## 6. Winter operations

Two layers, both riding on real data:

### 6a. The reports already know it's winter
the highway department files **Snow Removal & Ice Control (SRIC)** rows in the daily reports all
winter — plowing, salting, brining, cindering. The parser already passes them
through untouched. We detect them (`snow|ice|plow|salt|brine|cinder|SRIC` against
activity + detail) and promote them to a **Winter Ops** category: own color
(ice blue), own cert track, pay above Maintenance — plowing at 5am deserves it.
Zero new data plumbing; the category simply lights up when the season does.

### 6b. NWS storm mode (real weather, year-round)
A scheduled Action polls `api.weather.gov/alerts/active?area=WV` (free, no key)
every 30 minutes and upserts active alerts into an `alerts` table with their county
lists (NWS FIPS ↔ our `wv_counties.fips`).

Counties under an active warning enter **storm mode** — tinted on the map, and:

| Real NWS alert | In-game effect |
|---|---|
| Winter Storm / Ice Storm / Blizzard Warning | Plow-route incidents spawn on interstates & US routes in affected counties (priority order: I → US → WV, like real plow priority); incident XP ×2; Winter Ops rows there +50% XP |
| Flood Warning | High Water incidents ×3 spawn rate in affected counties |
| High Wind Warning | Downed Tree / debris incidents ×3 |
| Severe Thunderstorm Warning | Signal Outage / debris incidents ×2 |

**Storm-mode incidents are statewide-dispatchable like all incidents — this is when
the whole state converges on one corner of the map.** When it's actually snowing
outside the office window, the game lights up. Most on-brand feature we can build.

- **Snowbird ★ commendation**: close 10 Winter Ops/incident jobs during active
  winter warnings.
- pg_cron reads the `alerts` table for spawn multipliers; the Action only writes it.

## 7. Daily & weekly loops

### Daily (resets with the real report)
- **Morning standup**: login flavor + $100, streak counter; ★ at 5/10/20-day streaks.
- **County quota**: close 5 jobs in your home county → ★ (synergizes with the +25%).
- **Incident SLA**: incidents cleared before expiry pay the closers a shared ★ bonus;
  expirations show on the report card.
- **District report card** (the social hook): at rollover each district gets a letter
  grade — % closed, incident response rate, biggest job. Posted to the feed. This is
  the trash-talk engine.

### Weekly
- **Focus category** (rotates): e.g. all Bridge jobs +50% XP. One config row.
- **District Cup**: Mon–Fri cumulative closure %, normalized by district size.
  Winning district's players each get ★. Between-district competition is what makes
  within-job cooperation feel like teamwork.
- **Season** (~8 weeks): boards archive, prestige stripes, cosmetic for top county.

## 8. Interactive gameplay loops

Ranked by bang-for-buck:

1. **Convoy bonus** — crews dispatched to the same job within 60s of each other all
   travel 40% faster. Makes "everyone hit Corridor G" in chat mechanically real.
   Trivial: compare `dispatched_at`.
2. **Job chains** — closing some activities spawns a follow-up on the same geometry:
   *Bridge Inspection → Deck Repair (found spalling)*, *Debris Removal → Guardrail
   Repair*. ~15% roll inside `settle_job()`'s completion branch.
3. **Emergency callouts** — rare big incidents (bridge strike, major slide) needing
   **3+ crews on site before work starts at all**. Klaxon feed post, map pulse. The
   one mechanic allowed to *require* cooperation.
4. **Milestone jobs** — the day's 3 longest jobs get 25/50/75% markers paying small
   instant bonuses to everyone on site. Long jobs become a march down real geometry.
5. **Radio pings** — "📻 request backup" posts a one-tap dispatch link to the feed.
6. **Ghost traffic (later)** — AADT layer (already in the state's REST services) sizes a
   traffic glow; high-AADT jobs pay a hazard bonus. Texture, near-zero burden.

## 9. What we deliberately do NOT build

- **Project bidding / auctions** — cut. Economy-on-economy complexity that scares off
  exactly the slow-easing players this is for. Revisit only if the game outgrows the
  office.
- **PvP or sabotage** — violates rule #2; office games sour fast with griefing.
- **Energy/stamina gates** — the daily report reset is already the pacing.
- **Real-money anything** — obviously.
- **Idle auto-play as default** — the emergency contractor is the one sanctioned
  taste; more would hollow out the dispatch-together identity.
- **Balancing toward 100% board completion** — 600 jobs/day is *supposed* to be more
  than the crowd can finish; that's what makes the report card and Cup meaningful.

## 10. Build order

**Phase 1 — "Money matters" (keystone refactor + first sinks)**
`settle_job()` per-crew-rate refactor · 0.5 rate rebase · district territory rule +
home-county bonus · rank table (10 ranks) with UI gating · overtime ×3 · equipment
garage · report card at rollover · **facilities table + nearest-garage dispatch +
OSRM driving routes** (travel is being rewritten for territory anyway — do the
origins and routes in the same pass)

**Phase 2 — "Come back tomorrow"**
Daily quota + streaks · commendations · incident SLA · focus category · convoy
bonus · radio pings

**Phase 3 — "The world pushes back"**
NWS alerts pipeline · storm mode · Winter Ops category + SRIC detection · job
chains · emergency callouts · milestone jobs
*(Ship before the first snow — the SRIC rows start appearing in the reports on
their own.)*

**Phase 4 — "Careers"**
Certifications · District Cup + seasons · prestige transfers · ghost traffic

Each phase is shippable alone; every schema change stays idempotent-paste-able.
