# WVDOT Roadworks — District Dispatch

A shared, real-time browser game for WVDOT staff. Every work order on the board is a
**real row from today's WV511 daily road reports**, located on the **real WVDOT route
network**. You play a county manager: dispatch crews, and close out the day's work
before tomorrow's report replaces it.

There are two ways to run it, and they share the same data pipeline:

| | **Hosted** (recommended) | **LAN** |
| --- | --- | --- |
| What runs | A static site + Supabase. Nothing of yours stays up. | One Node process on your machine. |
| Who can play | Anyone with the link. | Anyone on your network, while your laptop is on. |
| Setup | ~15 min once (SQL + two keys + a GitHub secret). | `npm start`. |
| Where to look | [`web/`](web), [`supabase/schema.sql`](supabase/schema.sql), [`ingest/`](ingest) | [`server/`](server), [`public/`](public) |

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
district. A representative day: **625 rows parsed, 565 on exact milepoint geometry,
58 approximate, 2 unresolved.** The approximate ones fall outside the mapped extent
of a recently re-measured county route; they're drawn dashed with a note.

Check coverage for today without writing anything anywhere:

```bash
npm run refresh
```

## How the game works

- **You are a county manager.** Pick your name and county; your district and HQ
  location come from WVDOT's own county layer.
- **Dispatch crews.** Click a segment on the map or a card in the queue. Crews take
  real travel time from your county HQ, then start working.
- **It's a crowd game.** Effort is measured in crew-seconds. `n` crews on one job
  produce `n × (1 + 0.12·(n−1))` work per second, capped at 3× — so a pile-on from
  six coworkers finishes a job far faster than six people working alone. Everyone
  who contributed shares the XP and budget when it closes.
- **Effort scales with the real work.** Category base plus per-mile cost from the
  actual BMP→EMP length. A one-mile ditchline job is quick; a five-mile paving
  project on Corridor G is not.
- **Live incidents.** Rock slides, downed trees, high water, sinkholes and the rest
  spawn on real route geometry during play, are worth extra XP, and expire if nobody
  responds. (These are generated for gameplay — the scheduled work orders are the
  real data.)
- **New day, new board.** When WV511 posts a new reporting date the board resets and
  the day's standings are frozen. Levels, lifetime XP and budget persist.

---

# Hosted setup (static site + Supabase)

No server. The browser talks to Postgres directly; a scheduled GitHub Action does
the once-a-day PDF work.

### Why there's no tick loop

The original build ran a 1 Hz timer adding work units to every active job — which
is why it needed a process to stay up. The hosted version stores each job's
**banked progress plus the instant it was banked**, and derives the current value
on read. Between crew arrivals the crowd rate is constant, so progress over any
such span is exactly `rate × elapsed`; `settle_job()` walks the arrival events
since the last checkpoint, banks each constant-rate span, and stops at the precise
moment the job hits its effort target. Clients run the same integral locally to
animate the bars, and ask Postgres to settle when their own clock says a job is
done — Postgres then recomputes the whole thing itself, so a patched client can
lie to its own screen and nothing more.

### 1. Supabase

1. Create a free project.
2. **SQL Editor** → paste all of [`supabase/schema.sql`](supabase/schema.sql) → Run.
   The file is idempotent; re-paste it whenever it changes. It creates the tables,
   RLS policies, every RPC, the `pg_cron` schedules and the Realtime publication.
3. **Authentication → Providers → Anonymous sign-ins → enable.** This is what lets
   coworkers join with just a name and county, no accounts.
4. **Project Settings → API** — copy the **Project URL** and the **`anon`** key.

### 2. The daily ingest

The one piece that genuinely needs Node: parsing ten PDFs and geolocating ~600 rows
takes about a minute, so it runs once a day rather than continuously.

In your GitHub repo → **Settings → Secrets and variables → Actions**, add:

- `SUPABASE_URL` — the Project URL
- `SUPABASE_SERVICE_ROLE_KEY` — the **`service_role`** secret (not `anon`; this one
  never touches a browser)

[`.github/workflows/daily-report.yml`](.github/workflows/daily-report.yml) runs it
three times each morning and can be triggered by hand from the **Actions** tab. Run
it once now so the board isn't empty. Locally:

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node ingest/push.js
```

Re-running mid-day is safe: `job_state` is only created, never reset, so nobody
loses progress they've already put in.

### 3. The site

Put your two **public** values into [`web/config.js`](web/config.js):

```js
window.WVDOT_CONFIG = {
  SUPABASE_URL: 'https://your-project-ref.supabase.co',
  SUPABASE_ANON_KEY: 'your-anon-public-key'
};
```

The anon key is public by design — it ships in every browser that loads the page.
RLS is the boundary, not secrecy: every table is read-only to clients and every
mutation goes through a `security definer` RPC.

`web/` is plain static files with no build step. Drag the folder onto
[app.netlify.com/drop](https://app.netlify.com/drop), or connect the repo with
publish directory `web` and no build command. Vercel, Cloudflare Pages and GitHub
Pages all work the same way.

### Data model

| Table | Role |
| --- | --- |
| `game_day` | One row per ingested reporting date |
| `jobs` | The immutable half of a work order — description, geometry, effort. Written once a day, so clients load it once. |
| `job_state` | The mutable half — `progress`, `progress_at`, `crew_count`, `done`. Split out so Realtime payloads don't re-broadcast a job's coordinate array every time a crew shows up. |
| `crews` | Who is on what, and `arrives_at` (when driving ends and work begins) |
| `contributions` | Work units per player per job; splits the payout |
| `players` | Name, county, XP, budget, level, daily score |
| `feed` | Ticker + chat |
| `day_scores` | Frozen standings per finished day |
| `wv_counties` | WVDOT's county list, loaded by the ingest job |

`pg_cron` replaces the old `setInterval` timers: a sweep every minute settles any
job nobody is watching, incidents spawn every two minutes, and history is pruned
nightly.

---

# LAN setup (one Node process)

Nothing to configure — good for a quick game with people on your network.

```bash
npm install
npm start
```

Open `http://localhost:8080`; the console also prints a LAN address to share.
State lives in `data/` (delete it for a clean slate). This path also honours
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` if you'd rather it keep profiles in
Postgres — see [`server/store.js`](server/store.js).

Verify a running server:

```bash
npm run check
```

Connects three test managers, piles them onto one work order, and asserts the
board, geometry, dispatch, crowd completion, XP payout and leaderboard all work.

## Layout

```
web/            hosted client — static, no build step
supabase/       schema.sql: tables, RLS, RPCs, pg_cron, Realtime
ingest/push.js  daily PDF -> geometry -> Postgres job (GitHub Actions)
server/
  wv511.js      district-page scrape, PDF text extraction, report row parser
  lrs.js        county lookup + milepoint-to-geometry clipping (shared by both paths)
  config.js     endpoints and game tuning constants
  index.js      LAN mode: HTTP + WebSocket server
  game.js       LAN mode: tick loop, crews, scoring, incidents
  store.js      LAN mode persistence: JSON files or Supabase
  tools/        refresh.js (coverage report), selftest.js (end-to-end check)
public/         LAN-mode client
```

---

Unofficial, for fun, not a WVDOT product. It only ever reads public WV511 and
WVDOT GIS endpoints.
