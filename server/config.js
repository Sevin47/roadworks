import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
export const PUBLIC_DIR = path.join(ROOT, 'public');

export const PORT = Number(process.env.PORT || 8080);

// --- Upstream sources -------------------------------------------------------
export const WV511_DISTRICT_PAGE = 'https://wv511.org/districtRoadwork.aspx';
export const WV511_BASE = 'https://wv511.org';

export const GIS_BASE = 'https://gis.transportation.wv.gov/arcgis/rest/services';
// Linear-referenced route network measured in COUNTY milepoints - exactly the
// measure system the daily road reports use for BMP / EMP.
export const LRS_COUNTY_MP =
  `${GIS_BASE}/Roads_And_Highways/Publication_LRS/MapServer/89`;
export const COUNTIES_LAYER = `${GIS_BASE}/Boundaries/MapServer/1`;
export const DISTRICTS_LAYER = `${GIS_BASE}/Boundaries/MapServer/3`;

// --- Game tuning ------------------------------------------------------------
export const TICK_MS = 1000;              // simulation tick
export const BROADCAST_MS = 1000;         // state push to clients
export const REFRESH_MS = 20 * 60 * 1000; // how often we re-check WV511 for a new report

export const BASE_CREWS = 3;              // crews a level-1 manager controls
export const MAX_CREWS = 12;
export const CREW_TRAVEL_MIN_S = 6;
export const CREW_TRAVEL_MAX_S = 30;

// Crowd bonus: n crews on one job produce n * (1 + TEAMWORK*(n-1)) work units.
export const TEAMWORK = 0.12;
export const TEAMWORK_CAP = 3.0;

export const INCIDENT_INTERVAL_MS = 75 * 1000;
export const INCIDENT_TTL_MS = 8 * 60 * 1000;
export const MAX_LIVE_INCIDENTS = 14;

// Effort (crew-seconds) per category before length scaling.
export const CATEGORY = {
  'Maintenance':          { base: 55,  perMile: 14, xp: 10, pay: 120, color: '#4cc9f0' },
  'Bridge':               { base: 130, perMile: 25, xp: 26, pay: 320, color: '#f7b32b' },
  'Heavy Maintenance':    { base: 110, perMile: 20, xp: 20, pay: 260, color: '#b892ff' },
  'Closures':             { base: 70,  perMile: 10, xp: 16, pay: 200, color: '#ff5d5d' },
  'Construction Projects':{ base: 190, perMile: 30, xp: 40, pay: 520, color: '#ff8a3d' },
  'Utilities/Oil & Gas':  { base: 80,  perMile: 14, xp: 14, pay: 170, color: '#7cf29b' },
  'Incident':             { base: 60,  perMile: 0,  xp: 34, pay: 430, color: '#ff2e63' }
};
export const DEFAULT_CATEGORY = 'Maintenance';
