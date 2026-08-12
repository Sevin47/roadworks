import path from 'node:path';
import { WV511_BASE, WV511_DISTRICT_PAGE, CACHE_DIR } from './config.js';
import { httpGet, writeJson, readJson, pool, hashId } from './util.js';

/**
 * Scrape https://wv511.org/districtRoadwork.aspx for the current set of daily
 * road report PDFs. The FID path segment is rotated whenever a report is
 * replaced, so the links must be re-read every time rather than hardcoded.
 */
export async function listDistrictReports() {
  const html = await httpGet(WV511_DISTRICT_PAGE);
  const out = new Map();
  const re = /href="(\/wsvc\/dfile\/FID\/\d+\/\d+\/([^"]+?\.pdf))"/gi;
  let m;
  while ((m = re.exec(html))) {
    const url = WV511_BASE + m[1];
    const file = m[2];
    // Files are normally District_NN.pdf but at least one district has been
    // seen published as a bare "8.pdf", so accept any digits in the name.
    const num = Number((file.match(/(\d+)/) || [])[1]);
    if (!num || num < 1 || num > 10) continue;
    if (!out.has(num)) out.set(num, { district: num, url, file });
  }
  return [...out.values()].sort((a, b) => a.district - b.district);
}

/** Pull the text of a PDF, one array entry per visual line, in reading order. */
export async function pdfLines(buf) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true
  }).promise;

  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const rows = new Map(); // rounded Y -> items
    for (const it of content.items) {
      if (!it.str) continue;
      const y = Math.round(it.transform[5] * 2) / 2;
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: it.transform[4], s: it.str });
    }
    const ys = [...rows.keys()].sort((a, b) => b - a); // top of page first
    for (const y of ys) {
      const parts = rows.get(y).sort((a, b) => a.x - b.x);
      let line = '';
      let prevEnd = null;
      for (const p2 of parts) {
        if (prevEnd !== null && p2.x - prevEnd > 0.5 && !/\s$/.test(line)) line += ' ';
        line += p2.s;
        prevEnd = p2.x + p2.s.length * 4;
      }
      line = line.replace(/\s+/g, ' ').trim();
      if (line) lines.push(line);
    }
    page.cleanup();
  }
  await doc.cleanup?.();
  return lines;
}

const SECTIONS = [
  'Maintenance',
  'Bridge',
  'Heavy Maintenance',
  'Closures',
  'Construction Projects',
  'Utilities/Oil & Gas',
  'Utilities/Oil and Gas'
];

const ROUTE_TYPES = {
  I: 'Interstate',
  US: 'US Route',
  WV: 'WV Route',
  CO: 'County Route',
  HA: 'Home Access',
  PK: 'Parkway',
  OT: 'Other'
};

// Activity | RouteType | RouteNumber | RouteName | BMP | EMP | Start | End | Detail
const ROW_RE = new RegExp(
  '^(?<activity>.+?)\\s+' +
  '(?<rtype>I|US|WV|CO|HA|PK|OT)\\s+' +
  '(?<rnum>\\d{1,5}(?:/\\d{1,4})?[A-Z]?)\\s+' +
  '(?<rname>.*?)\\s*' +
  '(?<bmp>-?\\d+(?:\\.\\d+)?)\\s+' +
  '(?<emp>-?\\d+(?:\\.\\d+)?)\\s+' +
  '(?<start>\\d{1,2}:\\d{2}\\s*[APap]\\.?[Mm]\\.?)\\s+' +
  '(?<end>\\d{1,2}:\\d{2}\\s*[APap]\\.?[Mm]\\.?)\\s*' +
  '(?<detail>.*)$'
);

/**
 * Snow Removal & Ice Control is filed under the ordinary Maintenance section,
 * but it plays completely differently, so it gets promoted to its own category.
 * The PDF's own section heading is preserved on `section` for fidelity.
 */
const WINTER_RE =
  /\b(snow|ice control|icy|plow|salt|salting|brine|brining|cinder|abrasive|deic|de-ic|sric|drift)/i;

const COUNTY_RE = /^(.+?)\s+County\b/i;
const DATE_RE = /Reporting\s+Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i;

