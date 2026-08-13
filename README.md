# Roadworks

A shared, real-time browser game about keeping the roads open. You play a county
manager: a new work board appears every morning, you dispatch crews to it, and
the whole office works the same board — the more crews on a job, the faster it
closes.

There is no game server. The browser talks to Postgres, every mutation is a
`security definer` RPC, and progress is derived from timestamps rather than a
tick loop. A scheduled job builds each day's board and another watches the
weather; nothing has to stay running in between.

## What is real and what is invented

| | |
| --- | --- |
| **The roads** | Real. Measured public state GIS centrelines, so a work zone sits at genuine milepoints on a road that actually exists, and a crew drives an actual route to reach it. |
| **The garages** | Real locations, invented names. Facility points come from public infrastructure data — a crew rolling out of a garage that is really there is the whole appeal — but each is renamed from its geography (`Kanawha County Garage`, `District 4 Section Garage 2`). |
| **The weather** | Real. Live National Weather Service alerts drive storm mode. |
| **The work** | Invented. Activities come from a generic maintenance catalogue, placed at generated milepoints on generated shifts. Nothing is copied from anyone's published schedule. |

The board is seeded from the date, so a given day always generates the same
board no matter how many times the job runs — but every day is different, and
the mix shifts with the season.

This is an unofficial hobby project and is not affiliated with, endorsed by, or
a product of any transportation agency. It reads public open-data endpoints
only.

## How the game works

- **You are a county manager.** Pick a name and a county; your district and home
  garage follow from it.
- **Dispatch crews.** Click a segment on the map or a card in the queue. Crews
  drive a real route from the nearest garage in the district, work the job, then
  deadhead home before they are free again.
- **It is a crowd game.** Effort is measured in crew-seconds. `n` crews on one
  job produce `n × (1 + 0.12·(n−1))` work per second, capped at 3× — so six
  coworkers piling onto one job beat six people working alone. Everyone who
  contributed shares the XP and budget.
- **Territory.** Your district is your turf and incidents are statewide; work in
  your own county pays 25% more XP.
- **Ranks** run Flagger → Highway Director, and gate the UI: overtime appears at
  Foreman, the equipment garage at County Supervisor. A new player sees only the
  map, the queue and the leaderboard.
- **Budget** buys overtime (hot-shot dispatch, double shifts, hired contractors)
  and permanent equipment.
- **Storm mode.** When the NWS has counties under a warning, incidents
  concentrate there, take their character from the weather, and pay double.
  Winter warnings spawn plow work in priority order: interstates, then US
  routes, then state routes.
- **Dailies.** A check-in streak, county quotas, commendations, a rotating focus
  category, convoy bonuses and radio pings.

## Setup

### 1. Supabase

1. Create a free project.
2. **SQL Editor** → paste all of [`supabase/schema.sql`](supabase/schema.sql) →
   Run. It is idempotent; re-paste it whenever it changes. It creates the
   tables, RLS policies, every RPC, the `pg_cron` schedules and the Realtime
   publication.
3. **Authentication → Providers → Anonymous sign-ins → enable.**
4. **Project Settings → API** — copy the Project URL and the publishable
   (`anon`) key.

### 2. The scheduled jobs

In the repo: **Settings → Secrets and variables → Actions**

- Secrets: `SUPABASE_SERVICE_ROLE_KEY` (and `SUPABASE_URL`)
- Variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY` — used to build the page

| Workflow | Does |
| --- | --- |
| [Generate the daily work board](.github/workflows/daily-board.yml) | Samples road centrelines, invents the day's work, writes it to Supabase |
| [Poll NWS weather alerts](.github/workflows/weather.yml) | Refreshes live alerts every 20 minutes |
| [Deploy site to GitHub Pages](.github/workflows/pages.yml) | Publishes `web/` on every push that touches it |

Run the board workflow once by hand so the board isn't empty.

### 3. The site

`web/` is plain static files — no build step, all paths relative. Pages is
already wired up; `config.js` is generated at deploy time from the two
variables. To run it locally, copy `web/config.example.js` to `web/config.js`,
fill it in, and serve the folder (`python -m http.server 8081`).

## Locally

```bash
npm install
npm run board:dry      # build a board, print a summary, write nothing
npm run weather:dry    # show the live alerts that would drive storm mode
```

To write a specific day: `node ingest/generate.js --date=2026-08-20`.

## Layout

```
web/            the game — static, no build step
supabase/       schema.sql: tables, RLS, RPCs, pg_cron, Realtime
ingest/
  generate.js   builds and publishes a day's board
  weather.js    pulls live NWS alerts
server/
  routelib.js   samples measured road centrelines to place work on
  activities.js the generic work catalogue and the day's randomness
  facilities.js garage locations, renamed from geography
  lrs.js        county lookup and milepoint-to-geometry clipping
  config.js     endpoints and category tuning
GAMEPLAN.md     design plan and build order
```
