/**
 * Daily ingest: WV511 PDFs -> WVDOT route geometry -> Supabase.
 *
 * This is the one part of the game that genuinely needs a Node process, and it
 * runs once a day rather than continuously — parsing ten PDFs and geolocating
 * ~600 rows against ArcGIS takes about a minute. GitHub Actions runs it on a
 * schedule; nothing has to stay up in between.
 *
 *   node ingest/push.js            # ingest today's report
 *   node ingest/push.js --dry-run  # parse and locate, print coverage, write nothing
 */
import { createClient } from '@supabase/supabase-js';
import { fetchAllReports } from '../server/wv511.js';
import { locateRows, loadCounties, countyList, releaseRouteCache } from '../server/lrs.js';
import { CATEGORY, DEFAULT_CATEGORY } from '../server/config.js';

const DRY = process.argv.includes('--dry-run');
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!DRY && !(URL && KEY)) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or pass --dry-run).');
  process.exit(1);
}

const db = DRY ? null : createClient(URL, KEY, { auth: { persistSession: false } });

async function main() {
  const t0 = Date.now();
  await loadCounties();

  console.log('Reading WV511 daily road reports…');
  const bundle = await fetchAllReports({
    onProgress: (d, n) => console.log(`  district ${String(d).padStart(2)} -> ${n} rows`)
  });
  if (bundle.errors?.length) console.warn('  parse errors:', bundle.errors);
  console.log(`\nreport date : ${bundle.reportDate}`);
  console.log(`rows parsed : ${bundle.rows.length}`);

  console.log('\nLocating on the WVDOT county-milepoint route network…');
  const geos = await locateRows(bundle.rows, {
    concurrency: 8,
    onProgress: (d, n) => process.stdout.write(`  ${d}/${n}\r`)
  });
  releaseRouteCache();

  const jobs = [];
  const seen = new Set();
  let exact = 0, approx = 0, miss = 0;
  bundle.rows.forEach((row, i) => {
    const g = geos[i];
    if (!g) { miss++; return; }
    g.exact ? exact++ : approx++;
    if (seen.has(row.key)) return;   // identical work orders collapse to one
    seen.add(row.key);

    const category = CATEGORY[row.category] ? row.category : DEFAULT_CATEGORY;
    const c = CATEGORY[category];
    const miles = Math.max(0, g.miles || 0);
    jobs.push({
      id: row.key,
      report_date: bundle.reportDate,
      district: row.district,
      county: row.county,
      county_code: g.countyCode,
      category,
      activity: row.activity,
      route_type: row.routeType,
      route_label: `${row.routeType} ${row.routeNumber}`,
      route_name: row.routeName,
      bmp: row.bmp,
      emp: row.emp,
      start_time: row.startTime,
      end_time: row.endTime,
      detail: row.detail,
      miles: g.miles,
      approx: !g.exact,
      incident: false,
      coords: g.coords,
      centroid: g.centroid,
      effort: Math.round(c.base + c.perMile * Math.min(miles, 25)),
      xp_award: c.xp,
      pay_award: c.pay
    });
  });

  console.log(`\n\nlocated exact  : ${exact}`);
  console.log(`located approx : ${approx}`);
  console.log(`unlocated      : ${miss}`);
  console.log(`work orders    : ${jobs.length}`);

  if (DRY) {
    console.log(`\nDry run — nothing written. ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return;
  }

  // County reference data, so the client's county picker comes from WVDOT.
  const counties = countyList().map((c) => ({
    code: c.code, name: c.name, district: c.district, center: c.center
  }));
  await must(db.from('wv_counties').upsert(counties, { onConflict: 'code' }), 'wv_counties');

  const { data: existing } = await db.from('game_day').select('report_date').order('report_date', { ascending: false }).limit(1);
  const previousDate = existing?.[0]?.report_date || null;
  const isNewDay = previousDate !== bundle.reportDate;

  await must(db.from('game_day').upsert({
    report_date: bundle.reportDate,
    loaded_at: new Date().toISOString(),
    rows_parsed: bundle.rows.length,
    rows_located: exact + approx,
    sources: bundle.districts
  }, { onConflict: 'report_date' }), 'game_day');

  if (isNewDay && previousDate) {
    console.log(`\nNew reporting date (${previousDate} -> ${bundle.reportDate}); rolling the day over.`);
    await must(db.rpc('roll_day', { p_new_date: bundle.reportDate }), 'roll_day');
  }

  // Upsert in chunks; the payload carries geometry so it is not small.
  const CHUNK = 200;
  for (let i = 0; i < jobs.length; i += CHUNK) {
    const slice = jobs.slice(i, i + CHUNK);
    await must(db.from('jobs').upsert(slice, { onConflict: 'id' }), `jobs ${i}`);
    // job_state is created once and never reset, so re-running the ingest
    // mid-day is safe: nobody loses the progress they have already put in.
    await must(
      db.from('job_state').upsert(slice.map((j) => ({ job_id: j.id })), { onConflict: 'job_id', ignoreDuplicates: true }),
      `job_state ${i}`
    );
    process.stdout.write(`  upserted ${Math.min(i + CHUNK, jobs.length)}/${jobs.length}\r`);
  }

  // Drop scheduled work orders that are no longer in today's report. Incidents
  // are left alone — pg_cron expires those on their own clock.
  const keep = new Set(jobs.map((j) => j.id));
  const { data: stale } = await db.from('jobs')
    .select('id').eq('report_date', bundle.reportDate).eq('incident', false);
  const drop = (stale || []).map((r) => r.id).filter((id) => !keep.has(id));
  if (drop.length) {
    for (let i = 0; i < drop.length; i += 200) {
      await must(db.from('jobs').delete().in('id', drop.slice(i, i + 200)), 'prune jobs');
    }
    console.log(`\n  removed ${drop.length} work order(s) no longer in the report`);
  }

  await db.from('feed').insert({
    report_date: bundle.reportDate,
    kind: 'system',
    body: `Daily road report ${bundle.reportDate} loaded — ${jobs.length} work orders across 10 districts.`
  });

  console.log(`\n\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
}

async function must(promise, what) {
  const { error } = await promise;
  if (error) throw new Error(`${what}: ${error.message}`);
}

main().catch((e) => {
  console.error('\nIngest failed:', e.message);
  process.exit(1);
});
