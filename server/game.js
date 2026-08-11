import path from 'node:path';
import crypto from 'node:crypto';
import {
  DATA_DIR, CATEGORY, DEFAULT_CATEGORY, TICK_MS, BASE_CREWS, MAX_CREWS,
  CREW_TRAVEL_MIN_S, CREW_TRAVEL_MAX_S, TEAMWORK, TEAMWORK_CAP,
  INCIDENT_INTERVAL_MS, INCIDENT_TTL_MS, MAX_LIVE_INCIDENTS
} from './config.js';
import { readJson, writeJson, haversineMi, hashId } from './util.js';
import { fetchAllReports, cachedReport } from './wv511.js';
import { locateRows, loadCounties, countyList, lookupCounty, releaseRouteCache } from './lrs.js';

const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');
const DAY_FILE = path.join(DATA_DIR, 'day.json');

const INCIDENT_KINDS = [
  { kind: 'Rock Slide',        detail: 'Rock and debris in the roadway - dispatch to clear.' },
  { kind: 'Downed Tree',       detail: 'Tree across both lanes after storm activity.' },
  { kind: 'High Water',        detail: 'Water over the roadway; signs and barricades needed.' },
  { kind: 'Crash Debris',      detail: 'Secondary cleanup requested by responders.' },
  { kind: 'Signal Outage',     detail: 'Dark signal - temporary stop control required.' },
  { kind: 'Guardrail Strike',  detail: 'Damaged guardrail needs emergency repair.' },
  { kind: 'Sinkhole',          detail: 'Pavement failure reported; lane closure in place.' },
  { kind: 'Slip / Slide',      detail: 'Embankment slip encroaching on the travel lane.' }
];

export class Game {
  constructor() {
    this.jobs = new Map();
    this.players = new Map();      // playerId -> player
    this.tokens = new Map();       // token -> playerId
    this.profiles = {};            // token -> persisted profile
    this.events = [];              // ticker
    this.dirtyJobs = new Set();
    this.day = { reportDate: null, startedAt: Date.now(), rows: 0, located: 0, sources: [] };
    this.loading = { active: true, message: 'Starting up...' };
    this.listeners = new Set();
    this.nextIncidentAt = Date.now() + INCIDENT_INTERVAL_MS;
    this.seq = 0;
  }

  // ---------------------------------------------------------------- lifecycle

