# WVDOT Roadworks — Core Game Plan

The design bet: **the real data is the game.** Every mechanic below either makes the
daily WV511 report more interesting to act on, or gives players a reason to come back
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

---

## 1. The three currencies

| | Earned by | Spent on | Resets |
|---|---|---|---|
| **XP** | Closing jobs | Never spent — drives Rank | Never |
| **Budget ($)** | Closing jobs | Overtime, equipment, bids | Never |
| **Commendations (★)** | Daily/weekly goals, SLA saves | Prestige cosmetics + county perks | Never |

XP is the *treadmill*, budget is the *decisions*, commendations are the *trophies*.
Today budget has no sink and XP has one effect (crew count) — fixing that is Phase 1.

## 2. Progression: Career Ranks

Replace the bare level number with WVDOT-flavored ranks. Same XP curve underneath,
rebalanced so the top is reachable in a season of casual play (~2 months of breaks):

| Rank | XP | Unlocks |
|---|---|---|
| Flagger | 0 | 3 crews |
| Crew Leader | 40 | 4th crew |
| Foreman | 160 | Overtime button |
| County Supervisor | 400 | 5th crew, equipment garage |
| Maintenance Superintendent | 800 | Specialist certification slot 1 |
| County Administrator | 1,400 | 6th crew, project bidding |
| District Engineer | 2,200 | Specialist slot 2, district fund access |
| Deputy Commissioner | 3,200 | 7th crew |
| **Commissioner of Highways** | 4,500 | 8th crew, gold name in feed, prestige |

