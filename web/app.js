/* Roadworks — static client. Supabase is the only backend.
 *
 * There is no game server and no tick. Postgres stores each job's banked
 * progress plus the instant it was banked; between Realtime events this file
 * re-derives the current value from crew arrival times, boosts and contractor
 * shifts, exactly the way settle_job() does. When the local math says a job is
 * finished it asks Postgres to settle, and Postgres recomputes it itself.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const CFG = window.ROADWORKS_CONFIG || {};

  if (!CFG.SUPABASE_URL || CFG.SUPABASE_URL.includes('YOUR-PROJECT-REF')) {
    $('bootStatus').innerHTML =
      'Not configured yet — copy your Supabase project URL and <b>anon</b> key into <code>config.js</code>.';
    return;
  }

  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
    realtime: { params: { eventsPerSecond: 20 } }
  });

  const CATEGORY = {
    'Maintenance':           '#4cc9f0',
    'Bridge':                '#f7b32b',
    'Heavy Maintenance':     '#b892ff',
    'Closures':              '#ff5d5d',
    'Construction Projects': '#ff8a3d',
    'Utilities/Oil & Gas':   '#7cf29b',
    'Winter Ops':            '#a8e6ff',
    'Incident':              '#ff2e63'
  };

  const BASE_RATE = 0.5;          // must match base_crew_rate() in the schema
  const OSRM = 'https://router.project-osrm.org/route/v1/driving';

  const state = {
    reportDate: null,
    jobs: new Map(),
    stateById: new Map(),
    crews: new Map(),
    players: new Map(),
    counties: [],
    facilities: [],
    ranks: [],
    catalog: [],
    owned: new Set(),
    reportCards: [],
    storms: [],
    today: null,          // player_day row
    focus: null,
    awards: [],
    me: null,
    selected: null,
    skewMs: 0,
    settling: new Set(),
    seenFeed: new Set(),
    hydrated: false,      // suppresses toasts while the backlog is replayed
    cardSig: null,
    crewSig: null,
    stacks: new Map(),    // jobId -> {i, n} position within a shared-geometry group
    zoomKey: 0,
    busy: false
  };

  const layers = { jobs: new Map(), crews: new Map(), routes: new Map(),
                   facilities: null, storms: null };
  const serverNow = () => Date.now() + state.skewMs;

  // -------------------------------------------------------------------- map
  const map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([38.85, -80.4], 8);
  L.tileLayer('https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap, &copy; CARTO | roads: public state GIS | driving: OSRM'
  }).addTo(map);

  // County storm tints belong under the work orders and garages. A dedicated
  // pane below overlayPane (400) does that by z-index, rather than depending on
  // insertion order or restacking layers after every redraw.
  map.createPane('storms').style.zIndex = 350;

  // Stacked segments are spaced in screen terms, so their geometry has to be
  // recomputed when the scale changes. Only the ~160 shared lines move.
  map.on('zoomend', () => {
    state.zoomKey = map.getZoom();
    for (const j of state.jobs.values()) {
      if ((state.stacks.get(j.id)?.n || 1) > 1) upsertJobLayer(j);
    }
  });

  // ------------------------------------------------------------ progress math
  const multiplier = (n) => (n <= 0 ? 0 : Math.min(3.0, 1 + 0.12 * (n - 1)));

  /** Mirror of settle_job(): integrate span by span between rate-change events. */
  function liveProgress(jobId) {
    const job = state.jobs.get(jobId);
    const st = state.stateById.get(jobId);
    if (!job || !st) return { progress: 0, working: 0, done: false };
    if (st.done) return { progress: Number(job.effort), working: 0, done: true };

    // A crew heading back to its garage is still on the roster but off the job.
    const crews = [...state.crews.values()]
      .filter((c) => c.job_id === jobId && !c.return_at);
    const now = serverNow();
    let progress = Number(st.progress);
    let cursor = Date.parse(st.progress_at);

    const events = [];
    for (const c of crews) {
      for (const t of [Date.parse(c.arrives_at),
                       c.boost_until ? Date.parse(c.boost_until) : NaN,
                       c.contractor_until ? Date.parse(c.contractor_until) : NaN]) {
        if (Number.isFinite(t) && t > cursor && t <= now) events.push(t);
      }
    }
    events.push(now);
    events.sort((a, b) => a - b);

    const effort = Number(job.effort);
    for (const mark of events) {
      const active = crews.filter((c) =>
        Date.parse(c.arrives_at) <= cursor &&
        (!c.contractor_until || Date.parse(c.contractor_until) > cursor));
      const dt = (mark - cursor) / 1000;
      // An emergency callout produces nothing below its crew threshold; the
      // local integral has to agree with settle_job() or the client will show
      // phantom progress and ask Postgres to close a job that hasn't started.
      if (active.length >= (job.min_crews || 1) && active.length && dt > 0) {
        const sum = active.reduce((s, c) =>
          s + Number(c.rate || BASE_RATE) *
              (c.boost_until && Date.parse(c.boost_until) > cursor ? 2 : 1), 0);
        progress = Math.min(effort, progress + sum * multiplier(active.length) * dt);
        if (progress >= effort) break;
      }
      cursor = mark;
    }
    const working = crews.filter((c) =>
      Date.parse(c.arrives_at) <= now &&
      (!c.contractor_until || Date.parse(c.contractor_until) > now)).length;
    return { progress, working, done: progress >= effort };
  }

  function etaSeconds(jobId) {
    const job = state.jobs.get(jobId);
    const { progress, working } = liveProgress(jobId);
    if (!job || !working || working < (job.min_crews || 1)) return 0;
    const now = serverNow();
    const sum = [...state.crews.values()]
      .filter((c) => c.job_id === jobId && !c.return_at && Date.parse(c.arrives_at) <= now &&
                     (!c.contractor_until || Date.parse(c.contractor_until) > now))
      .reduce((s, c) => s + Number(c.rate || BASE_RATE) *
                            (c.boost_until && Date.parse(c.boost_until) > now ? 2 : 1), 0);
    const rate = sum * multiplier(working);
    return rate > 0 ? Math.ceil((Number(job.effort) - progress) / rate) : 0;
  }

  async function maybeSettle(jobId) {
    if (state.settling.has(jobId)) return;
    state.settling.add(jobId);
    try {
      const { data, error } = await sb.rpc('settle_job', { p_job: jobId });
      if (!error && data) applyJobState(Array.isArray(data) ? data[0] : data);
    } finally {
      setTimeout(() => state.settling.delete(jobId), 3000);
    }
  }

  // ------------------------------------------------------------------- ranks
  const rankOf = (xp) => {
    let r = state.ranks[0];
    for (const x of state.ranks) if (xp >= x.xp_required) r = x;
    return r || { idx: 1, name: 'Flagger', xp_required: 0, crews: 3 };
  };
  const nextRank = (xp) => state.ranks.find((r) => r.xp_required > xp) || null;
  const myRankIdx = () => (state.me ? rankOf(state.me.xp).idx : 1);
  /**
   * A crew whose return time has already passed is home, whether or not the
   * delete has reached us yet. Filtering here stops one lingering at "0s" and
   * stops it holding a slot the server has already freed.
   */
  const crewIsHome = (c) => !!c.return_at && Date.parse(c.return_at) <= serverNow();

  const myCrews = () => [...state.crews.values()]
    .filter((c) => c.player_id === state.me?.id && !c.contractor_until && !crewIsHome(c));
  const maxCrews = () => {
    if (!state.me) return 3;
    const extra = state.catalog
      .filter((e) => e.effect === 'crew_slot' && state.owned.has(e.key)).length;
    return Math.min(12, rankOf(state.me.xp).crews + extra);
  };

  // ------------------------------------------------------------------- boot
  async function boot() {
    setBoot('Signing in…');
    let { data: { session } } = await sb.auth.getSession();

    // A stored session can outlive the account it points at — an anonymous user
    // removed server-side leaves the browser holding a token for somebody who
    // no longer exists, and every write then fails on the foreign key from
    // players to auth.users. Validate against the auth server before trusting
    // the cached session, and start over cleanly if it is stale.
    if (session) {
      const { error: userErr } = await sb.auth.getUser();
      if (userErr) {
        await sb.auth.signOut().catch(() => {});
        session = null;
      }
    }

    if (!session) {
      const { error } = await sb.auth.signInAnonymously();
      if (error) {
        setBoot(`Sign-in failed: ${error.message}. Enable anonymous sign-ins in Supabase → Authentication → Providers.`);
        return;
      }
      ({ data: { session } } = await sb.auth.getSession());
    }

    setBoot('Loading today\'s board…');
    const t0 = Date.now();
    const { data: srv } = await sb.rpc('server_now');
    if (srv) state.skewMs = Date.parse(srv) - (Date.now() - (Date.now() - t0) / 2);

    const { data: day } = await sb.from('game_day')
      .select('*').order('report_date', { ascending: false }).limit(1).maybeSingle();
    if (!day) {
      setBoot('No road report has been ingested yet. Run the ingest job (Actions → “Ingest daily road report”).');
      return;
    }
    state.reportDate = day.report_date;

    // Tables added by a later schema version are fetched defensively so a site
    // deploy that lands before the SQL is applied degrades instead of dying.
    const opt = (q) => q.then((r) => r.data || []).catch(() => []);

    const [counties, jobs, states, crews, feed, facs, ranks, cat, cards] = await Promise.all([
      opt(sb.from('wv_counties').select('*').order('name')),
      fetchAllJobs(day.report_date),
      opt(sb.from('job_state').select('*')),
      opt(sb.from('crews').select('*')),
      opt(sb.from('feed').select('*').order('created_at', { ascending: false }).limit(40)),
      opt(sb.from('facilities').select('*').eq('dispatchable', true)),
      opt(sb.from('ranks').select('*').order('idx')),
      opt(sb.from('equipment_catalog').select('*').order('sort')),
      opt(sb.from('day_report_cards').select('*').order('report_date', { ascending: false }).limit(10))
    ]);

    state.storms = await opt(sb.from('storm_counties').select('*'));

    state.counties = counties;
    state.facilities = facs;
    state.ranks = ranks.length ? ranks : [{ idx: 1, name: 'Flagger', xp_required: 0, crews: 3 }];
    state.catalog = cat;
    state.reportCards = cards;
    for (const j of jobs) state.jobs.set(j.id, j);
    for (const s of states || []) state.stateById.set(s.job_id, s);
    for (const c of crews || []) state.crews.set(c.id, c);
    // Replaying the backlog must not fire forty toasts at once. The ticker
    // still fills in; only the pop-ups are held back until the board is up.
    feed.reverse().forEach(pushFeed);
    state.hydrated = true;

    // Decoration must never be able to stop the game from starting. A single
    // bad draw call used to take the whole board down with it.
    for (const step of [
      indexStacks,
      () => { for (const j of state.jobs.values()) upsertJobLayer(j); },
      drawFacilities, drawStorms, buildLegend, fillCountySelect, fillFilters
    ]) {
      try { step(); } catch (err) { console.error(`startup step failed: ${err.message}`, err); }
    }

    subscribe();
    await refreshPlayers();

    const existing = await loadMe();
    if (existing) {
      $('boot').hidden = true;
      if (existing.home) map.setView([existing.home[1], existing.home[0]], 9);
      await standup();
    } else {
      $('joinForm').hidden = false;
      setBoot(`${state.jobs.size} work orders on the board.`);
    }
    renderAll();

    setInterval(animate, 250);
    setInterval(refreshPlayers, 10000);
    setInterval(resyncBoard, 15000);
    setInterval(refreshStorms, 120000);
    setInterval(() => state.me && sb.rpc('heartbeat'), 45000);
  }

  async function fetchAllJobs(reportDate) {
    const out = [];
    const PAGE = 500;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb.from('jobs').select('*')
        .eq('report_date', reportDate).range(from, from + PAGE - 1);
      if (error) throw error;
      out.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }
    return out;
  }

  async function loadMe() {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return null;
    const [{ data }, eq] = await Promise.all([
      sb.from('players').select('*').eq('id', user.id).maybeSingle(),
      sb.from('player_equipment').select('item_key').eq('player_id', user.id)
        .then((r) => r.data || []).catch(() => [])
    ]);
    state.owned = new Set(eq.map((e) => e.item_key));
    if (data) {
      state.me = data;
      state.today = await sb.from('player_day').select('*')
        .eq('player_id', user.id).eq('report_date', state.reportDate).maybeSingle()
        .then((r) => r.data).catch(() => null);
      state.awards = await sb.from('commendations').select('*')
        .eq('player_id', user.id).order('earned_at', { ascending: false }).limit(30)
        .then((r) => r.data || []).catch(() => []);
      renderMe();
    }
    return data;
  }

  /** Morning standup: books the streak and the stipend, once per report day. */
  async function standup() {
    const { data, error } = await sb.rpc('daily_checkin');
    if (error || !data) return;
    state.focus = data.focus;
    renderFocus();
    if (data.new) {
      toast(`Reported for duty — day ${data.streak} of your run. +$${data.stipend} stipend.`, 'good');
    }
    await loadMe();
    renderAll();
  }

  function renderFocus() {
    const el = $('focusChip');
    if (!state.focus) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `<b>Focus this week</b> ${esc(state.focus)} <span>+50% XP</span>`;
    el.style.borderColor = CATEGORY[state.focus] || 'var(--line)';
  }

  // --------------------------------------------------------------- realtime
  function subscribe() {
    sb.channel('roadworks')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'job_state' },
        (p) => { if (p.new?.job_id) applyJobState(p.new); })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'jobs' },
        (p) => { state.jobs.set(p.new.id, p.new); indexStacks(); renderAll(); })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'jobs' },
        (p) => removeJob(p.old?.id))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'crews' },
        (p) => {
          if (p.eventType === 'DELETE') { if (p.old?.id) { state.crews.delete(p.old.id); dropRoute(p.old.id); } }
          else state.crews.set(p.new.id, p.new);
          renderAll();
        })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'feed' },
        (p) => { pushFeed(p.new); })
      .subscribe((status) => {
        const el = $('linkState');
        const live = status === 'SUBSCRIBED';
        el.style.color = live ? 'var(--good)' : 'var(--bad)';
        el.title = live ? 'Live' : `Realtime: ${status}`;
      });
  }

  function applyJobState(s) {
    const prev = state.stateById.get(s.job_id);
    state.stateById.set(s.job_id, s);
    if (s.done && !prev?.done) {
      // Only contractors actually disappear at completion; everyone else is
      // driving home and must stay on the map until the server says otherwise.
      for (const [id, c] of state.crews) {
        if (c.job_id === s.job_id && c.contractor_until) { state.crews.delete(id); dropRoute(id); }
      }
      if (state.me) loadMe();
      // Their return legs are set in the same transaction that closed the job;
      // fetch them now rather than waiting on the periodic resync.
      sb.from('crews').select('*').eq('job_id', s.job_id)
        .then(({ data }) => {
          for (const c of data || []) state.crews.set(c.id, c);
          renderAll();
        })
        .catch(() => {});
    }
    renderAll();
  }

  function removeJob(id) {
    if (!id) return;
    state.jobs.delete(id);
    indexStacks();
    state.stateById.delete(id);
    for (const [cid, c] of state.crews) if (c.job_id === id) { state.crews.delete(cid); dropRoute(cid); }
    const l = layers.jobs.get(id);
    if (l) { map.removeLayer(l); layers.jobs.delete(id); }
    if (state.selected === id) closeJob();
    renderAll();
  }

  /**
   * Pull the whole board state back down periodically.
   *
   * Realtime is the fast path, not a guarantee - a dropped or throttled
   * postgres_changes message used to leave a finished job showing its category
   * colour indefinitely, because nothing ever revisited it. This is the cheap
   * safety net: one small query, and any drift heals within 30 seconds.
   */
  async function resyncBoard() {
    const [rows, crewRows] = await Promise.all([
      sb.from('job_state').select('*').then((r) => r.data || []).catch(() => []),
      sb.from('crews').select('*').then((r) => r.data || []).catch(() => null)
    ]);

    let changed = 0;
    for (const s2 of rows) {
      const prev = state.stateById.get(s2.job_id);
      if (!prev || prev.done !== s2.done || prev.crew_count !== s2.crew_count ||
          prev.progress !== s2.progress) {
        state.stateById.set(s2.job_id, s2);
        changed++;
      }
    }

    // Crews get replaced wholesale rather than merged. A missed UPDATE used to
    // strand a crew reading "working 100%" - the job had closed and the truck
    // was already driving home, but this client never saw return_at get set.
    // A missed DELETE left one parked at "returning - 0s" forever. Taking the
    // server's list as the truth fixes both, and drops anything already reaped.
    if (crewRows) {
      const next = new Map(crewRows.map((c) => [c.id, c]));
      let crewChanged = next.size !== state.crews.size;
      if (!crewChanged) {
        for (const [id, c] of next) {
          const prev = state.crews.get(id);
          if (!prev || prev.return_at !== c.return_at || prev.arrives_at !== c.arrives_at ||
              prev.boost_until !== c.boost_until) { crewChanged = true; break; }
        }
      }
      if (crewChanged) {
        for (const id of state.crews.keys()) if (!next.has(id)) dropRoute(id);
        state.crews = next;
        changed++;
      }
    }

    if (changed) {
      for (const j of state.jobs.values()) upsertJobLayer(j);
      renderAll();
    }
  }

  async function refreshPlayers() {
    const { data } = await sb.from('players')
      .select('id,name,county,district,level,xp,day_xp,jobs_done,last_seen');
    if (!data) return;
    state.players = new Map(data.map((p) => [p.id, p]));
    if (state.me) {
      const mine = state.players.get(state.me.id);
      if (mine) { Object.assign(state.me, mine); renderMe(); }
    }
    renderHeader();
    renderLeaderboard();
  }

  // ------------------------------------------------------------------ actions
  async function call(fn, args, okMsg) {
    let { data, error } = await sb.rpc(fn, args);

    // Belt and braces for the same stale-identity case boot() guards against:
    // if the signed-in user has been removed, re-establish an identity once and
    // retry rather than showing a raw foreign-key error.
    if (error && /players_id_fkey|foreign key|violates/i.test(error.message)) {
      await sb.auth.signOut().catch(() => {});
      const { error: authErr } = await sb.auth.signInAnonymously();
      if (!authErr) ({ data, error } = await sb.rpc(fn, args));
    }

    if (error) { toast(error.message.replace(/^.*?:\s*/, ''), 'warn'); return null; }
    if (okMsg) toast(okMsg, 'good');
    return data;
  }

  $('joinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    const r = await call('ensure_player', {
      p_name: $('nameInput').value.trim() || 'Manager',
      p_county: $('countySelect').value
    });
    btn.disabled = false;
    if (!r) return;
    state.me = Array.isArray(r) ? r[0] : r;
    localStorage.setItem('roadworks.name', state.me.name);
    localStorage.setItem('roadworks.county', state.me.county);
    $('boot').hidden = true;
    if (state.me.home) map.setView([state.me.home[1], state.me.home[0]], 9);
    await standup();
    renderAll();
  });

  /** Nearest dispatchable facility in the job's district — same rule the server uses. */
  function nearestFacility(job) {
    const d = job.district;
    let best = null;
    for (const f of state.facilities) {
      if (f.district !== d) continue;
      const s = (f.lat - job.centroid[1]) ** 2 + ((f.lng - job.centroid[0]) * 0.78) ** 2;
      if (!best || s < best.s) best = { f, s };
    }
    return best?.f || null;
  }

  /** Real driving route from the garage to the job, cached in Postgres. */
  async function getRoute(fac, job) {
    const hit = await sb.from('route_cache').select('coords,drive_secs')
      .eq('facility_id', fac.id).eq('job_id', job.id).maybeSingle()
      .then((r) => r.data).catch(() => null);
    if (hit) return { coords: hit.coords, secs: Number(hit.drive_secs), cached: true };
    try {
      const url = `${OSRM}/${fac.lng},${fac.lat};${job.centroid[0]},${job.centroid[1]}` +
                  '?overview=simplified&geometries=geojson';
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      const d = await res.json();
      if (d.code !== 'Ok' || !d.routes?.length) return null;
      const r = d.routes[0];
      let coords = r.geometry.coordinates.map((c) => [round5(c[0]), round5(c[1])]);
      if (coords.length > 400) {
        const step = (coords.length - 1) / 399;
        coords = Array.from({ length: 400 }, (_, i) => coords[Math.round(i * step)]);
      }
      return { coords, secs: r.duration, cached: false };
    } catch {
      return null;   // OSRM unreachable — the server falls back to a straight line
    }
  }

  async function dispatch(jobId) {
    if (state.busy) return;
    const job = state.jobs.get(jobId);
    if (!job) return;
    state.busy = true;
    // Routing can take a moment; say so rather than looking dead.
    const btn = document.querySelector(`[data-dispatch="${cssEsc(jobId)}"]`);
    if (btn) btn.textContent = 'Dispatching…';
    try {
      const fac = nearestFacility(job);
      let route = null;
      if (fac) route = await getRoute(fac, job);
      const s = await call('dispatch_crew', {
        p_job: jobId,
        p_facility: fac ? fac.id : null,
        p_route: route ? route.coords : null,
        p_secs: route ? route.secs : null
      });
      if (s) applyJobState(Array.isArray(s) ? s[0] : s);
      const { data } = await sb.from('crews').select('*').eq('job_id', jobId);
      for (const c of data || []) state.crews.set(c.id, c);
      renderAll();
    } finally {
      state.busy = false;
      // Whatever happened, the card must not be left with a dead button.
      state.cardSig = null;
      tickJobCard();
    }
  }

  async function recall(jobId) {
    const s = await call('recall_crew', { p_job: jobId });
    if (s) applyJobState(Array.isArray(s) ? s[0] : s);
    for (const [id, c] of state.crews) {
      if (c.job_id === jobId && c.player_id === state.me?.id && !c.contractor_until) {
        state.crews.delete(id); dropRoute(id);
      }
    }
    renderAll();
  }

  async function radioPing(jobId) {
    await call('radio_ping', { p_job: jobId }, 'Backup requested on the radio.');
  }

  async function overtime(fn, jobId, label) {
    const s = await call(fn, { p_job: jobId }, label);
    if (s) applyJobState(Array.isArray(s) ? s[0] : s);
    const { data } = await sb.from('crews').select('*').eq('job_id', jobId);
    for (const [id, c] of state.crews) if (c.job_id === jobId) state.crews.delete(id);
    for (const c of data || []) state.crews.set(c.id, c);
    await loadMe();
    renderAll();
  }

  // ------------------------------------------------------------- map layers
  /**
   * Whether a job should read as closed *anywhere* in the UI.
   *
   * The server row is authoritative, but a job whose local integral has already
   * reached its effort is finished in every way that matters to the player -
   * they are just waiting on a settle round trip. Deriving both the map colour
   * and the card from this one predicate is what keeps them from disagreeing,
   * which is exactly what happened when the map read st.done and the card was
   * computing progress itself.
   */
  function jobDone(j) {
    const st = state.stateById.get(j.id);
    if (st?.done) return true;
    if (!st || !j) return false;
    // With nobody on site the banked figure is the whole story, and this runs
    // for every segment on the board on each pass - keep the common case cheap.
    if (!st.crew_count) return Number(st.progress) >= Number(j.effort);
    return liveProgress(j.id).progress >= Number(j.effort);
  }

  const jobColor = (j) => (jobDone(j) ? '#2f9e5f' : (CATEGORY[j.category] || '#8b98a8'));

  /**
   * A day's board files several activities against the same route and milepoints - a
   * litter pickup, a mowing run and a sweep over the identical stretch of US 50
   * are three separate work orders sharing one line. Drawn as-is they stack
   * exactly on top of each other, so closing one changes nothing you can see:
   * the open one above it keeps its colour. Today 163 of 634 jobs sit on a
   * shared line, the deepest stack being 11.
   *
   * Group them so each can be nudged onto its own parallel ribbon.
   */
  function indexStacks() {
    const groups = new Map();
    for (const j of state.jobs.values()) {
      if (!Array.isArray(j.coords) || j.coords.length < 2) continue;
      const a = j.coords[0];
      const b = j.coords[j.coords.length - 1];
      const key = `${j.coords.length}|${a[0]},${a[1]}|${b[0]},${b[1]}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(j.id);
    }
    state.stacks = new Map();
    for (const ids of groups.values()) {
      // Sorted so every player sees the same order on the same road.
      ids.sort();
      ids.forEach((id, i) => state.stacks.set(id, { i, n: ids.length }));
    }
  }

  /**
   * Gap between stacked ribbons, in degrees, sized so it stays about 5px on
   * screen at whatever zoom the map is at. A fixed ground distance either
   * vanishes when zoomed out or drifts visibly off the roadway when zoomed in.
   */
  function stackSpacing() {
    const lat = map.getCenter().lat;
    const metresPerPixel = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** map.getZoom();
    return Math.max(0.00004, Math.min(0.0009, (5 * metresPerPixel) / 111320));
  }

  /** Shift a path sideways by `d` degrees, perpendicular to its own direction. */
  function offsetPath(coords, d) {
    if (!d) return coords;
    const out = [];
    for (let i = 0; i < coords.length; i++) {
      const p = coords[i];
      const prev = coords[i - 1] || p;
      const next = coords[i + 1] || p;
      // Longitude degrees are shorter than latitude degrees this far north, so
      // work in a locally-square space before rotating, then convert back.
      const k = Math.cos((p[1] * Math.PI) / 180) || 1;
      let dx = (next[0] - prev[0]) * k;
      let dy = next[1] - prev[1];
      const len = Math.hypot(dx, dy);
      if (!len) { out.push(p); continue; }
      dx /= len; dy /= len;
      out.push([p[0] + (-dy * d) / k, p[1] + dx * d]);
    }
    return out;
  }

  function upsertJobLayer(j) {
    if (!Array.isArray(j.coords) || j.coords.length < 2) return;
    const st = state.stateById.get(j.id);
    const busy = (st?.crew_count || 0) > 0;
    const mine = state.me && j.district === state.me.district;
    const done = jobDone(j);
    const stack = state.stacks.get(j.id) || { i: 0, n: 1 };
    const style = {
      color: jobColor(j),
      weight: j.min_crews > 1 ? 9 : j.incident ? 7 : busy ? 6 : 4,
      opacity: done ? 0.3 : (state.me && !mine && !j.incident) ? 0.32 : 0.92,
      dashArray: j.approx ? '5,6' : null
    };
    // Restyling and re-binding a tooltip on every pass over 600 polylines is
    // wasted work; only touch a layer when something it displays has changed.
    const key = `${style.color}|${style.weight}|${style.opacity}|${st?.crew_count || 0}` +
                `|${stack.i}/${stack.n}|${state.zoomKey}`;
    const shift = stack.n > 1 ? (stack.i - (stack.n - 1) / 2) * stackSpacing() : 0;
    let line = layers.jobs.get(j.id);
    if (!line) {
      line = L.polyline(offsetPath(j.coords, shift).map((c) => [c[1], c[0]]), style).addTo(map);
      line.on('click', () => openJob(j.id));
      layers.jobs.set(j.id, line);
    } else {
      if (line._styleKey === key) return;
      if (line._stackKey !== `${stack.i}/${stack.n}|${state.zoomKey}`) {
        line.setLatLngs(offsetPath(j.coords, shift).map((c) => [c[1], c[0]]));
      }
      line.setStyle(style);
    }
    line._stackKey = `${stack.i}/${stack.n}|${state.zoomKey}`;
    line._styleKey = key;
    line.unbindTooltip();
    line.bindTooltip(
      `<b>${esc(j.activity)}</b><br>${esc(j.route_label)} ${esc(j.route_name || '')}<br>` +
      `${esc(j.county)} Co. · D${j.district}${busy ? ` · ${plural(st.crew_count, 'crew', 'crews')}` : ''}` +
      `${done ? '<br><b>closed today</b>' : ''}` +
      `${stack.n > 1 ? `<br><i>order ${stack.i + 1} of ${stack.n} on this stretch</i>` : ''}` +
      `${j.min_crews > 1 ? `<br><b>⛑ CALLOUT — needs ${j.min_crews} crews</b>` : ''}` +
      `${j.storm ? '<br>⚠ storm conditions — double XP' : ''}` +
      `${j.milestone ? '<br>🏁 milestone route — segment bonuses' : ''}` +
      `${state.me && !mine && !j.incident ? '<br><i>outside your district</i>' : ''}`,
      { sticky: true }
    );
  }

  // Every highway facility draws the same for now: a garage is a garage, and
  // ranking them by size or colour implied a hierarchy the game does not use.
  const FAC_COLOR = '#8fa6bd';
  const FAC_RADIUS = 3.5;

  const FAC_LABEL = {
    district_hq: 'District headquarters',
    county_hq: 'County headquarters',
    substation: 'Substation',
    section: 'Section garage',
    shop: 'Equipment shop'
  };

  function drawFacilities() {
    if (layers.facilities) map.removeLayer(layers.facilities);
    const g = L.layerGroup();
    for (const f of state.facilities) {
      L.circleMarker([f.lat, f.lng], {
        radius: FAC_RADIUS, color: FAC_COLOR, weight: 1, fillColor: FAC_COLOR,
        fillOpacity: 0.55, interactive: true
      }).bindTooltip(
        `<b>${esc(f.name)}</b><br>${esc(FAC_LABEL[f.kind] || 'Facility')}` +
        `<br>${esc(f.county || '')} · D${f.district}`, { sticky: true })
        .addTo(g);
    }
    layers.facilities = g.addTo(map);
  }

  // ------------------------------------------------------------------ storms
  const STORM_STYLE = {
    winter: { color: '#a8e6ff', label: '❄ Winter' },
    flood:  { color: '#4cc9f0', label: '🌊 Flood' },
    wind:   { color: '#b892ff', label: '💨 Wind' },
    storm:  { color: '#ff8a3d', label: '⛈ Storm' },
    other:  { color: '#8b98a8', label: '⚠ Alert' }
  };

  async function refreshStorms() {
    const next = await sb.from('storm_counties').select('*')
      .then((r) => r.data || []).catch(() => []);
    const before = state.storms.map((s2) => `${s2.code}${s2.level}`).sort().join();
    state.storms = next;
    if (before !== next.map((s2) => `${s2.code}${s2.level}`).sort().join()) {
      drawStorms();
      renderStormBar();
    }
  }

  function stormFor(countyCode) {
    return state.storms.find((s2) => s2.code === countyCode) || null;
  }

  function drawStorms() {
    if (layers.storms) map.removeLayer(layers.storms);
    if (!state.storms.length) { layers.storms = null; renderStormBar(); return; }
    const g = L.layerGroup();
    for (const st of state.storms) {
      const county = state.counties.find((c) => c.code === st.code);
      if (!county?.geom) continue;
      const sty = STORM_STYLE[st.kind] || STORM_STYLE.other;
      L.polygon(county.geom.map((pt) => [pt[1], pt[0]]), {
        pane: 'storms',
        color: sty.color,
        weight: st.level >= 2 ? 2 : 1,
        opacity: st.level >= 2 ? 0.85 : 0.4,
        fillColor: sty.color,
        fillOpacity: st.level >= 2 ? 0.13 : 0.05,
        interactive: false,
        className: st.level >= 2 ? 'storm-warning' : ''
      }).addTo(g);
    }
    layers.storms = g.addTo(map);
    renderStormBar();
  }

  function renderStormBar() {
    const bar = $('stormBar');
    const warn = state.storms.filter((s2) => s2.level >= 2);
    const watch = state.storms.filter((s2) => s2.level === 1);
    if (!state.storms.length) { bar.hidden = true; return; }
    bar.hidden = false;
    const kinds = [...new Set(state.storms.map((s2) => s2.kind))]
      .map((k) => (STORM_STYLE[k] || STORM_STYLE.other).label);
    const mine = state.me
      ? state.storms.filter((s2) => s2.district === state.me.district).length : 0;
    bar.innerHTML =
      `<span class="storm-kinds">${kinds.map(esc).join(' ')}</span>` +
      `<span>${plural(warn.length, 'county', 'counties')} under WARNING` +
      `${watch.length ? `, ${watch.length} under watch` : ''}</span>` +
      (mine ? `<span class="storm-mine">${mine} in your district — incidents pay double</span>` : '');
    bar.title = state.storms
      .sort((x, y) => y.level - x.level)
      .map((s2) => `${s2.name} (${s2.level >= 2 ? 'warning' : 'watch'})`).join(', ');
  }

  function dropRoute(crewId) {
    const r = layers.routes.get(crewId);
    if (r) { map.removeLayer(r); layers.routes.delete(crewId); }
  }

  /** Point along a polyline at fraction t of its total length. */
  function pointAlong(coords, t) {
    if (!coords || coords.length < 2) return null;
    const segs = [];
    let total = 0;
    for (let i = 1; i < coords.length; i++) {
      const dx = (coords[i][0] - coords[i - 1][0]) * 0.78;
      const dy = coords[i][1] - coords[i - 1][1];
      const d = Math.hypot(dx, dy);
      segs.push(d); total += d;
    }
    if (total === 0) return coords[0];
    let want = Math.max(0, Math.min(1, t)) * total;
    for (let i = 0; i < segs.length; i++) {
      if (want <= segs[i] || i === segs.length - 1) {
        const f = segs[i] ? want / segs[i] : 0;
        return [coords[i][0] + (coords[i + 1][0] - coords[i][0]) * f,
                coords[i][1] + (coords[i + 1][1] - coords[i][1]) * f];
      }
      want -= segs[i];
    }
    return coords[coords.length - 1];
  }

  function renderCrewMarkers() {
    const now = serverNow();
    const seen = new Set();
    for (const c of state.crews.values()) {
      const job = state.jobs.get(c.job_id);
      if (!job || !job.centroid || crewIsHome(c)) continue;
      seen.add(c.id);

      const homeward = !!c.return_at;
      const start = Date.parse(homeward ? c.return_from : c.dispatched_at);
      const end = Date.parse(homeward ? c.return_at : c.arrives_at);
      const raw = end > start ? Math.max(0, Math.min(1, (now - start) / (end - start))) : 1;
      // Heading home retraces the same road, so walk the route backwards.
      const t = homeward ? 1 - raw : raw;
      const route = Array.isArray(c.route) && c.route.length > 1 ? c.route : null;

      let pos;
      if (route) pos = pointAlong(route, t);
      else {
        const fac = state.facilities.find((f) => f.id === c.facility_id);
        const home = fac ? [Number(fac.lng), Number(fac.lat)] : job.centroid;
        pos = [home[0] + (job.centroid[0] - home[0]) * t,
               home[1] + (job.centroid[1] - home[1]) * t];
      }
      if (!pos) continue;

      const mineCrew = c.player_id === state.me?.id;
      const boosted = c.boost_until && Date.parse(c.boost_until) > now;
      const phase = homeward ? 'home' : t >= 1 ? 'work' : 'drive';

      // Heading, so a driving truck actually points down the road it is on.
      let heading = 0;
      if (phase !== 'work') {
        const step = homeward ? -0.02 : 0.02;
        const ahead = route
          ? pointAlong(route, Math.max(0, Math.min(1, t + step)))
          : (homeward ? null : job.centroid);
        if (ahead) {
          heading = Math.atan2(ahead[0] - pos[0], ahead[1] - pos[1]) * 180 / Math.PI;
        }
      }
      const html = crewMarkerHtml(phase, heading, mineCrew, !!c.contractor_until, boosted);

      // The road the crew is actually driving, shown while it drives.
      if (route && mineCrew && !homeward && t < 1) {
        let rl = layers.routes.get(c.id);
        if (!rl) {
          rl = L.polyline(route.map((p) => [p[1], p[0]]),
            { color: '#ffb703', weight: 2, opacity: 0.55, dashArray: '4,6' }).addTo(map);
          layers.routes.set(c.id, rl);
        }
      } else dropRoute(c.id);

      let mk = layers.crews.get(c.id);
      if (!mk) {
        mk = L.marker([pos[1], pos[0]], {
          icon: L.divIcon({ className: 'crew-pin-wrap', html, iconSize: [26, 26], iconAnchor: [13, 13] }),
          zIndexOffset: mineCrew ? 900 : 400,
          interactive: false
        }).addTo(map);
        layers.crews.set(c.id, mk);
        mk._html = html;
      } else {
        mk.setLatLng([pos[1], pos[0]]);
        // Rotation changes constantly; swapping the whole icon every frame is
        // wasteful, so nudge the transform and only re-render on a real change.
        const el = mk.getElement();
        const body = el && el.firstElementChild;
        if (body && mk._phase === phase) {
          body.style.setProperty('--rot', `${heading}deg`);
        } else if (mk._html !== html) {
          mk.setIcon(L.divIcon({ className: 'crew-pin-wrap', html, iconSize: [26, 26], iconAnchor: [13, 13] }));
          mk._html = html;
        }
      }
      mk._phase = phase;
    }
    for (const [id, mk] of layers.crews) {
      if (!seen.has(id)) { map.removeLayer(mk); layers.crews.delete(id); dropRoute(id); }
    }
  }

  /**
   * Crew marker. Inline SVG rather than an emoji: the pickup-truck emoji is
   * Emoji 13.0 and renders as a tofu box on Windows builds that ship an older
   * Segoe UI Emoji, which is exactly what it was doing.
   */
  function crewMarkerHtml(phase, heading, mine, contractor, boosted) {
    const fill = contractor ? '#b892ff' : mine ? '#ffb703' : '#4cc9f0';
    const cls = ['crew-pin', phase, mine ? 'mine' : '', boosted ? 'boosted' : ''].join(' ');

    if (phase === 'drive' || phase === 'home') {
      // Truck seen from above, nose up; the wrapper rotates it to the heading.
      return `<div class="${cls}" style="--rot:${heading}deg;--pin:${fill}">
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
          <circle cx="12" cy="12" r="11" class="halo"/>
          <path class="body" d="M12 2.6 15.2 7h-.9v3.1h2.3l1.1 5.4v4.2a1 1 0 0 1-1 1h-1.3v-1.6H8.6V20.7H7.3a1 1 0 0 1-1-1v-4.2l1.1-5.4h2.3V7h-.9z"/>
          <rect class="glass" x="9.6" y="11.4" width="4.8" height="2.6" rx=".6"/>
        </svg>
      </div>`;
    }

    // On site: a work zone, not a vehicle.
    return `<div class="${cls}" style="--pin:${fill}">
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
        <circle cx="12" cy="12" r="11" class="halo"/>
        <path class="body" d="M12 4.4 18.6 18H5.4z"/>
        <path class="stripe" d="M9.4 12.6h5.2l1 2H8.4zM10.6 9.2h2.8l.9 2h-4.6z"/>
      </svg>
    </div>`;
  }

  function buildLegend() {
    $('legend').innerHTML = Object.entries(CATEGORY)
      .map(([k, v]) => `<div><i style="background:${v}"></i>${esc(k)}</div>`)
      .join('') +
      '<div><i style="background:#2f9e5f"></i>Closed today</div>' +
      `<div><i style="background:${FAC_COLOR};border-radius:50%;height:7px;width:7px"></i>Highway garage</div>`;
  }

  // -------------------------------------------------------------- animation
  function animate() {
    renderCrewMarkers();
    let touched = false;
    for (const [id, st] of state.stateById) {
      if (st.done || !st.crew_count) continue;
      const { progress, done } = liveProgress(id);
      const job = state.jobs.get(id);
      const bar = document.querySelector(`#jobList [data-job="${cssEsc(id)}"] .pfill`);
      if (bar && job) bar.style.width = `${Math.min(100, (progress / Number(job.effort)) * 100)}%`;
      if (done) {
        maybeSettle(id);
        // Recolour the moment it finishes rather than waiting for the settle
        // round trip to come back. Without this the segment stayed its category
        // colour until some later event happened to trigger a full re-render.
        if (job) upsertJobLayer(job);
        touched = true;
      }
    }
    // These used to call the full renderers, which reassign innerHTML. At 4 Hz
    // that destroyed and recreated every button between a user's mousedown and
    // mouseup, so clicks landed on nothing — the dispatch button appeared to
    // need spam-clicking. Rebuild only when the controls actually change;
    // otherwise just update the numbers in place.
    tickMyCrews();
    tickJobCard();
    if (touched) renderHeader();
  }

  // ------------------------------------------------------------------ render
  function renderAll() {
    renderHeader();
    renderCrewMarkers();
    renderMyCrews();
    renderLeaderboard();
    renderJobList();
    for (const j of state.jobs.values()) upsertJobLayer(j);
    if (state.selected) renderJobCard();
  }

  function renderHeader() {
    $('dayDate').textContent = state.reportDate
      ? new Date(state.reportDate + 'T12:00:00').toLocaleDateString('en-US',
          { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
      : '—';
    const all = [...state.jobs.values()];
    const mineD = state.me
      ? all.filter((j) => j.district === state.me.district && !j.incident) : all;
    const done = mineD.filter((j) => state.stateById.get(j.id)?.done).length;
    const inc = all.filter((j) => j.incident && !state.stateById.get(j.id)?.done).length;
    const label = $('progressLabel');
    label.textContent = state.me
      ? `District ${state.me.district}: ${done} / ${mineD.length} closed`
      : `${done} / ${mineD.length} work orders closed`;
    const card = state.me && state.reportCards.find((c) => c.district === state.me.district);
    label.title = card
      ? `Yesterday (${card.report_date}): grade ${card.grade}, ` +
        `${card.jobs_done}/${card.jobs_total} closed, ` +
        `${card.incidents_cleared} incidents cleared, ${card.incidents_expired} missed` +
        (card.top_player ? ` — top: ${card.top_player}` : '')
      : 'Work orders closed in your district today';
    $('dayFill').style.width = mineD.length ? `${(done / mineD.length) * 100}%` : '0';
    const badge = $('incidentBadge');
    badge.hidden = !inc;
    badge.textContent = `⚠ ${plural(inc, 'active incident', 'active incidents')}`;
    const cutoff = serverNow() - 90_000;
    $('statOnline').textContent = [...state.players.values()]
      .filter((p) => Date.parse(p.last_seen) > cutoff).length;
    $('statCrews').textContent = state.crews.size;
    $('statOpen').textContent = mineD.length - done;
  }

  function renderMe() {
    const me = state.me;
    if (!me) return;
    const r = rankOf(me.xp);
    const nx = nextRank(me.xp);
    $('meAvatar').textContent = me.name.slice(0, 1).toUpperCase();
    $('meName').textContent = me.name;
    $('meRank').textContent = r.name;
    $('meSub').textContent = `${me.county} County · District ${me.district}`;
    const span = nx ? nx.xp_required - r.xp_required : 1;
    $('xpFill').style.width = nx
      ? `${Math.min(100, ((me.xp - r.xp_required) / span) * 100)}%` : '100%';
    $('xpText').textContent = nx ? `${me.xp} / ${nx.xp_required} XP` : `${me.xp} XP · max rank`;
    $('xpNext').textContent = nx ? `Next: ${nx.name}${nx.unlock ? ` — ${nx.unlock}` : ''}` : 'Commissioner of Highways';
    $('meFunds').textContent = `$${(me.funds || 0).toLocaleString()}`;
    $('meDone').textContent = me.jobs_done;
    $('meDayXp').textContent = me.day_xp;
    $('meStreak').textContent = me.streak ? `🔥 ${me.streak}` : '—';
    const stars = $('meStars');
    stars.textContent = `★ ${me.stars || 0}`;
    stars.title = state.awards.length
      ? ['Commendations:', ...state.awards.map((a) => `★ ${a.title}`)].join('\n')
      : 'Commendations earned';
    const home = state.today?.jobs_home || 0;
    const q = $('quota');
    q.classList.toggle('done', home >= 5);
    q.innerHTML = home >= 5
      ? `<b>★ County quota met</b> — 5 closed in ${esc(me.county)}`
      : `County quota <b>${home}/5</b> in ${esc(me.county)}` +
        `<span class="qbar"><span style="width:${(home / 5) * 100}%"></span></span>`;
    const homeward = myCrews().filter((c) => c.return_at).length;
    $('crewCount').textContent = `${myCrews().length}/${maxCrews()}`;
    $('crewCount').title = homeward
      ? `${plural(homeward, 'crew is', 'crews are')} returning to the garage`
      : 'Crews out of the garage';
    $('garageBtn').hidden = myRankIdx() < 4;
  }

  /** What the crew rows look like structurally; a change forces a rebuild. */
  function crewSignature() {
    const now = serverNow();
    return [...state.crews.values()]
      .filter((c) => c.player_id === state.me?.id && !crewIsHome(c))
      .map((c) => `${c.id}${c.return_at ? 'h' : Date.parse(c.arrives_at) <= now ? 'w' : 't'}` +
                  `${c.convoy ? 'c' : ''}` +
                  `${c.boost_until && Date.parse(c.boost_until) > now ? 'b' : ''}`)
      .join('|');
  }

  /** Refresh the live text on existing crew rows without touching the DOM shape. */
  function tickMyCrews() {
    if (!state.me) return;
    if (crewSignature() !== state.crewSig) return renderMyCrews();
    const now = serverNow();
    for (const c of state.crews.values()) {
      if (c.player_id !== state.me.id) continue;
      const el = document.querySelector(`#crewList [data-crew="${cssEsc(c.id)}"] .meta`);
      if (el) el.textContent = crewStatusText(c, now);
    }
    renderMe();
  }

  function crewStatusText(c, now) {
    const j = state.jobs.get(c.job_id);
    const fac = state.facilities.find((f) => f.id === c.facility_id);

    if (c.return_at) {
      const back = Math.max(0, Math.ceil((Date.parse(c.return_at) - now) / 1000));
      return `job done · returning to ${fac ? fac.name : 'the garage'} — ${back}s`;
    }

    // The job is closed but this crew's own row has not caught up yet. Say what
    // is actually happening rather than parking it at "working 100%".
    if (j && jobDone(j)) return `${j.route_label} · job done · heading back`;

    const eta = Math.ceil((Date.parse(c.arrives_at) - now) / 1000);
    const { progress } = liveProgress(c.job_id);
    const pct = j ? Math.round((progress / Number(j.effort)) * 100) : 0;
    const boosted = c.boost_until && Date.parse(c.boost_until) > now;
    const head = j ? `${j.route_label} · ` : '';
    return eta > 0
      ? `${head}${c.convoy ? 'convoy · ' : ''}en route ${eta}s${fac ? ` from ${fac.name}` : ''}`
      : `${head}${boosted ? '⚡ double shift · ' : ''}working ${pct}%`;
  }

  function renderMyCrews() {
    if (!state.me) return;
    renderMe();
    state.crewSig = crewSignature();
    const mine = [...state.crews.values()]
      .filter((c) => c.player_id === state.me.id && !crewIsHome(c));
    const list = $('crewList');
    if (!mine.length) {
      list.innerHTML = '<p class="empty">No crews dispatched. Pick a work order on the map or in the queue.</p>';
      return;
    }
    const now = serverNow();
    list.innerHTML = mine.map((c) => {
      const j = state.jobs.get(c.job_id);
      const arrived = Date.parse(c.arrives_at) <= now;
      const cls = c.return_at ? 'homeward' : arrived ? 'working' : 'travel';
      return `<div class="crew ${cls} ${c.contractor_until ? 'contractor' : ''}"
                   data-crew="${esc(c.id)}">
        <span class="dot"></span>
        <span class="who">
          <span class="act">${c.contractor_until ? '🚜 ' : ''}${esc(j ? j.activity : 'Unknown')}</span>
          <span class="meta">${esc(crewStatusText(c, now))}</span>
        </span>
        ${c.contractor_until || c.return_at
          ? '' : `<button title="Recall crew" data-recall="${esc(c.job_id)}">✕</button>`}
      </div>`;
    }).join('');
  }

  function renderLeaderboard() {
    const rows = [...state.players.values()]
      .sort((a, b) => (b.day_xp - a.day_xp) || (b.xp - a.xp))
      .slice(0, 15);
    $('leaderboard').innerHTML = rows.map((p, i) =>
      `<li class="${p.id === state.me?.id ? 'me' : ''}">
        <span class="rk">${i + 1}</span>
        <span class="nm">${esc(p.name)}<span style="color:var(--dim)"> · D${p.district ?? '?'}</span></span>
        <span class="sc">${p.day_xp}</span>
      </li>`).join('') || '<li class="empty">Nobody on shift yet.</li>';
  }

  function dispatchable(j) {
    return !!state.me && (j.incident || j.district === state.me.district);
  }

  function filteredJobs() {
    const q = $('search').value.trim().toLowerCase();
    const d = $('districtFilter').value;
    const cat = $('catFilter').value;
    const hideDone = $('hideDone').checked;
    const mineOnly = $('onlyMine').checked;
    const home = state.me?.home;
    return [...state.jobs.values()]
      .filter((j) => {
        if (hideDone && jobDone(j)) return false;
        if (d && String(j.district) !== d) return false;
        if (cat && j.category !== cat) return false;
        if (mineOnly && !dispatchable(j)) return false;
        if (q && !(`${j.activity} ${j.route_label} ${j.route_name} ${j.county} ${j.detail}`
          .toLowerCase().includes(q))) return false;
        return true;
      })
      .sort((a, b) => {
        const ad = jobDone(a), bd = jobDone(b);
        if (ad !== bd) return ad ? 1 : -1;
        if (a.incident !== b.incident) return a.incident ? -1 : 1;
        const da = dispatchable(a), db2 = dispatchable(b);
        if (da !== db2) return da ? -1 : 1;
        const ca = state.stateById.get(a.id)?.crew_count || 0;
        const cb = state.stateById.get(b.id)?.crew_count || 0;
        if (!!ca !== !!cb) return cb - ca;
        if (home) return dist(home, a.centroid) - dist(home, b.centroid);
        return a.effort - b.effort;
      })
      .slice(0, 260);
  }

  function renderJobList() {
    const mineIds = new Set([...state.crews.values()]
      .filter((c) => c.player_id === state.me?.id).map((c) => c.job_id));
    $('jobList').innerHTML = filteredJobs().map((j) => {
      const st = state.stateById.get(j.id);
      const { progress } = liveProgress(j.id);
      const pct = Math.min(100, (progress / Number(j.effort)) * 100);
      const away = state.me && !dispatchable(j);
      return `<div class="job ${jobDone(j) ? 'done' : ''} ${mineIds.has(j.id) ? 'mine' : ''} ${j.incident ? 'incident' : ''} ${away ? 'away' : ''} ${j.min_crews > 1 ? 'callout' : ''}"
                   style="border-left-color:${jobColor(j)}" data-job="${esc(j.id)}">
        <div class="t">${j.min_crews > 1 ? '⛑ ' : j.incident ? '⚠ ' : ''}${esc(j.activity)}${j.milestone ? ' 🏁' : ''}</div>
        <div class="r">
          <span class="tag">${esc(j.route_label)}</span>
          <span>${esc(j.route_name || j.category)}</span>
          <span>${esc(j.county)} Co. · D${j.district}</span>
          ${j.storm ? '<span style="color:var(--accent2)">⚠ storm ×2</span>' : ''}
          ${st?.crew_count ? `<span style="color:var(--accent2)">👷 ${st.crew_count}${j.min_crews > 1 ? `/${j.min_crews}` : ''}</span>` : ''}
        </div>
        <div class="pbar"><div class="pfill" style="width:${pct}%"></div></div>
      </div>`;
    }).join('') || '<p class="empty" style="padding:8px">No work orders match those filters.</p>';
  }

  // -------------------------------------------------------------- job modal
  function openJob(id) {
    state.selected = id;
    $('jobModal').hidden = false;
    renderJobCard();
    const j = state.jobs.get(id);
    if (j?.centroid) map.panTo([j.centroid[1], j.centroid[0]]);
  }
  function closeJob() {
    state.selected = null;
    $('jobModal').hidden = true;
  }

  /**
   * Everything that changes which *controls* are on the card. The live numbers
   * (percentage, ETA, crews on site) are deliberately not in here — those are
   * updated in place so the buttons survive a click.
   */
  function jobCardSignature() {
    const j = state.jobs.get(state.selected);
    if (!j) return '';
    const st = state.stateById.get(j.id);
    const now = serverNow();
    const jobCrews = [...state.crews.values()].filter((c) => c.job_id === j.id && !c.return_at);
    const myCrew = jobCrews.find((c) => c.player_id === state.me?.id && !c.contractor_until);
    const { working } = liveProgress(j.id);
    return [
      j.id, jobDone(j) ? 1 : 0,
      myCrew ? 1 : 0,
      jobCrews.some((c) => c.player_id === state.me?.id && c.contractor_until) ? 1 : 0,
      myCrews().length >= maxCrews() ? 1 : 0,
      myCrew && Date.parse(myCrew.arrives_at) > now ? 1 : 0,
      myCrew?.boost_until && Date.parse(myCrew.boost_until) > now ? 1 : 0,
      working >= (j.min_crews || 1) ? 1 : 0,
      jobCrews.map((c) => c.player_name).sort().join(','),
      state.me?.funds
    ].join('~');
  }

  /** Update the live numbers on an already-rendered card. */
  function tickJobCard() {
    if (!state.selected) return;
    const j = state.jobs.get(state.selected);
    if (!j) return closeJob();
    if (jobCardSignature() !== state.cardSig) return renderJobCard();

    const st = state.stateById.get(j.id);
    const { progress, working } = liveProgress(j.id);
    const pct = Math.min(100, (progress / Number(j.effort)) * 100);
    const eta = etaSeconds(j.id);
    const status = $('jcStatus');
    const crews = $('jcCrews');
    const fill = $('jcFill');
    const callout = $('jcCallout');
    if (status) status.textContent = jobDone(j) ? 'Closed' : `${Math.round(pct)}% complete`;
    if (crews) {
      crews.textContent = `${plural(working, 'crew', 'crews')} working` +
        (eta ? ` · ~${fmtDur(eta)} left` : '');
    }
    if (fill) fill.style.width = `${pct}%`;
    if (callout) {
      callout.textContent = `${working} of ${j.min_crews} crews on site.`;
    }
  }

  function renderJobCard() {
    const j = state.jobs.get(state.selected);
    if (!j) return closeJob();
    state.cardSig = jobCardSignature();
    const st = state.stateById.get(j.id);
    const done = jobDone(j);
    const { progress, working } = liveProgress(j.id);
    const effort = Number(j.effort);
    const pct = Math.min(100, (progress / effort) * 100);
    const now = serverNow();
    const jobCrews = [...state.crews.values()].filter((c) => c.job_id === j.id && !c.return_at);
    const myCrew = jobCrews.find((c) => c.player_id === state.me?.id && !c.contractor_until);
    const myContractor = jobCrews.some((c) => c.player_id === state.me?.id && c.contractor_until);
    const full = myCrews().length >= maxCrews();
    const eta = etaSeconds(j.id);
    const helpers = [...new Set(jobCrews.filter((c) => !c.return_at).map((c) => c.player_name))];
    const away = state.me && !dispatchable(j);
    const fac = state.facilities.find((f) => f.id === myCrew?.facility_id) || nearestFacility(j);
    const ot = myRankIdx() >= 3;
    const driving = myCrew && Date.parse(myCrew.arrives_at) > now;
    const boosted = myCrew?.boost_until && Date.parse(myCrew.boost_until) > now;

    $('jobCard').innerHTML = `
      <h2>${j.incident ? '⚠ ' : ''}${esc(j.activity)}</h2>
      <div class="sub">${esc(j.category)} · ${esc(j.county)} County · District ${j.district}</div>
      <dl class="kv">
        <dt>Route</dt><dd>${esc(j.route_label)} ${j.route_name ? '— ' + esc(j.route_name) : ''}</dd>
        <dt>Milepoints</dt><dd>BMP ${Number(j.bmp).toFixed(2)} → EMP ${Number(j.emp).toFixed(2)} (${j.miles} mi)</dd>
        <dt>Scheduled</dt><dd>${esc(j.start_time)} – ${esc(j.end_time)}</dd>
        ${fac ? `<dt>Dispatch from</dt><dd>🏗 ${esc(fac.name)}</dd>` : ''}
        ${j.detail ? `<dt>Detail</dt><dd>${esc(j.detail)}</dd>` : ''}
        ${j.approx ? '<dt>Location</dt><dd class="warn">Milepoints fall outside the mapped route extent — full route shown.</dd>' : ''}
        ${j.incident ? `<dt>Clears at</dt><dd class="warn">${new Date(j.expires_at).toLocaleTimeString()}</dd>` : ''}
        ${j.storm ? `<dt>Conditions</dt><dd class="storm-note">${esc((STORM_STYLE[stormFor(j.county_code)?.kind] || STORM_STYLE.other).label)} — active NWS alert in ${esc(j.county)} County. Double XP.</dd>` : ''}
        ${j.milestone ? '<dt>Milestone</dt><dd>🏁 One of the day\'s biggest jobs — everyone on site is paid a bonus at 25%, 50% and 75%.</dd>' : ''}
        ${j.parent_id ? '<dt>Follow-up</dt><dd>Opened by finishing an earlier work order here.</dd>' : ''}
        ${state.focus && j.category === state.focus ? '<dt>Focus</dt><dd class="focus-note">★ Focus category this week — +50% XP.</dd>' : ''}
        ${away ? `<dt>Territory</dt><dd class="warn">District ${j.district} is outside your district — only incidents are statewide.</dd>` : ''}
      </dl>
      ${j.min_crews > 1 && !done ? `
      <div class="callout-bar ${working >= j.min_crews ? 'ready' : ''}">
        ⛑ <b>EMERGENCY CALLOUT</b> — <span id="jcCallout">${working} of ${j.min_crews} crews on site.</span>
        ${working >= j.min_crews ? 'Work is underway.'
          : `No work happens until ${plural(j.min_crews - working, 'more crew arrives', 'more crews arrive')}.`}
      </div>` : ''}
      <div class="jobprog">
        <div class="lbl"><span id="jcStatus">${done ? 'Closed' : `${Math.round(pct)}% complete`}</span>
          <span id="jcCrews">${plural(working, 'crew', 'crews')} working${eta ? ` · ~${fmtDur(eta)} left` : ''}</span></div>
        <div class="bar"><div class="fill" id="jcFill" style="width:${pct}%"></div></div>
      </div>
      <div class="helpers">${helpers.length ? '👷 ' + helpers.map(esc).join(', ') : 'No crews on site yet.'}</div>
      <div class="job-actions">
        ${done
          ? '<button class="ghost" data-close>Closed for today</button>'
          : myCrew
            ? `<button class="primary" data-recall="${esc(j.id)}">Recall my crew</button>`
            : `<button class="primary" data-dispatch="${esc(j.id)}" ${away || full ? 'disabled' : ''}>${
                away ? 'Outside your district' : full ? 'All crews busy' : 'Dispatch a crew'}</button>`}
        <button class="ghost" data-close>Close</button>
        ${done ? '' : `<button class="ghost" data-radio="${esc(j.id)}" title="Ask the other managers for help">📻 Request backup</button>`}
      </div>
      ${ot && !done && !away ? `
      <div class="overtime">
        <div class="ot-head">Overtime <span class="pill">$${(state.me?.funds || 0).toLocaleString()}</span></div>
        <div class="ot-row">
          <button class="ot" data-ot="hot" data-otjob="${esc(j.id)}" ${driving ? '' : 'disabled'}>
            🛻 Hot-shot <b>$75</b><span>skip the drive</span></button>
          <button class="ot" data-ot="dbl" data-otjob="${esc(j.id)}" ${myCrew && !boosted ? '' : 'disabled'}>
            ⚡ Double shift <b>$150</b><span>2× for 10 min</span></button>
          <button class="ot" data-ot="con" data-otjob="${esc(j.id)}" ${myContractor ? 'disabled' : ''}>
            🚜 Contractor <b>$400</b><span>extra crew, 15 min</span></button>
        </div>
      </div>` : ''}`;
  }

  // ---------------------------------------------------------------- garage
  function openGarage() {
    if (myRankIdx() < 4) return toast('The equipment garage unlocks at County Supervisor.', 'warn');
    $('garageModal').hidden = false;
    renderGarage();
  }
  function renderGarage() {
    const funds = state.me?.funds || 0;
    const rank = myRankIdx();
    $('garageCard').innerHTML = `
      <h2>Equipment garage</h2>
      <div class="sub">Budget on hand: <b style="color:var(--good)">$${funds.toLocaleString()}</b></div>
      <div class="shop">
        ${state.catalog.map((e) => {
          const owned = state.owned.has(e.key);
          const locked = rank < e.min_rank;
          const afford = funds >= e.cost;
          return `<div class="shop-item ${owned ? 'owned' : ''}">
            <div class="si-main">
              <div class="si-name">${esc(e.name)}${owned ? ' <span class="owned-tag">in service</span>' : ''}</div>
              <div class="si-blurb">${esc(e.blurb)}</div>
              ${locked ? `<div class="si-lock">Requires ${esc((state.ranks.find((r) => r.idx === e.min_rank) || {}).name || '')}</div>` : ''}
            </div>
            <button class="primary si-buy" data-buy="${esc(e.key)}"
              ${owned || locked || !afford ? 'disabled' : ''}>
              ${owned ? '✓' : `$${e.cost.toLocaleString()}`}</button>
          </div>`;
        }).join('')}
      </div>
      <div class="job-actions"><button class="ghost" data-close-garage>Close</button></div>`;
  }

  // ------------------------------------------------------------ ticker/toast
  function pushFeed(e) {
    if (!e || state.seenFeed.has(e.id)) return;
    state.seenFeed.add(e.id);
    if (state.seenFeed.size > 600) {
      state.seenFeed = new Set([...state.seenFeed].slice(-300));
    }
    const div = document.createElement('div');
    div.className = e.kind;
    const time = new Date(e.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    if (e.job_id && state.jobs.has(e.job_id)) {
      div.innerHTML = `${time}  ${esc(e.body)} <a href="#" data-job="${esc(e.job_id)}">dispatch →</a>`;
    } else {
      div.textContent = `${time}  ${e.body}`;
    }
    const t = $('ticker');
    t.prepend(div);
    while (t.childElementCount > 60) t.lastElementChild.remove();
    if (!state.hydrated) return;
    // Only things a manager can act on, or has just earned, interrupt.
    if (e.kind === 'callout') toast(e.body, 'warn');
    else if (e.kind === 'radio') toast(e.body, 'warn');
    else if (e.kind === 'report-card') toast(e.body, 'good');
    else if (e.kind === 'incident' && state.me &&
             state.jobs.get(e.job_id)?.district === state.me.district) {
      toast(e.body, 'warn');
    } else if (e.kind === 'commendation' && state.me && e.body.startsWith(state.me.name + ' ')) {
      toast(e.body, 'good');
      loadMe();
    }
    if (e.kind === 'system' && e.body.includes('reset')) setTimeout(() => location.reload(), 3000);
  }

  /**
   * Toasts are capped and queue-trimmed. A burst of incident spawns used to
   * stack twenty full-width banners straight across the map; the ticker is the
   * place for volume, this is only for things worth interrupting over.
   */
  function toast(text, level = 'info') {
    const box = $('toasts');
    const d = document.createElement('div');
    d.className = `toast ${level === 'good' ? 'good' : level === 'warn' ? 'warn' : ''}`;
    d.textContent = text;
    box.append(d);
    while (box.childElementCount > 3) box.firstElementChild.remove();
    setTimeout(() => d.remove(), 4200);
  }

  // ---------------------------------------------------------------- controls
  const setBoot = (m) => { $('bootStatus').innerHTML = m; };

  function fillCountySelect() {
    const sel = $('countySelect');
    sel.innerHTML = state.counties
      .map((c) => `<option value="${esc(c.name)}">${esc(c.name)} County — D${c.district}</option>`).join('');
    const saved = localStorage.getItem('roadworks.county');
    if (saved) sel.value = saved;
    $('nameInput').value = localStorage.getItem('roadworks.name') || '';
  }

  function fillFilters() {
    const d = $('districtFilter');
    for (let i = 1; i <= 10; i++) d.insertAdjacentHTML('beforeend', `<option value="${i}">District ${i}</option>`);
    const c = $('catFilter');
    for (const k of Object.keys(CATEGORY)) c.insertAdjacentHTML('beforeend', `<option value="${esc(k)}">${esc(k)}</option>`);
  }

  document.addEventListener('click', async (e) => {
    const ot = e.target.closest('[data-ot]');
    if (ot) {
      const fn = { hot: 'buy_hot_shot', dbl: 'buy_double_shift', con: 'buy_contractor' }[ot.dataset.ot];
      const msg = { hot: 'Crew is on site.', dbl: 'Double shift started.', con: 'Contractor rolling.' }[ot.dataset.ot];
      ot.disabled = true;
      return overtime(fn, ot.dataset.otjob, msg);
    }
    const buy = e.target.closest('[data-buy]');
    if (buy) {
      buy.disabled = true;
      const r = await call('buy_equipment', { p_key: buy.dataset.buy }, 'Put into service.');
      if (r) { await loadMe(); renderAll(); }
      return renderGarage();
    }
    if (e.target.closest('#garageBtn')) return openGarage();
    if (e.target.closest('[data-close-garage]') || e.target.id === 'garageModal') {
      $('garageModal').hidden = true; return;
    }
    const disp = e.target.closest('[data-dispatch]');
    if (disp) { disp.disabled = true; return dispatch(disp.dataset.dispatch); }
    const rec = e.target.closest('[data-recall]');
    if (rec) return recall(rec.dataset.recall);
    const rad = e.target.closest('[data-radio]');
    if (rad) { rad.disabled = true; return radioPing(rad.dataset.radio); }
    if (e.target.closest('[data-close]') || e.target.id === 'jobModal') return closeJob();
    const jobEl = e.target.closest('[data-job]');
    if (jobEl) { e.preventDefault(); return openJob(jobEl.dataset.job); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeJob(); $('garageModal').hidden = true; }
  });

  for (const id of ['search', 'districtFilter', 'catFilter', 'hideDone', 'onlyMine']) {
    $(id).addEventListener('input', renderJobList);
  }

  $('chatForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = $('chatInput').value.trim();
    $('chatInput').value = '';
    if (v) await sb.rpc('post_chat', { p_text: v });
  });

  // ------------------------------------------------------------------ utils
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const cssEsc = (s) => (window.CSS?.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));
  /** Pick the right word rather than gluing a suffix onto a stem. */
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const round5 = (n) => Math.round(n * 1e5) / 1e5;
  function dist(a, b) {
    if (!a || !b) return 1e9;
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  }
  function fmtDur(s) {
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  }

  boot().catch((e) => setBoot(`Startup failed: ${esc(e.message)}`));
})();