  async init() {
    await loadCounties();
    this.profiles = (await readJson(PROFILES_FILE, { profiles: {} })).profiles || {};

    const saved = await readJson(DAY_FILE, null);
    const live = await cachedReport();
    if (saved && live && saved.reportDate === live.reportDate) {
      this.restoreDay(saved);
      this.loading = { active: false, message: '' };
      this.log('system', `Resumed day ${saved.reportDate} with ${this.jobs.size} work orders.`);
    } else {
      await this.loadDay({ force: false });
    }
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /** Pull the current WV511 reports, geolocate every row, and build the job board. */
  async loadDay({ force = true } = {}) {
    this.loading = { active: true, message: 'Reading WV511 daily road reports...' };
    this.emit();
    let bundle = null;
    try {
      bundle = await fetchAllReports();
    } catch (e) {
      bundle = await cachedReport();
      if (!bundle) {
        this.loading = { active: false, message: `Could not reach WV511: ${e.message}` };
        this.emit();
        return;
      }
    }

    this.loading = { active: true, message: `Locating ${bundle.rows.length} work orders on the WVDOT route network...` };
    this.emit();

    const geos = await locateRows(bundle.rows, {
      concurrency: 8,
      onProgress: (d, n) => {
        this.loading = { active: true, message: `Locating work orders... ${d} / ${n}` };
        this.emit();
      }
    });
    releaseRouteCache();

    const previous = this.jobs;
    this.jobs = new Map();
    let located = 0;
    bundle.rows.forEach((row, i) => {
      const g = geos[i];
      if (!g) return;
      located++;
      const job = this.makeJob(row, g);
      // Carry progress over if the same work order survives a mid-day refresh.
      const old = previous.get(job.id);
      if (old && old.reportDate === job.reportDate) {
        job.progress = old.progress;
        job.contrib = old.contrib;
        job.done = old.done;
        job.doneAt = old.doneAt;
        job.crews = old.crews;
      }
      this.jobs.set(job.id, job);
    });

    this.day = {
      reportDate: bundle.reportDate,
      startedAt: Date.now(),
      rows: bundle.rows.length,
      located,
      sources: bundle.districts,
      errors: bundle.errors
    };
    for (const p of this.players.values()) this.recallAll(p, true);
    this.loading = { active: false, message: '' };
    this.log('system', `Daily road report ${bundle.reportDate} loaded - ${located} work orders across 10 districts.`);
    await this.persistDay();
    this.emit();
  }

  makeJob(row, g) {
    const cat = CATEGORY[row.category] ? row.category : DEFAULT_CATEGORY;
    const c = CATEGORY[cat];
    const miles = Math.max(0, g.miles || 0);
    const effort = Math.round(c.base + c.perMile * Math.min(miles, 25));
    const county = lookupCounty(row.county);
    return {
      id: row.key,
      district: row.district,
      county: row.county,
      countyCode: g.countyCode || county?.code || null,
      category: cat,
      activity: row.activity,
      routeType: row.routeType,
      routeLabel: `${row.routeType} ${row.routeNumber}`,
      routeName: row.routeName,
      bmp: row.bmp,
      emp: row.emp,
      startTime: row.startTime,
      endTime: row.endTime,
      detail: row.detail,
      reportDate: row.reportDate,
      coords: g.coords,
      centroid: g.centroid,
      miles: g.miles,
      approx: !g.exact,
      effort,
      progress: 0,
      crews: [],
      contrib: {},
      done: false,
      doneAt: null,
      incident: false
    };
  }

  restoreDay(saved) {
    this.jobs = new Map(saved.jobs.map((j) => [j.id, { ...j, crews: [] }]));
    this.day = saved.day;
    this.events = saved.events || [];
  }

  async persistDay() {
    await writeJson(DAY_FILE, {
      reportDate: this.day.reportDate,
      day: this.day,
      events: this.events.slice(-60),
      jobs: [...this.jobs.values()].map((j) => ({ ...j, crews: [] }))
    });
  }

  async persistProfiles() {
    await writeJson(PROFILES_FILE, { profiles: this.profiles });
  }

  // ------------------------------------------------------------------ players

  join(token, name, countyName) {
    token = token || crypto.randomUUID();
    const county = lookupCounty(countyName) || countyList()[0];
    const prof = this.profiles[token] || {
      token, name, county: county.name, xp: 0, funds: 2500,
      jobsDone: 0, allTimeXp: 0, dayXp: 0, dayDate: this.day.reportDate, joinedAt: Date.now()
    };
    prof.name = String(name || prof.name || 'Manager').slice(0, 22).trim() || 'Manager';
    prof.county = county.name;
    if (prof.dayDate !== this.day.reportDate) { prof.dayDate = this.day.reportDate; prof.dayXp = 0; }
    this.profiles[token] = prof;

    const id = hashId(token);
    const level = levelFor(prof.xp);
    const player = this.players.get(id) || { id };
    Object.assign(player, {
      id,
      token,
      name: prof.name,
      county: county.name,
      countyCode: county.code,
      district: county.district,
      home: county.center,
      xp: prof.xp,
      dayXp: prof.dayXp,
      funds: prof.funds,
      jobsDone: prof.jobsDone,
      level,
      maxCrews: Math.min(MAX_CREWS, BASE_CREWS + Math.floor(level / 2)),
      crews: player.crews || [],
      online: true,
      lastSeen: Date.now()
    });
    this.players.set(id, player);
    this.tokens.set(token, id);
    this.persistProfiles();
    return player;
  }

  leave(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.online = false;
    this.recallAll(p);
    this.players.delete(playerId);
  }

  // -------------------------------------------------------------------- crews

  dispatch(playerId, jobId) {
    const p = this.players.get(playerId);
    const job = this.jobs.get(jobId);
    if (!p || !job || job.done) return { error: 'That work order is no longer open.' };
    if (p.crews.length >= p.maxCrews) return { error: 'All of your crews are already out.' };
    if (p.crews.some((c) => c.jobId === jobId)) return { error: 'You already have a crew on that one.' };

    const dist = p.home && job.centroid ? haversineMi(p.home, job.centroid) : 20;
    const travel = Math.round(
      Math.min(CREW_TRAVEL_MAX_S, Math.max(CREW_TRAVEL_MIN_S, CREW_TRAVEL_MIN_S + dist * 0.28))
    );
    const crew = {
      id: `c${++this.seq}`,
      playerId,
      playerName: p.name,
      jobId,
      phase: 'travel',
      travelTotal: travel,
      travelLeft: travel,
      from: p.home,
      to: job.centroid
    };
    p.crews.push(crew);
    job.crews.push(crew);
    this.dirtyJobs.add(jobId);
    return { ok: true, crew };
  }

  recall(playerId, crewId) {
    const p = this.players.get(playerId);
    if (!p) return { error: 'Unknown player.' };
    const idx = p.crews.findIndex((c) => c.id === crewId);
    if (idx < 0) return { error: 'No such crew.' };
    const [crew] = p.crews.splice(idx, 1);
    const job = this.jobs.get(crew.jobId);
    if (job) {
      job.crews = job.crews.filter((c) => c.id !== crewId);
      this.dirtyJobs.add(job.id);
    }
    return { ok: true };
  }

  recallAll(p, silent = false) {
    for (const crew of [...p.crews]) this.recall(p.id, crew.id);
    if (!silent) this.emit();
  }

  // --------------------------------------------------------------------- tick

  tick() {
    const now = Date.now();
    const finished = [];

    for (const p of this.players.values()) {
      for (const crew of p.crews) {
        if (crew.phase === 'travel') {
          crew.travelLeft -= TICK_MS / 1000;
          if (crew.travelLeft <= 0) {
            crew.phase = 'working';
            crew.travelLeft = 0;
            this.dirtyJobs.add(crew.jobId);
          }
        }
      }
    }

    for (const job of this.jobs.values()) {
      if (job.done) continue;
      const working = job.crews.filter((c) => c.phase === 'working');
      if (!working.length) continue;
      const n = working.length;
      const multiplier = Math.min(TEAMWORK_CAP, 1 + TEAMWORK * (n - 1));
      const rate = n * multiplier;          // work units per second
      const share = rate / n;
      job.progress = Math.min(job.effort, job.progress + rate);
      for (const c of working) job.contrib[c.playerId] = (job.contrib[c.playerId] || 0) + share;
      this.dirtyJobs.add(job.id);
      if (job.progress >= job.effort) finished.push(job);
    }

    for (const job of finished) this.completeJob(job, now);

    this.updateIncidents(now);

    for (const p of this.players.values()) {
      if (now - p.lastSeen > 90_000) { p.online = false; }
    }
    this.emit();
  }

  completeJob(job, now) {
    job.done = true;
    job.doneAt = now;
    const cat = CATEGORY[job.category] || CATEGORY[DEFAULT_CATEGORY];
    const total = Object.values(job.contrib).reduce((a, b) => a + b, 0) || 1;
    const names = [];
    for (const [pid, units] of Object.entries(job.contrib)) {
      const p = this.players.get(pid);
      const frac = units / total;
      const xp = Math.max(1, Math.round(cat.xp * (0.6 + 0.4 * frac) * (job.incident ? 1.4 : 1)));
      const pay = Math.round(cat.pay * frac);
      if (p) {
        p.xp += xp;
        p.dayXp += xp;
        p.funds += pay;
        p.jobsDone += 1;
        p.level = levelFor(p.xp);
        p.maxCrews = Math.min(MAX_CREWS, BASE_CREWS + Math.floor(p.level / 2));
        const prof = this.profiles[p.token];
        if (prof) {
          prof.xp = p.xp; prof.dayXp = p.dayXp; prof.funds = p.funds;
          prof.jobsDone = p.jobsDone; prof.dayDate = this.day.reportDate;
        }
        names.push(p.name);
      }
    }
    for (const crew of [...job.crews]) this.recall(crew.playerId, crew.id);
    job.crews = [];
    this.dirtyJobs.add(job.id);
    const who = names.length ? [...new Set(names)].join(', ') : 'an unknown crew';
    this.log(job.incident ? 'incident-cleared' : 'complete',
      `${who} completed ${job.activity} on ${job.routeLabel} (${job.county} Co.)`);
    this.persistProfiles();
    this.persistDay();
  }

  // ---------------------------------------------------------------- incidents

  updateIncidents(now) {
    for (const job of [...this.jobs.values()]) {
      if (job.incident && !job.done && job.expiresAt && now > job.expiresAt) {
        for (const crew of [...job.crews]) this.recall(crew.playerId, crew.id);
        this.jobs.delete(job.id);
        this.dirtyJobs.add(job.id);
        this.log('incident-expired', `${job.activity} on ${job.routeLabel} (${job.county} Co.) went unattended.`);
      }
    }
    if (now < this.nextIncidentAt) return;
    this.nextIncidentAt = now + INCIDENT_INTERVAL_MS;
    const live = [...this.jobs.values()].filter((j) => j.incident && !j.done).length;
    if (live >= MAX_LIVE_INCIDENTS) return;
    this.spawnIncident(now);
  }

  spawnIncident(now) {
    const pool = [...this.jobs.values()].filter((j) => !j.incident && j.coords?.length > 1);
    if (!pool.length) return;
    const src = pool[Math.floor(Math.random() * pool.length)];
    const kind = INCIDENT_KINDS[Math.floor(Math.random() * INCIDENT_KINDS.length)];
    const i = Math.max(1, Math.floor(Math.random() * (src.coords.length - 1)));
    const seg = [src.coords[i - 1], src.coords[i]];
    const cat = CATEGORY.Incident;
    const job = {
      id: `inc-${++this.seq}`,
      district: src.district,
      county: src.county,
      countyCode: src.countyCode,
      category: 'Incident',
      activity: kind.kind,
      routeType: src.routeType,
      routeLabel: src.routeLabel,
      routeName: src.routeName,
      bmp: src.bmp,
      emp: src.emp,
      startTime: fmtClock(now),
      endTime: fmtClock(now + INCIDENT_TTL_MS),
      detail: kind.detail,
      reportDate: this.day.reportDate,
      coords: seg,
      centroid: seg[0],
      miles: 0,
      approx: false,
      effort: cat.base,
      progress: 0,
      crews: [],
      contrib: {},
      done: false,
      doneAt: null,
      incident: true,
      expiresAt: now + INCIDENT_TTL_MS
    };
    this.jobs.set(job.id, job);
    this.dirtyJobs.add(job.id);
    this.log('incident', `${kind.kind} reported on ${job.routeLabel} in ${job.county} County - District ${job.district}.`);
  }

  // ------------------------------------------------------------------ ticker

  log(type, text) {
    this.events.push({ type, text, t: Date.now() });
    if (this.events.length > 120) this.events.splice(0, this.events.length - 120);
  }

  chat(playerId, text) {
    const p = this.players.get(playerId);
    if (!p) return;
    const clean = String(text || '').slice(0, 200).trim();
    if (!clean) return;
    this.log('chat', `${p.name}: ${clean}`);
    this.emit();
  }

  // ----------------------------------------------------------------- snapshot

  jobPublic(j) {
    return {
      id: j.id, district: j.district, county: j.county, category: j.category,
      activity: j.activity, routeType: j.routeType, routeLabel: j.routeLabel,
      routeName: j.routeName, bmp: j.bmp, emp: j.emp, startTime: j.startTime,
      endTime: j.endTime, detail: j.detail, coords: j.coords, centroid: j.centroid,
      miles: j.miles, approx: j.approx, effort: j.effort, progress: Math.round(j.progress),
      done: j.done, incident: j.incident, expiresAt: j.expiresAt || null,
      crewCount: j.crews.length,
      crewsWorking: j.crews.filter((c) => c.phase === 'working').length,
      helpers: [...new Set(j.crews.map((c) => c.playerName))]
    };
  }

  fullState() {
    return {
      day: this.day,
      loading: this.loading,
      jobs: [...this.jobs.values()].map((j) => this.jobPublic(j)),
      players: this.playersPublic(),
      crews: this.crewsPublic(),
      events: this.events.slice(-40),
      leaderboard: this.leaderboard(),
      counties: countyList().map((c) => ({ name: c.name, code: c.code, district: c.district, center: c.center }))
    };
  }

  deltaState() {
    const jobs = [...this.dirtyJobs]
      .map((id) => {
        const j = this.jobs.get(id);
        return j ? this.jobPublic(j) : { id, removed: true };
      });
    this.dirtyJobs.clear();
    return {
      jobs,
      players: this.playersPublic(),
      crews: this.crewsPublic(),
      events: this.events.slice(-12),
      leaderboard: this.leaderboard(),
      stats: this.stats()
    };
  }

  playersPublic() {
    return [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, county: p.county, district: p.district,
      level: p.level, xp: p.xp, dayXp: p.dayXp, funds: p.funds,
      jobsDone: p.jobsDone, crewsOut: p.crews.length, maxCrews: p.maxCrews, online: p.online
    }));
  }

  crewsPublic() {
    const out = [];
    for (const p of this.players.values()) {
      for (const c of p.crews) {
        out.push({
          id: c.id, playerId: p.id, playerName: p.name, jobId: c.jobId, phase: c.phase,
          pct: c.phase === 'travel' ? 1 - c.travelLeft / c.travelTotal : 1,
          from: c.from, to: c.to
        });
      }
    }
    return out;
  }

  leaderboard() {
    return [...this.players.values()]
      .map((p) => ({ id: p.id, name: p.name, county: p.county, dayXp: p.dayXp, xp: p.xp, level: p.level, jobsDone: p.jobsDone }))
      .sort((a, b) => b.dayXp - a.dayXp || b.xp - a.xp)
      .slice(0, 15);
  }

  stats() {
    let done = 0, open = 0, incidents = 0;
    const byDistrict = {};
    for (const j of this.jobs.values()) {
      const d = (byDistrict[j.district] ||= { total: 0, done: 0 });
      d.total++;
      if (j.done) { done++; d.done++; } else { open++; }
      if (j.incident && !j.done) incidents++;
    }
    return { done, open, incidents, total: this.jobs.size, byDistrict };
  }

  // ------------------------------------------------------------------ pub/sub

  onUpdate(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(); }
}

export function levelFor(xp) {
  return Math.max(1, Math.floor(Math.sqrt(Math.max(0, xp) / 40)) + 1);
}
export function xpForLevel(level) {
  return Math.round(40 * (level - 1) ** 2);
}

function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
