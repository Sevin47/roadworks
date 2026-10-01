/**
 * Build a day's work board and push it to Supabase.
 *
 * The roads are real, measured public GIS centrelines. The work on them is
 * invented here: activities come from a generic maintenance catalogue, placed
 * at generated milepoints on generated shifts. The board is seeded from the
 * date, so the same day always produces the same board no matter how often
 * this runs, but every day looks different.
 *
 *   node ingest/generate.js               # today's board
 *   node ingest/generate.js --dry-run     # build it, print a summary, write nothing
 *   node ingest/generate.js --date=2026-08-20
 */
import { createClient } from '@supabase/supabase-js';
import { buildRouteLibrary, clipMeasured, summarize } from '../server/routelib.js';
import { loadCounties, countyList } from '../server/lrs.js';
import { fetchFacilities, summarize as facSummary } from '../server/facilities.js';
import { CATEGORY, DEFAULT_CATEGORY } from '../server/config.js';
import {
  makeRng, pick, pickActivity, pickDetail, pickShift, WEATHER_WORK
} from '../server/activities.js';
import { fetchAlerts } from '../server/nws.js';
import { pathLengthMi, hashId, round5, simplify } from '../server/util.js';

const DRY = process.argv.includes('--dry-run');
const DATE_ARG = (process.argv.find((a) => a.startsWith('--date=')) || '').split('=')[1];
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!DRY && !(URL && KEY)) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or pass --dry-run).');
  process.exit(1);
}
const db = DRY ? null : createClient(URL, KEY, { auth: { persistSession: false } });

// Work orders per district. Enough that the crowd can never clear a whole day,
// which is what keeps the report card and the district race meaningful.
const PER_DISTRICT = [55, 85];

// Ceiling on weather work, so a statewide warning adds a busy day rather than
// doubling the board. Warnings are placed first and are the last to be cut.
const WEATHER_CAP = 200;

/**
 * Lay one activity onto one road at a generated milepoint window. Returns null
 * when the road is too short for it or the same work is already on that stretch.
 */
function placeJob(rng, reportDate, county, route, act, seen) {
  const span = route.m1 - route.m0;

  // Fit the work zone to the road: never longer than the route itself.
  const wantMin = Math.min(act.len[0], span * 0.6);
  const wantMax = Math.min(act.len[1], span);
  const length = Math.max(0.1, wantMin + rng() * Math.max(0, wantMax - wantMin));
  const bmp = route.m0 + rng() * Math.max(0, span - length);
  const emp = Math.min(route.m1, bmp + length);
  if (emp - bmp < 0.05) return null;

  let coords = clipMeasured(route.pts, bmp, emp);
  if (coords.length < 2) return null;
  // Centrelines are sampled finely enough to follow a winding road; a very
  // long work zone still should not ship hundreds of vertices to every
  // client, so thin the tail end without losing the shape.
  if (coords.length > 200) coords = simplify(coords, 0.00002, 200);

  // Don't file the same activity twice on the same stretch.
  const dedupe = `${county.code}|${route.routeType}|${route.routeNumber}|${act.name}|${bmp.toFixed(1)}`;
  if (seen.has(dedupe)) return null;
  seen.add(dedupe);

  const [start, end] = pickShift(rng, act.cat);
  const cat = CATEGORY[act.cat] ? act.cat : DEFAULT_CATEGORY;
  const c = CATEGORY[cat];
  const miles = Math.round(pathLengthMi(coords) * 100) / 100;
  const mid = coords[Math.floor(coords.length / 2)];

  return {
    id: hashId(`${reportDate}|${dedupe}`),
    report_date: reportDate,
    district: county.district,
    county: county.name,
    county_code: county.code,
    category: cat,
    activity: act.name,
    route_type: route.routeType,
    route_label: `${route.routeType} ${route.routeNumber}`,
    route_name: null,
    bmp: Math.round(bmp * 100) / 100,
    emp: Math.round(emp * 100) / 100,
    start_time: start,
    end_time: end,
    detail: pickDetail(rng, cat),
    miles,
    approx: false,
    incident: false,
    storm: false,
    coords,
    centroid: [round5(mid[0]), round5(mid[1])],
    effort: Math.round(c.base + c.perMile * Math.min(miles, 25)),
    xp_award: c.xp,
    pay_award: c.pay
  };
}

