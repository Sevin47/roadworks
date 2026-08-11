import path from 'node:path';
import { DATA_DIR } from './config.js';
import { readJson, writeJson } from './util.js';

/**
 * Persistence layer with two interchangeable backends.
 *
 *   - JSON files under data/  (default; zero setup, fine for LAN play)
 *   - Supabase Postgres        (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
 *
 * The Supabase backend is what makes hosted play work: free hosting tiers have
 * ephemeral disks and idle-spin-down, so player profiles, the in-progress board
 * and past leaderboards all need to live off the box.
 */

const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');
const DAY_FILE = path.join(DATA_DIR, 'day.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

class FileStore {
  get kind() { return 'files'; }
  async init() {}

  async loadProfiles() {
    return (await readJson(PROFILES_FILE, { profiles: {} })).profiles || {};
  }
  async saveProfiles(profiles) {
    await writeJson(PROFILES_FILE, { profiles });
  }
  async loadDay() {
    return readJson(DAY_FILE, null);
  }
  async saveDay(payload) {
    await writeJson(DAY_FILE, payload);
  }
  async saveDayScores(reportDate, rows) {
    const h = await readJson(HISTORY_FILE, { days: {} });
    h.days[reportDate] = rows;
    const keys = Object.keys(h.days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete h.days[k];
    await writeJson(HISTORY_FILE, h);
  }
  async loadHistory(limit = 14) {
    const h = await readJson(HISTORY_FILE, { days: {} });
    return Object.entries(h.days)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, limit)
      .map(([reportDate, rows]) => ({ reportDate, rows }));
  }
}

class SupabaseStore {
  constructor(url, key) {
    this.url = url;
    this.key = key;
  }
  get kind() { return 'supabase'; }

  async init() {
    const { createClient } = await import('@supabase/supabase-js');
    this.db = createClient(this.url, this.key, { auth: { persistSession: false } });
    const { error } = await this.db.from('players').select('token').limit(1);
    if (error) {
      throw new Error(
        `Supabase reachable but the schema is missing (${error.message}). ` +
        `Run supabase/schema.sql in the SQL editor of your project.`
      );
    }
  }

  async loadProfiles() {
    const { data, error } = await this.db.from('players').select('*');
    if (error) throw error;
    const out = {};
    for (const r of data || []) {
      out[r.token] = {
        token: r.token, name: r.name, county: r.county,
        xp: r.xp || 0, funds: r.funds ?? 2500, jobsDone: r.jobs_done || 0,
        dayXp: r.day_xp || 0, dayDate: r.day_date, joinedAt: Date.parse(r.joined_at) || Date.now()
      };
    }
    return out;
  }

  async saveProfiles(profiles) {
    const rows = Object.values(profiles).map((p) => ({
      token: p.token,
      name: p.name,
      county: p.county,
      xp: Math.round(p.xp || 0),
      funds: Math.round(p.funds || 0),
      jobs_done: p.jobsDone || 0,
      day_xp: Math.round(p.dayXp || 0),
      day_date: p.dayDate || null,
      updated_at: new Date().toISOString()
    }));
    if (!rows.length) return;
    const { error } = await this.db.from('players').upsert(rows, { onConflict: 'token' });
    if (error) throw error;
  }

  async loadDay() {
    const { data, error } = await this.db
      .from('day_state').select('*')
      .order('report_date', { ascending: false }).limit(1);
    if (error) throw error;
    const r = data?.[0];
    return r ? { reportDate: r.report_date, day: r.day, events: r.events, jobs: r.jobs } : null;
  }

  async saveDay(payload) {
    const { error } = await this.db.from('day_state').upsert({
      report_date: payload.reportDate,
      day: payload.day,
      events: payload.events,
      jobs: payload.jobs,
      updated_at: new Date().toISOString()
    }, { onConflict: 'report_date' });
    if (error) throw error;
  }

  async saveDayScores(reportDate, rows) {
    if (!rows.length) return;
    const { error } = await this.db.from('day_scores').upsert(
      rows.map((r) => ({
        report_date: reportDate,
        token: r.token,
        name: r.name,
        county: r.county,
        day_xp: Math.round(r.dayXp || 0),
        jobs_done: r.jobsDone || 0
      })),
      { onConflict: 'report_date,token' }
    );
    if (error) throw error;
  }

  async loadHistory(limit = 14) {
    const { data, error } = await this.db
      .from('day_scores').select('*')
      .order('report_date', { ascending: false })
      .order('day_xp', { ascending: false })
      .limit(limit * 25);
    if (error) throw error;
    const byDay = new Map();
    for (const r of data || []) {
      if (!byDay.has(r.report_date)) byDay.set(r.report_date, []);
      byDay.get(r.report_date).push({ name: r.name, county: r.county, dayXp: r.day_xp, jobsDone: r.jobs_done });
    }
    return [...byDay.entries()].slice(0, limit).map(([reportDate, rows]) => ({ reportDate, rows }));
  }
}

export async function createStore() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  if (url && key) {
    const s = new SupabaseStore(url, key);
    try {
      await s.init();
      console.log('  storage: supabase');
      return s;
    } catch (e) {
      console.warn(`  storage: supabase unavailable (${e.message}) - falling back to local files`);
    }
  }
  const f = new FileStore();
  await f.init();
  console.log('  storage: local files (data/)');
  return f;
}