- New curve: `xp(rank)` table above instead of `40·(n−1)²` (the old curve put crew
  #12 at 11,560 XP — decorative, not aspirational).
- **Prestige ("Transfer")**: at Commissioner, optionally transfer to a new county.
  XP resets, you keep equipment + commendations, gain a permanent +2% work rate
  (stacking, cap +10%), and your name gets a service stripe. Leaderboard flavor:
  "Commissioner (2nd term)".

### Specialist certifications

Earned by *doing*, not buying: close 15 Bridge jobs → **Bridge Certified** (+25% work
rate on Bridge category, crew icon gets a hard hat variant). One track per category.
Equipped in limited slots (1–2), so players differentiate: the bridge person, the
incident-response person. Encourages *complementary* dispatching — a certified
specialist joining your job speeds it up more, which deepens rule #2 instead of
violating it.

Implementation: `certifications` table, counted from a `job_completions` log the
payout loop already effectively has (`contributions` at close time); equip is an RPC.

## 3. Budget: what money is for

Three sinks, in order of build priority:

### 3a. Overtime (moment-to-moment sink)
- **Hot-shot dispatch** ($75): this crew travels instantly. Button next to Dispatch.
- **Double shift** ($150): one crew works at 2× for the next 10 minutes. Lazy-accrual
  friendly: store `boost_until` on the crew row; `settle_job()` already integrates
  piecewise spans, a boost is just another rate change at a timestamp.
- **Emergency contractor** ($400): a temporary 4th-party crew (NPC) on one job for
  15 minutes. Counts toward the crowd multiplier — buys the *feeling* of a pile-on
  when you're playing alone at 7am.

### 3b. Equipment garage (session-to-session sink)
Permanent, per-player, purchase once:

| Item | Cost | Effect |
|---|---|---|
| Crew-cab pickup | $800 | −25% travel time |
| Equipment trailer | $1,500 | +10% work rate, all categories |
| Mobile message board | $1,200 | +20% XP from Closures |
| Thermal patcher | $2,000 | +30% rate on Maintenance |
| Under-bridge rig | $3,500 | +30% rate on Bridge |
| Milling machine | $5,000 | +30% rate on Construction Projects |
| **County garage upgrade** | $10,000 | 9th crew (the only crew money can buy) |

Effects apply as per-player rate multipliers → one more factor in `settle_job()`'s
span math (rate = Σ per-crew rates × crowd multiplier, instead of n × multiplier).
That refactor also makes certifications and boosts drop in cleanly.

### 3c. Project bids (strategic sink)
Construction Projects (the 40 XP / $520 jobs) become **sealed-bid contracts**: for the
first 30 minutes after ingest they're locked, players bid budget, lowest-bid-over-
minimum wins the *prime contractor* slot — double share weighting on that job and
their name on it in the queue. Everyone can still crew it (rule #2); the prime just
profits most. Turns the morning report drop into an event.

## 4. Daily & weekly loops

### Daily (resets with the real report — the game already has a natural day)
- **Morning standup** (login bonus, flavor-first): "D4 has 86 work orders today."
  +$100, streak counter. Streaks pay commendations at 5/10/20 days.
- **County quota**: close 5 jobs in *your* county → ★. Pushes players to spread out
  before they pile on, then converge.
- **Incident SLA**: every incident cleared before expiry earns the closers a shared ★
  bonus. Incidents expiring unattended shows on the district report card.
- **District report card** (the social hook): at day rollover, each district gets a
  letter grade — % closed, incident response rate, biggest single job. Posted to the
  feed. WVDOT people will absolutely trash-talk over this.

### Weekly
- **Focus category** (rotates): all Bridge jobs +50% XP this week. One `game_config`
  row, zero new UI beyond a banner.
- **District Cup**: Mon–Fri cumulative district closure %, normalized by district size.
  Winning district's players each get ★ and a feed banner. This is the *between*-
  district competition that makes *within*-job cooperation feel like teamwork.
- **Season** (~8 weeks): leaderboard archives, prestige stripes awarded, one-time
  cosmetic for top 3 counties.

## 5. Interactive gameplay loops (the fun ideas)

Ranked by bang-for-buck:

1. **Convoy bonus** — two+ crews dispatched to the same job within 60s of each other
   all travel 40% faster ("rolling convoy"). Rewards the *social* act of saying "hey,
   everyone hit the Corridor G job" in chat. Trivial: compare `dispatched_at` values.

2. **Storm mode (real weather!)** — poll the free NWS alerts API
   (`api.weather.gov/alerts/active?area=WV`, no key) from the ingest job or a small
   scheduled Action every 30 min. Counties under an actual flood/wind/winter warning
   enter storm mode: incident spawn rate ×3 there, all incident XP ×2, county tinted
   on the map. When it's genuinely storming outside the office, the game lights up.
   This is the single most on-brand feature we could add.

3. **Job chains** — closing certain activities spawns a follow-up at the same
   location: *Bridge Inspection → Bridge Deck Repair (found spalling)*, *Debris
   Removal → Guardrail Repair*. ~15% chance, `on-close` logic inside `settle_job()`.
   Makes the map feel alive between ingests.

4. **Emergency callouts** — rare big incidents (bridge strike, major slide) that
   need **minimum 3 crews on site** before work starts at all. A klaxon feed post +
   map pulse. The only mechanic allowed to *require* cooperation, because demanding
   it occasionally is what makes the crowd identity legible.

5. **Milestone jobs** — the day's 3 longest jobs get segment markers (25/50/75%),
   each paying a small instant bonus to everyone on site. Long jobs stop feeling
   like a wall and start feeling like a march down the actual route geometry.

6. **Radio pings** — click a job → "📻 request backup" posts a one-tap link into the
   feed. Chat already exists; this makes it *actionable*.

7. **Ghost traffic (ambience, later)** — AADT layer (already in the WVDOT REST
   services) sizes a subtle traffic glow on routes; jobs on high-AADT routes pay a
   +hazard bonus. Real data, real texture, zero gameplay burden.

## 6. What we deliberately do NOT build

- **PvP or sabotage** — violates rule #2, and office games sour fast with griefing.
- **Energy/stamina gates** — the daily report reset is already the pacing mechanism.
- **Real-money anything** — obviously.
- **Idle/offline auto-play as default** — the emergency contractor is the one
  sanctioned taste of it; more would hollow out the "dispatch together" identity.
- **Chasing 100% board completion balance** — 600 jobs/day is *supposed* to be more
  than the crowd can finish. The board being unbeatable is what makes the district
  report card and Cup meaningful.

## 7. Build order

**Phase 1 — "Money matters" (core refactor + first sinks)**
`settle_job()` rate refactor (per-crew rates) · overtime ×3 · equipment garage ·
rank table + curve rebalance · report card at rollover
*Everything else depends on the rate refactor; do it first while the schema is young.*

**Phase 2 — "Come back tomorrow"**
Daily quota + streaks · commendations · incident SLA · focus category ·
convoy bonus · radio pings

**Phase 3 — "The world pushes back"**
Storm mode (NWS) · job chains · emergency callouts · milestone jobs

**Phase 4 — "Careers"**
Certifications · project bidding · District Cup + seasons · prestige transfers ·
ghost traffic

Each phase is shippable alone; each schema change stays idempotent-paste-able.
