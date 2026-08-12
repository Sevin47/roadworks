/** Phase 1 verification against the live project. */
import { createClient } from '@supabase/supabase-js';

const URL = 'https://eopdtysmwtdstshlmmgt.supabase.co';
const KEY = 'sb_publishable_oWsMR-lfl5ACMwPb6_sb7w_LVMbW1eb';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const row = (d) => (Array.isArray(d) ? d[0] : d);
let fail = 0;
const ok = (n, c, x = '') => { if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? ' — ' + x : ''}`); };

async function manager(name, county) {
  const sb = createClient(URL, KEY, { auth: { persistSession: false } });
  await sb.auth.signInAnonymously();
  const { data, error } = await sb.rpc('ensure_player', { p_name: name, p_county: county });
  if (error) throw new Error(`${name}: ${error.message}`);
  return { sb, me: row(data) };
}

// ---------------------------------------------------------------- schema
const anon = createClient(URL, KEY, { auth: { persistSession: false } });
await anon.auth.signInAnonymously();

const { data: ranks } = await anon.from('ranks').select('*').order('idx');
ok('rank ladder seeded', ranks?.length === 10, ranks?.map((r) => r.name.split(' ')[0]).join(' > '));
ok('State Highway Engineer present', ranks?.some((r) => r.name === 'State Highway Engineer'),
  `#${ranks?.find((r) => r.name === 'State Highway Engineer')?.idx} @ ${ranks?.find((r) => r.name === 'State Highway Engineer')?.xp_required} XP`);

const { data: cat } = await anon.from('equipment_catalog').select('*').order('sort');
ok('equipment catalog seeded', cat?.length === 8, cat?.map((c) => c.key).join(','));

const { count: facCount } = await anon.from('facilities')
  .select('*', { count: 'exact', head: true }).eq('dispatchable', true);
ok('facilities loaded', facCount >= 150, `${facCount} dispatchable`);

const { data: facDist } = await anon.from('facilities').select('district').eq('dispatchable', true);
const dset = [...new Set((facDist || []).map((f) => f.district))].sort((a, b) => a - b);
ok('every district has garages', dset.length === 10, dset.join(','));

const { data: rate } = await anon.rpc('base_crew_rate');
ok('base rate halved to 0.5', Number(rate) === 0.5, String(rate));

// ---------------------------------------------------------------- territory
const a = await manager('P1Alpha', 'Kanawha');   // District 1
ok('manager created in D1', a.me.district === 1, `${a.me.county} D${a.me.district}`);

const { data: away } = await anon.from('jobs').select('id,district,county,activity')
  .neq('district', 1).eq('incident', false).limit(1);
const args = (job) => ({ p_job: job, p_facility: null, p_route: null, p_secs: null });

const { error: awayErr } = await a.sb.rpc('dispatch_crew', args(away[0].id));
ok('cannot dispatch outside your district',
  !!awayErr && /outside your district/i.test(awayErr.message),
  awayErr?.message?.slice(0, 70));
ok('no ambiguous dispatch_crew overload',
  !/best candidate function/i.test(awayErr?.message || ''),
  'single signature');

const { data: incid } = await anon.from('jobs').select('id,district')
  .eq('incident', true).neq('district', 1).limit(1);
if (incid?.length) {
  const { error: incErr } = await a.sb.rpc('dispatch_crew', args(incid[0].id));
  ok('incidents ARE dispatchable statewide', !incErr,
    incErr ? incErr.message : `reached a D${incid[0].district} incident from D1`);
  if (!incErr) await a.sb.rpc('recall_crew', { p_job: incid[0].id });
} else {
  console.log('SKIP  no out-of-district incident live right now');
}

// ------------------------------------------------------- facilities + routes
const { data: home } = await anon.from('jobs').select('*')
  .eq('district', 1).eq('incident', false).gte('effort', 200).limit(1);
const job = home[0];
console.log(`\n  target: ${job.activity} on ${job.route_label} (${job.county} Co.) effort=${job.effort}\n`);

const { data: fac } = await anon.rpc('nearest_facility',
  { p_district: 1, p_lng: job.centroid[0], p_lat: job.centroid[1] });