function buildBoard(reportDate, lib) {
  const rng = makeRng(`roadworks|${reportDate}`);
  const byDistrict = new Map();
  for (const c of lib.counties) {
    if (!byDistrict.has(c.district)) byDistrict.set(c.district, []);
    byDistrict.get(c.district).push(c);
  }

  const jobs = [];
  const seen = new Set();

  for (const [, counties] of [...byDistrict.entries()].sort((a, b) => a[0] - b[0])) {
    const target = Math.floor(PER_DISTRICT[0] + rng() * (PER_DISTRICT[1] - PER_DISTRICT[0]));
    let made = 0;
    let attempts = 0;

    while (made < target && attempts < target * 12) {
      attempts++;
      const county = pick(rng, counties);
      const routes = lib.byCounty.get(county.code) || [];
      if (!routes.length) continue;
      const route = pick(rng, routes);
      const job = placeJob(rng, reportDate, county, route, pickActivity(rng, route.routeType), seen);
      if (!job) continue;
      jobs.push(job);
      made++;
    }
  }
  return { jobs, seen };
}

/**
 * The morning's weather, from NWS, taken once per report date.
 *
 * The board is rebuilt several times each morning and every rebuild has to
 * produce the same work orders, or later runs would delete jobs players already
 * have crews on. So the first run's alerts are saved with the day (in
 * game_day.sources) and every later run builds from that copy, not from
 * whatever NWS says an hour on.
 */
async function morningWeather(dayRow) {
  const saved = (dayRow?.sources || []).find((s) => s?.source === 'nws');
  if (saved) return { snapshot: saved, reused: true };
  try {
    const alerts = await fetchAlerts();
    return {
      snapshot: {
        source: 'nws',
        taken_at: new Date().toISOString(),
        alerts: alerts.map(({ event, kind, intensity, fips }) => ({ event, kind, intensity, fips }))
      },
      reused: false
    };
  } catch (err) {
    // Nothing is saved, so a later run this morning tries again and adds the
    // weather work then. Ordinary work is unaffected either way.
    console.warn(`  NWS unavailable (${err.message}); building without weather work`);
    return { snapshot: null, reused: false };
  }
}

/**
 * Turn the morning's alerts into scheduled work in the counties they cover.
 *
 * Seeded separately from the ordinary board, so the weather adds work without
 * reshuffling anything else. Each county is worked once per kind of weather, at
 * the strongest tier any alert gives it.
 */
function weatherJobs(reportDate, lib, alerts, seen) {
  const rng = makeRng(`roadworks|${reportDate}|weather`);
  const byFips = new Map(lib.counties.filter((c) => c.fips).map((c) => [Number(c.fips), c]));

  const plans = new Map();
  for (const a of alerts) {
    if (!WEATHER_WORK[a.kind]) continue;
    for (const f of a.fips) {
      const county = byFips.get(f);
      if (!county) continue;
      const key = `${county.code}|${a.kind}`;
      const prev = plans.get(key);
      if (!prev || a.intensity > prev.intensity) plans.set(key, { county, ...a });
    }
  }

  const ordered = [...plans.values()].sort((x, y) =>
    y.intensity - x.intensity || x.county.code.localeCompare(y.county.code) ||
    x.kind.localeCompare(y.kind));

  const jobs = [];
  for (const p of ordered) {
    if (jobs.length >= WEATHER_CAP) break;
    const spec = WEATHER_WORK[p.kind];
    const names = p.intensity === 1 ? spec.prep : spec.active;
    const [lo, hi] = spec.per[p.intensity];
    const want = Math.min(WEATHER_CAP - jobs.length, lo + Math.floor(rng() * (hi - lo + 1)));
    const routes = lib.byCounty.get(p.county.code) || [];
    if (!routes.length) continue;

    let made = 0;
    for (let attempts = 0; made < want && attempts < want * 12; attempts++) {
      const route = pick(rng, routes);
      const act = pickActivity(rng, route.routeType, names);
      if (!act) continue;
      const job = placeJob(rng, reportDate, p.county, route, act, seen);
      if (!job) continue;
      // Watches and warnings pay the storm bonus, the same tiers that put a
      // county into storm mode for live incidents. An advisory is real work at
      // normal pay.
      job.storm = p.intensity > 0;
      job.detail = `${p.event} in effect.${job.detail ? ` ${job.detail}` : ''}`;
      jobs.push(job);
      made++;
    }
  }
  return jobs;
}