/**
 * Parse one district's daily road report. The layout is standardized: a
 * reporting-date banner, then per-county blocks, each with section headers and
 * fixed-column activity rows.
 */
export function parseReport(lines, district) {
  let reportDate = null;
  let county = null;
  let section = 'Maintenance';
  const rows = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (!reportDate) {
      const d = line.match(DATE_RE);
      if (d) reportDate = normalizeDate(d[1]);
    }
    if (/Reporting\s+Date:/i.test(line) && !COUNTY_RE.test(line)) continue;

    // "<County> County Haq/Shop Worked Limits" starts a new county block.
    if (/Worked\s+Limits/i.test(line)) {
      const c = line.match(COUNTY_RE);
      if (c) {
        county = titleCase(c[1].replace(/^Daily Road Report.*?:\s*\S+\s*/i, '').trim());
        section = 'Maintenance';
      }
      continue;
    }
    if (/^Activity\s+Description\b/i.test(line)) continue;
    if (/^Page\s+\d+/i.test(line)) continue;

    const sec = SECTIONS.find((s) => s.toLowerCase() === line.toLowerCase());
    if (sec) {
      section = sec.startsWith('Utilities') ? 'Utilities/Oil & Gas' : sec;
      continue;
    }

    const m = line.match(ROW_RE);
    if (!m || !county) continue;
    const g = m.groups;

    const bmp = Number(g.bmp);
    const emp = Number(g.emp);
    if (!Number.isFinite(bmp) || !Number.isFinite(emp)) continue;

    const activity = g.activity.trim();
    if (!activity || activity.length > 120) continue;

    const isWinter = WINTER_RE.test(activity) || WINTER_RE.test(g.detail || '');

    rows.push({
      district,
      county,
      section,
      category: isWinter ? 'Winter Ops' : section,
      activity,
      routeType: g.rtype,
      routeTypeLabel: ROUTE_TYPES[g.rtype] || g.rtype,
      routeNumber: g.rnum,
      routeName: g.rname.trim(),
      bmp,
      emp,
      startTime: tidyTime(g.start),
      endTime: tidyTime(g.end),
      detail: g.detail.trim()
    });
  }

  return { district, reportDate, rows };
}

/** Download + parse every district report currently posted on WV511. */
export async function fetchAllReports({ onProgress } = {}) {
  const links = await listDistrictReports();
  const results = await pool(links, 4, async (l) => {
    const buf = await httpGet(l.url, { as: 'buffer' });
    const lines = await pdfLines(buf);
    const parsed = parseReport(lines, l.district);
    parsed.source = l.url;
    onProgress?.(l.district, parsed.rows.length);
    return parsed;
  });

  const good = results.filter((r) => r && !r.__error && r.rows);
  const errors = results
    .map((r, i) => (r && r.__error ? { district: links[i].district, error: r.__error } : null))
    .filter(Boolean);

  const rows = [];
  for (const r of good) {
    for (const row of r.rows) {
      row.reportDate = r.reportDate;
      row.key = hashId(
        [row.district, row.county, row.category, row.activity, row.routeType,
         row.routeNumber, row.routeName, row.bmp, row.emp, row.startTime].join('|')
      );
      rows.push(row);
    }
  }

  const dates = good.map((r) => r.reportDate).filter(Boolean).sort();
  const reportDate = dates.length ? dates[dates.length - 1] : todayISO();

  const bundle = {
    reportDate,
    fetchedAt: new Date().toISOString(),
    districts: good.map((r) => ({ district: r.district, reportDate: r.reportDate, rows: r.rows.length, source: r.source })),
    errors,
    rows
  };
  await writeJson(path.join(CACHE_DIR, `report-${reportDate}.json`), bundle);
  await writeJson(path.join(CACHE_DIR, 'report-latest.json'), bundle);
  return bundle;
}

export async function cachedReport() {
  return readJson(path.join(CACHE_DIR, 'report-latest.json'), null);
}

function normalizeDate(s) {
  const [mm, dd, yyyy] = s.split('/');
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function tidyTime(s) {
  return s.replace(/\s+/g, ' ').replace(/\./g, '').toUpperCase().trim();
}
function titleCase(s) {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).trim();
}
