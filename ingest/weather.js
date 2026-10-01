/**
 * Pull active National Weather Service alerts for the play area into Supabase.
 *
 * Free, no API key. Runs on a short schedule; the game reads the `alerts` table
 * to decide where incidents spawn, what kind they are, and what they pay.
 *
 *   node ingest/weather.js            # write to Supabase
 *   node ingest/weather.js --dry-run  # print what would be written
 */
import { createClient } from '@supabase/supabase-js';
import { fetchAlerts } from '../server/nws.js';

const DRY = process.argv.includes('--dry-run');
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!DRY && !(URL && KEY)) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or pass --dry-run).');
  process.exit(1);
}
const db = DRY ? null : createClient(URL, KEY, { auth: { persistSession: false } });

async function main() {
  const alerts = await fetchAlerts();
  console.log(`NWS active alerts touching WV counties: ${alerts.length}`);

  let counties = [];
  if (DRY) {
    const { loadCounties, countyList } = await import('../server/lrs.js');
    await loadCounties();
    counties = countyList();
  } else {
    const { data, error } = await db.from('wv_counties').select('code,name,fips');
    if (error) throw new Error(`wv_counties: ${error.message}`);
    counties = data;
  }
  const byFips = new Map(counties.filter((c) => c.fips).map((c) => [Number(c.fips), c]));

  const rows = [];
  for (const a of alerts) {
    const hit = a.fips.map((f) => byFips.get(f)).filter(Boolean);
    if (!hit.length) continue;
    rows.push({
      id: a.id,
      event: a.event,
      kind: a.kind,
      intensity: a.intensity,
      severity: a.severity,
      headline: a.headline,
      onset: a.onset,
      expires: a.expires,
      counties: hit.map((c) => c.code),
      updated_at: new Date().toISOString()
    });
    const tier = ['advisory', 'watch', 'WARNING'][a.intensity];
    console.log(`  ${a.event.padEnd(24)} ${a.kind.padEnd(7)} ${tier.padEnd(8)} ` +
                `${hit.length} counties: ${hit.map((c) => c.name).slice(0, 6).join(', ')}` +
                `${hit.length > 6 ? ` +${hit.length - 6}` : ''}`);
  }

  const playing = rows.filter((r) => r.intensity > 0);
  console.log(`\n${rows.length} alert(s) mapped, ${playing.length} affecting gameplay ` +
              `(${new Set(playing.flatMap((r) => r.counties)).size} counties in storm mode)`);

  if (DRY) { console.log('\nDry run — nothing written.'); return; }

  if (rows.length) {
    const { error } = await db.from('alerts').upsert(rows, { onConflict: 'id' });
    if (error) throw new Error(`alerts: ${error.message}`);
  }
  // Anything NWS no longer lists has been cancelled; don't leave it in play.
  const keep = rows.map((r) => r.id);
  const { error: delErr } = keep.length
    ? await db.from('alerts').delete().not('id', 'in', `(${keep.map((k) => `"${k}"`).join(',')})`)
    : await db.from('alerts').delete().gte('expires', '1970-01-01');
  if (delErr) console.warn(`stale alert cleanup: ${delErr.message}`);

  console.log('Done.');
}

main().catch((e) => { console.error('\nWeather ingest failed:', e.message); process.exit(1); });