async function must(promise, what) {
  const { error } = await promise;
  if (error) throw new Error(`${what}: ${error.message}`);
}

async function main() {
  const t0 = Date.now();
  await loadCounties();

  const reportDate = DATE_ARG || new Date().toISOString().slice(0, 10);
  console.log(`Building the board for ${reportDate}…`);

  const lib = await buildRouteLibrary({
    onProgress: (d, n) => { if (d % 40 === 0) process.stdout.write(`  sampling roads ${d}/${n}\r`); }
  });
  console.log(`  road library: ${JSON.stringify(summarize(lib))}`);

  // Read before anything is written: a row staged by an earlier run this
  // morning carries the weather that run saw, and this run must reuse it.
  const { data: already } = DRY ? { data: null } : await db.from('game_day')
    .select('published, sources').eq('report_date', reportDate).maybeSingle();

  const weather = await morningWeather(already);
  const { jobs, seen } = buildBoard(reportDate, lib);
  const stormWork = weather.snapshot ? weatherJobs(reportDate, lib, weather.snapshot.alerts, seen) : [];
  jobs.push(...stormWork);

  const byCat = {};
  for (const j of jobs) byCat[j.category] = (byCat[j.category] || 0) + 1;
  const byDist = {};
  for (const j of jobs) byDist[j.district] = (byDist[j.district] || 0) + 1;
  const events = [...new Set((weather.snapshot?.alerts || [])
    .filter((a) => WEATHER_WORK[a.kind]).map((a) => a.event))];

  console.log(`\nwork orders : ${jobs.length}`);
  console.log(`weather     : ${weather.snapshot
    ? `${stormWork.length} order(s) from ${events.length ? events.join(', ') : 'no road-relevant alerts'}` +
      ` (NWS ${weather.reused ? 'as saved at' : 'at'} ${weather.snapshot.taken_at})`
    : 'NWS unavailable, none placed'}`);
  console.log(`by category : ${JSON.stringify(byCat)}`);
  console.log(`by district : ${JSON.stringify(byDist)}`);
  console.log(`counties    : ${new Set(jobs.map((j) => j.county)).size}`);

  const facilities = await fetchFacilities();
  console.log(`facilities  : ${JSON.stringify(facSummary(facilities))}`);

  if (DRY) {
    console.log('\nSample:');
    for (const j of [...jobs.slice(0, 6), ...stormWork.slice(0, 6)]) {
      console.log(`  ${j.activity.padEnd(26)} ${j.route_label.padEnd(9)} ` +
                  `${j.county} Co. D${j.district}  MP ${j.bmp}-${j.emp} (${j.miles}mi)  ` +
                  `${j.start_time}-${j.end_time}`);
    }
    console.log(`\nDry run — nothing written. ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return;
  }

  const counties = countyList().map((c) => ({
    code: c.code, name: c.name, district: c.district,
    center: c.center, fips: c.fips, geom: c.geom
  }));
  await must(db.from('wv_counties').upsert(counties, { onConflict: 'code' }), 'counties');
  await must(db.from('facilities').upsert(facilities, { onConflict: 'id' }), 'facilities');

  // The newest board *before* today. Reading the newest overall meant a failed
  // run, which had already staged today's row, made `previous` equal today — so
  // the rollover was skipped and everyone kept yesterday's score as today's.
  const { data: existing } = await db.from('game_day')
    .select('report_date').lt('report_date', reportDate)
    .order('report_date', { ascending: false }).limit(1);
  const previous = existing?.[0]?.report_date || null;

  // Staged, not published. Jobs reference game_day so the row must exist first,
  // but nothing shows it to a player until the work is actually in place — a run
  // that dies half way through used to leave a board advertising 701 orders and
  // holding none, and the client dutifully displayed the empty day.
  await must(db.from('game_day').upsert({
    report_date: reportDate,
    loaded_at: new Date().toISOString(),
    rows_parsed: jobs.length,
    rows_located: jobs.length,
    sources: weather.snapshot ? [weather.snapshot] : [],
    published: already?.published ?? false
  }, { onConflict: 'report_date' }), 'game_day');

  const CHUNK = 200;
  for (let i = 0; i < jobs.length; i += CHUNK) {
    const slice = jobs.slice(i, i + CHUNK);
    await must(db.from('jobs').upsert(slice, { onConflict: 'id' }), `jobs ${i}`);
    await must(
      db.from('job_state').upsert(slice.map((j) => ({ job_id: j.id })),
        { onConflict: 'job_id', ignoreDuplicates: true }), `job_state ${i}`);
    process.stdout.write(`  writing ${Math.min(i + CHUNK, jobs.length)}/${jobs.length}\r`);
  }

  // Anything on today's board that this run did not generate is stale.
  // Follow-up work opened by finishing a job is not in the generated set, so it
  // has to be excluded here or a re-run during the day would delete it.
  const keep = new Set(jobs.map((j) => j.id));
  const { data: stale } = await db.from('jobs')
    .select('id').eq('report_date', reportDate).eq('incident', false).is('parent_id', null);
  const drop = (stale || []).map((r) => r.id).filter((id) => !keep.has(id));
  for (let i = 0; i < drop.length; i += 200) {
    await must(db.from('jobs').delete().in('id', drop.slice(i, i + 200)), 'prune');
  }
  if (drop.length) console.log(`\n  removed ${drop.length} superseded work order(s)`);

  const { data: marked } = await db.rpc('mark_milestone_jobs', { p_date: reportDate });
  console.log(`\n  ${marked ?? 0} milestone job(s) flagged`);

  // Cached driving routes are keyed to a garage and a job. Re-running a board
  // keeps the same job ids, so without this an old route survives a change to
  // how routes are requested — which is how a set of coarse ones outlived the
  // switch to full-detail geometry. They cost one lookup each to refetch.
  // Only when the board actually changed. This job now runs several times a
  // morning so the first one to succeed wins; the later ones must not keep
  // throwing away routes players are already driving.
  if (!already?.published || previous !== reportDate) {
    const { count: dropped } = await db.from('route_cache')
      .select('*', { count: 'exact', head: true });
    await must(db.from('route_cache').delete().neq('job_id', ''), 'clear route cache');
    if (dropped) console.log(`  cleared ${dropped} cached driving route(s)`);
  }

  // The board is real now: bank yesterday's standings, then make it visible.
  // Called unconditionally rather than only on a detected day change — it banks
  // whatever previous day it finds and moves anyone still sitting on an older
  // date, so a missed rollover repairs itself on the next run instead of leaving
  // players carrying a stale score indefinitely.
  if (previous) console.log(`\n  rolling over from ${previous}`);
  await must(db.rpc('roll_day', { p_new_date: reportDate }), 'roll_day');
  await must(db.from('game_day').update({ published: true })
    .eq('report_date', reportDate), 'publish');
  console.log(`  published ${reportDate}`);

  // Older boards have already been archived by roll_day, and leaving them
  // resident means yesterday's work orders keep answering queries. Deleting the
  // day cascades its jobs, state, crews and contributions; day_scores and the
  // report cards are separate tables and survive.
  const { data: old } = await db.from('game_day')
    .select('report_date').lt('report_date', reportDate);
  if (old?.length) {
    await must(db.from('game_day').delete().lt('report_date', reportDate), 'prune old boards');
    console.log(`  cleared ${old.length} superseded board(s): ${old.map((o) => o.report_date).join(', ')}`);
  }

  await db.from('feed').insert({
    report_date: reportDate,
    kind: 'system',
    body: `Daily road report for ${reportDate} is out — ${jobs.length} work orders across 10 districts.` +
          (stormWork.length
            ? ` ${stormWork.length} are weather response (${events.slice(0, 3).join(', ')}` +
              `${events.length > 3 ? ' and more' : ''}).`
            : '')
  });

  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
}

main().catch((e) => { console.error('\nGeneration failed:', e.message); process.exit(1); });
