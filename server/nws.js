/**
 * Active National Weather Service alerts for West Virginia.
 *
 * Free, no API key. Shared by the 20-minute alert poll (ingest/weather.js),
 * which drives live storm incidents, and the morning board build
 * (ingest/generate.js), which turns the day's weather into scheduled work.
 */
const FEED = 'https://api.weather.gov/alerts/active?area=WV';
const UA = 'Roadworks-Game (github.com/Sevin47/roadworks)';

/**
 * Which flavour of storm this is, which decides the work it creates.
 *
 * Frost and freeze products are agricultural - they warn growers about the
 * first cold nights of autumn, not about ice on the road - and heat, air
 * quality and cold-only alerts don't put a crew on the highway either. Those
 * come back null and are dropped, so an October frost advisory can't fill the
 * board with snow plows.
 */
export function classify(event) {
  const e = String(event || '').toLowerCase();
  if (/\b(frost|freeze)\b|heat|air quality|wind chill|extreme cold|cold weather|fire|red flag|rip current|beach/.test(e)) {
    return null;
  }
  if (/winter|snow|\bice\b|blizzard|freezing|sleet|lake effect/.test(e)) return 'winter';
  if (/flood|hydrologic/.test(e)) return 'flood';
  if (/wind/.test(e)) return 'wind';
  if (/thunderstorm|tornado|hurricane|tropical/.test(e)) return 'storm';
  return 'other';
}

/**
 * A Warning is a real event, a Watch is a nudge, an Advisory is only a tint.
 * Without this tiering one 34-county Flood Watch — which is exactly what NWS had
 * out over the state the day this was written — would drop most of the state
 * into full storm mode at once.
 */
export function intensity(event) {
  const e = String(event || '').toLowerCase();
  if (e.includes('warning')) return 2;
  if (e.includes('watch')) return 1;
  return 0;
}

export async function fetchAlerts() {
  const res = await fetch(FEED, {
    headers: { 'user-agent': UA, accept: 'application/geo+json' },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`NWS returned HTTP ${res.status}`);
  const body = await res.json();

  const rows = [];
  for (const f of body.features || []) {
    const p = f.properties || {};
    const kind = classify(p.event);
    if (!kind) continue;

    // `area=WV` also returns alerts that merely touch the state, so keep only
    // the SAME codes in state 54 and translate them to county FIPS.
    const fips = (p.geocode?.SAME || [])
      .filter((c) => c.startsWith('054'))
      .map((c) => Number(c));
    if (!fips.length) continue;

    const expires = p.ends || p.expires;
    if (!expires || Date.parse(expires) < Date.now()) continue;

    rows.push({
      id: p.id || f.id,
      event: p.event || 'Alert',
      kind,
      intensity: intensity(p.event),
      severity: p.severity || null,
      headline: (p.headline || '').slice(0, 300) || null,
      onset: p.onset || p.effective || null,
      expires,
      fips
    });
  }
  return rows;
}
