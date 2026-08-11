# WVDOT Roadworks — District Dispatch

A shared, real-time browser game for WVDOT staff. Every work order on the board is a
**real row from today's WV511 daily road reports**, located on the **real WVDOT route
network**. You play a county manager: dispatch crews, and close out the day's work
before tomorrow's report replaces it.

## Run it

```bash
npm install
npm start
```

Then open `http://localhost:8080`. The console also prints a LAN address —
share that one with coworkers on the same network and you're all playing the
same board.

## Where the data comes from

| What | Source |
| --- | --- |
| Today's work orders | The ten district PDFs linked from [wv511.org/districtRoadwork.aspx](https://wv511.org/districtRoadwork.aspx). The `FID` path segment rotates whenever a report is replaced, so the page is re-scraped every time rather than hardcoding links. |
| Activity, route type/number/name, BMP, EMP, start/end time, detail | Parsed out of the standardized PDF table, grouped by county block and by section (Maintenance / Bridge / Heavy Maintenance / Closures / Construction Projects / Utilities). |
| Map geometry | [`Roads_And_Highways/Publication_LRS`](https://gis.transportation.wv.gov/arcgis/rest/services/Roads_And_Highways/Publication_LRS/MapServer/89) layer 89, `County_Milepoint` — a linear-referenced route network whose M-values *are* county milepoints, which is exactly the measure system the reports use. Each row's `BMP → EMP` is clipped straight out of the measured polyline. |
| County codes, districts, centroids | [`Boundaries/MapServer/1`](https://gis.transportation.wv.gov/arcgis/rest/services/Boundaries/MapServer/1) (`WV_Counties`). |

Route-type tokens map to LRS sign systems as `I→1, US→2, WV→3, CO→4, HA→5`.
Because the county heading on a report is the **maintenance HQ** — crews routinely
work over the county line — a row that doesn't resolve inside its home county is
retried statewide on the same route number, preferring counties in the reporting
district. On a typical day ~90% of rows land on exact milepoint geometry; a few
percent fall outside the mapped extent of a recently re-measured county route and
are drawn dashed with a "full route shown" note.

Check coverage for today without launching the game:

```bash
npm run refresh
```

## How the game works

- **You are a county manager.** Pick your name and county; your district and HQ
  location come from WVDOT's own county layer.
- **Dispatch crews.** Click a segment on the map or a card in the queue. Crews take
  real travel time from your county HQ, then start working.
- **It's a crowd game.** Effort is measured in crew-seconds. `n` crews on one job
  produce `n × (1 + 0.12·(n−1))` work per second (capped at 3×) — so a pile-on from
  six coworkers finishes a job far faster than six people working alone. Everyone
  who contributed shares the XP and budget when it closes.
- **Effort scales with the real work.** Category base plus per-mile cost from the
  actual BMP→EMP length. A one-mile ditchline job is quick; a five-mile paving
  project on Corridor G is not.
- **Live incidents.** Rock slides, downed trees, high water, sinkholes and the rest
  spawn on real route geometry during play, are worth extra XP, and expire if nobody
  responds. (These are generated for gameplay — the scheduled work orders are the
  real data.)
- **New day, new board.** The server re-reads WV511 every 20 minutes. When the
  reporting date changes, the board resets and today's leaderboard closes out.
  Levels, lifetime XP and budget persist per player.

Progress and player profiles live in `data/`; delete that folder for a clean slate.

## Hosting it so coworkers can play from anywhere

LAN play needs nothing but `npm start`. To put it online — no laptop left
running, scores that survive restarts — you need two pieces: **Supabase** for the
data and **any always-on Node host** for the game loop. (Supabase alone can't run
the game; the tick loop and WebSocket fan-out need a live process.)

**1. Supabase.** In your project's SQL editor, run [`supabase/schema.sql`](supabase/schema.sql).
That creates three tables: `players` (lifetime XP, budget, level), `day_state`
(the in-progress board, so a restart doesn't wipe everyone's day) and `day_scores`
(frozen standings for each finished day). RLS is on with no public policies —
the server talks to them with the service-role key and nothing is reachable from
a browser.

**2. The server.** Set two environment variables and it switches from JSON files
to Postgres automatically:

```
SUPABASE_URL=https://<your-project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role secret, not anon>
```

Locally, copy `.env.example` to `.env` — `npm start` picks it up. For hosting,
[`render.yaml`](render.yaml) is a ready blueprint: on Render, **New → Blueprint**,
point it at this repo, and paste those two values when prompted. Any host that
runs Node and passes WebSockets works the same way (Railway, Fly.io, Fly Machines,
a VM) — the only requirement is a long-lived process, so serverless/edge functions
won't do.

Startup order is deliberate: the server restores the saved board from Supabase
immediately, then reconciles against WV511 in the background, so a cold start
doesn't strand players behind a 60-second geocoding pass. `SIGTERM` flushes state
before the process dies.

`GET /api/health` reports storage backend, reporting date and job count — Render's
health check is already pointed at it.

> On Render's free tier the service sleeps after ~15 minutes with no traffic and
> takes a few seconds to wake, which drops open WebSockets (the client reconnects
> on its own). Because state lives in Supabase, nothing is lost. A paid instance
> or a cheap always-on VM removes the nap.

## Layout

```
server/
  index.js    HTTP + WebSocket server, broadcast loop, daily refresh timer
  game.js     game state, tick loop, crews, scoring, incidents, day rollover
  wv511.js    district-page scrape, PDF text extraction, report row parser
  lrs.js      county lookup + milepoint-to-geometry clipping against WVDOT GIS
  store.js    persistence: local JSON files, or Supabase when configured
  config.js   endpoints and all game tuning constants
  tools/      refresh.js (data coverage report), selftest.js (end-to-end check)
public/       single-page client: Leaflet map, queue, crews, chat, leaderboard
supabase/     schema.sql for the hosted setup
render.yaml   one-click deploy blueprint
```

## Verify a running server

```bash
npm run check
```

Connects three test managers, piles them onto one work order, and asserts the
board, geometry, dispatch, crowd completion, XP payout and leaderboard all work.

---

Unofficial, for fun, not a WVDOT product. It only ever reads public WV511 and
WVDOT GIS endpoints.