const facility = row(fac);
ok('nearest_facility resolves', !!facility?.id, `${facility?.name} (${facility?.kind})`);

// Fetch a real route the way the client does.
const osrm = await fetch(
  `https://router.project-osrm.org/route/v1/driving/${facility.lng},${facility.lat};${job.centroid[0]},${job.centroid[1]}?overview=simplified&geometries=geojson`
).then((r) => r.json()).catch(() => null);
ok('OSRM returned a driving route', osrm?.code === 'Ok',
  osrm ? `${Math.round(osrm.routes[0].distance / 1609)} mi, ${Math.round(osrm.routes[0].duration / 60)} min real` : 'unreachable');

const coords = osrm.routes[0].geometry.coordinates.map((c) => [
  Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5]);
const { data: st1, error: dErr } = await a.sb.rpc('dispatch_crew', {
  p_job: job.id, p_facility: facility.id, p_route: coords, p_secs: osrm.routes[0].duration
});
ok('dispatch with a real route', !dErr, dErr?.message);

const { data: crewRows } = await a.sb.from('crews').select('*').eq('job_id', job.id);
const crew = crewRows[0];
ok('crew records its garage', crew?.facility_id === facility.id, facility.name);
ok('crew carries the route geometry', Array.isArray(crew?.route) && crew.route.length > 5,
  `${crew?.route?.length} points`);
const travelS = (Date.parse(crew.arrives_at) - Date.parse(crew.dispatched_at)) / 1000;
ok('drive time scaled and clamped', travelS >= 8 && travelS <= 75,
  `${Math.round(osrm.routes[0].duration / 60)} real min -> ${travelS.toFixed(1)}s game`);
ok('crew rate stored at base', Number(crew.rate) === 0.5, String(crew.rate));

const { data: cached } = await anon.from('route_cache').select('drive_secs')
  .eq('facility_id', facility.id).eq('job_id', job.id).maybeSingle();
ok('route cached for the next player', !!cached, `${Math.round(cached?.drive_secs / 60)} min`);

// A bogus duration must be rejected in favour of the straight-line estimate.
const b = await manager('P1Bravo', 'Kanawha');
const { data: bogusJob } = await anon.from('jobs').select('id,centroid')
  .eq('district', 1).eq('incident', false).gte('effort', 200).range(1, 1);
await b.sb.rpc('dispatch_crew', {
  p_job: bogusJob[0].id, p_facility: facility.id, p_route: coords, p_secs: 1
});
const { data: bogusCrew } = await b.sb.from('crews').select('*').eq('job_id', bogusJob[0].id);
const bogusTravel = (Date.parse(bogusCrew[0].arrives_at) - Date.parse(bogusCrew[0].dispatched_at)) / 1000;
ok('implausible client drive time refused', bogusTravel >= 8,
  `claimed 1s, server assigned ${bogusTravel.toFixed(1)}s`);
await b.sb.rpc('recall_crew', { p_job: bogusJob[0].id });

// ---------------------------------------------------------------- overtime
const { error: otErr } = await a.sb.rpc('buy_hot_shot', { p_job: job.id });
ok('overtime gated below Foreman', !!otErr && /Foreman/.test(otErr.message), otErr?.message);

// ------------------------------------------------------------ rate + payout
await wait(Math.max(0, Date.parse(crew.arrives_at) - Date.now() + 1200));
const s1 = row(await a.sb.rpc('settle_job', { p_job: job.id }).then((r) => r.data));
await wait(12000);
const s2 = row(await a.sb.rpc('settle_job', { p_job: job.id }).then((r) => r.data));
const measured = (Number(s2.progress) - Number(s1.progress)) /
                 ((Date.parse(s2.progress_at) - Date.parse(s1.progress_at)) / 1000);
ok('solo crew now works at 0.5/sec', Math.abs(measured - 0.5) < 0.05, `measured ${measured.toFixed(3)}`);

console.log(`\n${fail ? `${fail} check(s) failed` : 'all checks passed'}`);
process.exit(fail ? 1 : 0);
