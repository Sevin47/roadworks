/* WVDOT Roadworks — static client. Supabase is the only backend.
 *
 * There is no game server and no tick. Postgres stores each job's banked
 * progress plus the instant it was banked; between Realtime events this file
 * re-derives the current value from crew arrival times, exactly the way
 * settle_job() does. When the local math says a job is finished it asks
 * Postgres to settle, and Postgres recomputes the whole thing itself.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const CFG = window.WVDOT_CONFIG || {};

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
    'Incident':              '#ff2e63'
  };

  const state = {
    reportDate: null,
    jobs: new Map(),      // id -> static job row
    stateById: new Map(), // id -> job_state row
    crews: new Map(),     // crew id -> crew row
    players: new Map(),
    counties: [],
    me: null,
    selected: null,
    skewMs: 0,            // serverNow - clientNow
    settling: new Set(),
    seenFeed: new Set()
  };

  const layers = { jobs: new Map(), crews: new Map() };
  const serverNow = () => Date.now() + state.skewMs;

  // -------------------------------------------------------------------- map
  const map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([38.85, -80.4], 8);
  L.tileLayer('https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap, &copy; CARTO | work orders: WV511 | routes: WVDOT GIS'
  }).addTo(map);

  // ------------------------------------------------------------ progress math
  // Mirror of settle_job(): the crowd rate is constant between crew arrivals,
  // so integrate span by span.
  const multiplier = (n) => (n <= 0 ? 0 : Math.min(3.0, 1 + 0.12 * (n - 1)));

  function liveProgress(jobId) {
    const job = state.jobs.get(jobId);
    const st = state.stateById.get(jobId);
    if (!job || !st) return { progress: 0, working: 0, done: false };
    if (st.done) return { progress: job.effort, working: 0, done: true };

    const arrivals = [...state.crews.values()]
      .filter((c) => c.job_id === jobId)
      .map((c) => Date.parse(c.arrives_at))
      .sort((a, b) => a - b);

    let progress = Number(st.progress);
    let cursor = Date.parse(st.progress_at);
    const now = serverNow();
    const marks = arrivals.filter((t) => t > cursor && t <= now).concat(now);

    for (const mark of marks) {
      const n = arrivals.filter((t) => t <= cursor).length;
      const dt = (mark - cursor) / 1000;
      if (n > 0 && dt > 0) {
        const gain = n * multiplier(n) * dt;
        progress = Math.min(job.effort, progress + gain);
        if (progress >= job.effort) break;
      }
      cursor = mark;
    }
    return {
      progress,
      working: arrivals.filter((t) => t <= now).length,
      done: progress >= job.effort
    };
  }

  function etaSeconds(jobId) {
    const job = state.jobs.get(jobId);
    const { progress, working } = liveProgress(jobId);
    if (!job || !working) return 0;
    return Math.ceil((job.effort - progress) / (working * multiplier(working)));
  }

  /** Ask Postgres to close a job our own clock says is finished. */
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

  // ------------------------------------------------------------------- boot
  async function boot() {
    setBoot('Signing in…');
    let { data: { session } } = await sb.auth.getSession();
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
      setBoot('No road report has been ingested yet. Run the ingest job (Actions → “Ingest WV511 daily road report”).');
      return;
    }
    state.reportDate = day.report_date;

    const [{ data: counties }, jobs, { data: states }, { data: crews }, { data: feed }] = await Promise.all([
      sb.from('wv_counties').select('*').order('name'),
      fetchAllJobs(day.report_date),
      sb.from('job_state').select('*'),
      sb.from('crews').select('*'),
      sb.from('feed').select('*').order('created_at', { ascending: false }).limit(40)
    ]);

    state.counties = counties || [];
    for (const j of jobs) state.jobs.set(j.id, j);
    for (const s of states || []) state.stateById.set(s.job_id, s);
    for (const c of crews || []) state.crews.set(c.id, c);
    (feed || []).reverse().forEach(pushFeed);

    for (const j of state.jobs.values()) upsertJobLayer(j);
    buildLegend();
    fillCountySelect();
    fillFilters();
    subscribe();
    await refreshPlayers();

    const existing = await loadMe();
    if (existing) {
      $('boot').hidden = true;
    } else {
      $('joinForm').hidden = false;
      setBoot(`${state.jobs.size} work orders on the board.`);
    }
    renderAll();

    setInterval(animate, 250);
    setInterval(refreshPlayers, 10000);
    setInterval(() => state.me && sb.rpc('heartbeat'), 45000);
  }

  /** jobs is the one big read; page through it so a long day isn't truncated. */
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
    const { data } = await sb.from('players').select('*').eq('id', user.id).maybeSingle();
    if (data) { state.me = data; renderMe(); }
    return data;
  }

  // --------------------------------------------------------------- realtime
  function subscribe() {
    sb.channel('roadworks')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'job_state' },
        (p) => { if (p.new?.job_id) applyJobState(p.new); })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'jobs' },
        (p) => { state.jobs.set(p.new.id, p.new); upsertJobLayer(p.new); renderAll(); })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'jobs' },
        (p) => removeJob(p.old?.id))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'crews' },
        (p) => { state.crews.set(p.new.id, p.new); renderAll(); })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'crews' },
        (p) => { if (p.old?.id) { state.crews.delete(p.old.id); renderAll(); } })
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
      for (const [id, c] of state.crews) if (c.job_id === s.job_id) state.crews.delete(id);
      if (state.me) loadMe();
    }
    renderAll();
  }

  function removeJob(id) {
    if (!id) return;
    state.jobs.delete(id);
    state.stateById.delete(id);
    for (const [cid, c] of state.crews) if (c.job_id === id) state.crews.delete(cid);
    const l = layers.jobs.get(id);
    if (l) { map.removeLayer(l); layers.jobs.delete(id); }
    if (state.selected === id) closeJob();
    renderAll();
  }

  async function refreshPlayers() {
    const { data } = await sb.from('players').select('id,name,county,district,level,xp,day_xp,jobs_done,last_seen');
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
    const { data, error } = await sb.rpc(fn, args);
    if (error) { toast(error.message.replace(/^.*?:\s*/, ''), 'warn'); return null; }
    if (okMsg) toast(okMsg, 'good');
    return data;
  }

  $('joinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    const row = await call('ensure_player', {
      p_name: $('nameInput').value.trim() || 'Manager',
      p_county: $('countySelect').value
    });
    btn.disabled = false;
    if (!row) return;
    state.me = Array.isArray(row) ? row[0] : row;
    localStorage.setItem('wvdot.name', state.me.name);
    localStorage.setItem('wvdot.county', state.me.county);
    $('boot').hidden = true;
    if (state.me.home) map.setView([state.me.home[1], state.me.home[0]], 10);
    renderAll();
  });

  async function dispatch(jobId) {
    const s = await call('dispatch_crew', { p_job: jobId });
    if (s) applyJobState(Array.isArray(s) ? s[0] : s);
    const { data } = await sb.from('crews').select('*').eq('job_id', jobId);
    for (const c of data || []) state.crews.set(c.id, c);
    renderAll();
  }

  async function recall(jobId) {
    const s = await call('recall_crew', { p_job: jobId });
    if (s) applyJobState(Array.isArray(s) ? s[0] : s);
    for (const [id, c] of state.crews) {
      if (c.job_id === jobId && c.player_id === state.me?.id) state.crews.delete(id);
    }
    renderAll();
  }

  // ------------------------------------------------------------- map layers
  const jobColor = (j) =>
    state.stateById.get(j.id)?.done ? '#2f9e5f' : (CATEGORY[j.category] || '#8b98a8');

  function upsertJobLayer(j) {
    if (!Array.isArray(j.coords) || j.coords.length < 2) return;
    const st = state.stateById.get(j.id);
    const busy = (st?.crew_count || 0) > 0;
    const style = {
      color: jobColor(j),
      weight: j.incident ? 7 : busy ? 6 : 4,
      opacity: st?.done ? 0.35 : 0.9,
      dashArray: j.approx ? '5,6' : null
    };
    let line = layers.jobs.get(j.id);
    if (!line) {
      line = L.polyline(j.coords.map((c) => [c[1], c[0]]), style).addTo(map);
      line.on('click', () => openJob(j.id));
      layers.jobs.set(j.id, line);
    } else {
      line.setStyle(style);
    }
    line.bindTooltip(
      `<b>${esc(j.activity)}</b><br>${esc(j.route_label)} ${esc(j.route_name || '')}<br>` +
      `${esc(j.county)} Co. · D${j.district}${busy ? ` · ${st.crew_count} crew(s)` : ''}`,
      { sticky: true }
    );
  }

  function renderCrewMarkers() {
    const now = serverNow();
    const seen = new Set();
    for (const c of state.crews.values()) {
      const job = state.jobs.get(c.job_id);
      const owner = state.players.get(c.player_id);
      if (!job || !job.centroid) continue;
      const home = owner?.home || job.centroid;
      seen.add(c.id);
      const start = Date.parse(c.dispatched_at);
      const end = Date.parse(c.arrives_at);
      const t = end > start ? Math.max(0, Math.min(1, (now - start) / (end - start))) : 1;
      const lat = home[1] + (job.centroid[1] - home[1]) * t;
      const lng = home[0] + (job.centroid[0] - home[0]) * t;
      const glyph = t >= 1 ? '🚧' : '🛻';
      let mk = layers.crews.get(c.id);
      if (!mk) {
        mk = L.marker([lat, lng], {
          icon: L.divIcon({ className: '', html: `<div class="crew-icon">${glyph}</div>`, iconSize: [20, 20] }),
          zIndexOffset: c.player_id === state.me?.id ? 900 : 400,
          interactive: false
        }).addTo(map);
        layers.crews.set(c.id, mk);
      } else {
        mk.setLatLng([lat, lng]);
        const el = mk.getElement()?.querySelector('.crew-icon');
        if (el && el.textContent !== glyph) el.textContent = glyph;
      }
    }
    for (const [id, mk] of layers.crews) {
      if (!seen.has(id)) { map.removeLayer(mk); layers.crews.delete(id); }
    }
  }

  function buildLegend() {
    $('legend').innerHTML = Object.entries(CATEGORY)
      .map(([k, v]) => `<div><i style="background:${v}"></i>${esc(k)}</div>`)
      .join('') + '<div><i style="background:#2f9e5f"></i>Closed today</div>';
  }

  // -------------------------------------------------------------- animation
  function animate() {
    renderCrewMarkers();
    let touched = false;
    for (const [id, st] of state.stateById) {
      if (st.done || !st.crew_count) continue;
      const { progress, done } = liveProgress(id);
      const bar = document.querySelector(`[data-job="${cssEsc(id)}"] .pfill`);
      const job = state.jobs.get(id);
      if (bar && job) bar.style.width = `${Math.min(100, (progress / job.effort) * 100)}%`;
      if (done) { maybeSettle(id); touched = true; }
    }
    if (state.selected) renderJobCard();
    if (touched) renderHeader();
  }

  // ------------------------------------------------------------------ render
  function renderAll() {
    renderHeader();
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
    const done = all.filter((j) => state.stateById.get(j.id)?.done).length;
    const inc = all.filter((j) => j.incident && !state.stateById.get(j.id)?.done).length;
    $('progressLabel').textContent = `${done} / ${all.length} work orders closed`;
    $('dayFill').style.width = all.length ? `${(done / all.length) * 100}%` : '0';
    const badge = $('incidentBadge');
    badge.hidden = !inc;
    badge.textContent = `⚠ ${inc} active incident${inc === 1 ? '' : 's'}`;
    const cutoff = serverNow() - 90_000;
    $('statOnline').textContent = [...state.players.values()]
      .filter((p) => Date.parse(p.last_seen) > cutoff).length;
    $('statCrews').textContent = state.crews.size;
    $('statOpen').textContent = all.length - done;
  }

  function renderMe() {
    const me = state.me;
    if (!me) return;
    $('meAvatar').textContent = me.name.slice(0, 1).toUpperCase();
    $('meName').textContent = `${me.name} · Lvl ${me.level}`;
    $('meSub').textContent = `${me.county} County · District ${me.district}`;
    const cur = 40 * (me.level - 1) ** 2;
    const next = 40 * me.level ** 2;
    $('xpFill').style.width = `${Math.min(100, ((me.xp - cur) / (next - cur)) * 100)}%`;
    $('xpText').textContent = `${me.xp} XP`;
    $('meFunds').textContent = `$${(me.funds || 0).toLocaleString()}`;
    $('meDone').textContent = me.jobs_done;
    $('meDayXp').textContent = me.day_xp;
    $('crewCount').textContent = `${myCrews().length}/${maxCrews()}`;
  }

  const myCrews = () => [...state.crews.values()].filter((c) => c.player_id === state.me?.id);
  const maxCrews = () => Math.min(12, 3 + Math.floor((state.me?.level || 1) / 2));

  function renderMyCrews() {
    if (!state.me) return;
    renderMe();
    const mine = myCrews();
    const list = $('crewList');
    if (!mine.length) {
      list.innerHTML = '<p class="empty">No crews dispatched. Pick a work order on the map or in the queue.</p>';
      return;
    }
    const now = serverNow();
    list.innerHTML = mine.map((c) => {
      const j = state.jobs.get(c.job_id);
      const eta = Math.ceil((Date.parse(c.arrives_at) - now) / 1000);
      const { progress } = liveProgress(c.job_id);
      const pct = j ? Math.round((progress / j.effort) * 100) : 0;
      return `<div class="crew ${eta > 0 ? 'travel' : 'working'}">
        <span class="dot"></span>
        <span class="who">
          <span class="act">${esc(j ? j.activity : 'Unknown')}</span>
          <span class="meta">${j ? esc(j.route_label) + ' · ' : ''}${eta > 0 ? `en route ${eta}s` : `working ${pct}%`}</span>
        </span>
        <button title="Recall crew" data-recall="${esc(c.job_id)}">✕</button>
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
        <span class="nm">${esc(p.name)}<span style="color:var(--dim)"> · ${esc(p.county)}</span></span>
        <span class="sc">${p.day_xp}</span>
      </li>`).join('') || '<li class="empty">Nobody on shift yet.</li>';
  }

  function filteredJobs() {
    const q = $('search').value.trim().toLowerCase();
    const d = $('districtFilter').value;
    const cat = $('catFilter').value;
    const hideDone = $('hideDone').checked;
    const mineOnly = $('onlyMine').checked && state.me;
    const home = state.me?.home;
    return [...state.jobs.values()]
      .filter((j) => {
        const st = state.stateById.get(j.id);
        if (hideDone && st?.done) return false;
        if (d && String(j.district) !== d) return false;
        if (cat && j.category !== cat) return false;
        if (mineOnly && j.district !== state.me.district) return false;
        if (q && !(`${j.activity} ${j.route_label} ${j.route_name} ${j.county} ${j.detail}`
          .toLowerCase().includes(q))) return false;
        return true;
      })
      .sort((a, b) => {
        if (a.incident !== b.incident) return a.incident ? -1 : 1;
        const ca = state.stateById.get(a.id)?.crew_count || 0;
        const cb = state.stateById.get(b.id)?.crew_count || 0;
        if (!!ca !== !!cb) return cb - ca;
        if (home) return dist(home, a.centroid) - dist(home, b.centroid);
        return a.effort - b.effort;
      })
      .slice(0, 260);
  }

  function renderJobList() {
    const mineIds = new Set(myCrews().map((c) => c.job_id));
    $('jobList').innerHTML = filteredJobs().map((j) => {
      const st = state.stateById.get(j.id);
      const { progress } = liveProgress(j.id);
      const pct = Math.min(100, (progress / j.effort) * 100);
      return `<div class="job ${st?.done ? 'done' : ''} ${mineIds.has(j.id) ? 'mine' : ''} ${j.incident ? 'incident' : ''}"
                   style="border-left-color:${jobColor(j)}" data-job="${esc(j.id)}">
        <div class="t">${j.incident ? '⚠ ' : ''}${esc(j.activity)}</div>
        <div class="r">
          <span class="tag">${esc(j.route_label)}</span>
          <span>${esc(j.route_name || j.category)}</span>
          <span>${esc(j.county)} Co. · D${j.district}</span>
          ${st?.crew_count ? `<span style="color:var(--accent2)">👷 ${st.crew_count}</span>` : ''}
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

  function renderJobCard() {
    const j = state.jobs.get(state.selected);
    if (!j) return closeJob();
    const st = state.stateById.get(j.id);
    const { progress, working } = liveProgress(j.id);
    const pct = Math.min(100, (progress / j.effort) * 100);
    const mine = myCrews().some((c) => c.job_id === j.id);
    const full = myCrews().length >= maxCrews();
    const eta = etaSeconds(j.id);
    const helpers = [...new Set([...state.crews.values()]
      .filter((c) => c.job_id === j.id).map((c) => c.player_name))];
    $('jobCard').innerHTML = `
      <h2>${j.incident ? '⚠ ' : ''}${esc(j.activity)}</h2>
      <div class="sub">${esc(j.category)} · ${esc(j.county)} County · WVDOH District ${j.district}</div>
      <dl class="kv">
        <dt>Route</dt><dd>${esc(j.route_label)} ${j.route_name ? '— ' + esc(j.route_name) : ''}</dd>
        <dt>Milepoints</dt><dd>BMP ${Number(j.bmp).toFixed(2)} → EMP ${Number(j.emp).toFixed(2)} (${j.miles} mi)</dd>
        <dt>Scheduled</dt><dd>${esc(j.start_time)} – ${esc(j.end_time)}</dd>
        ${j.detail ? `<dt>Detail</dt><dd>${esc(j.detail)}</dd>` : ''}
        ${j.approx ? '<dt>Location</dt><dd class="warn">Milepoints fall outside the mapped route extent — full route shown.</dd>' : ''}
        ${j.incident ? `<dt>Clears at</dt><dd class="warn">${new Date(j.expires_at).toLocaleTimeString()}</dd>` : ''}
      </dl>
      <div class="jobprog">
        <div class="lbl"><span>${st?.done ? 'Closed' : `${Math.round(pct)}% complete`}</span>
          <span>${working} crew(s) working${eta ? ` · ~${eta}s left` : ''}</span></div>
        <div class="bar"><div class="fill" style="width:${pct}%"></div></div>
      </div>
      <div class="helpers">${helpers.length ? '👷 ' + helpers.map(esc).join(', ') : 'No crews on site yet.'}</div>
      <div class="job-actions">
        ${st?.done
          ? '<button class="ghost" data-close>Closed for today</button>'
          : mine
            ? `<button class="primary" data-recall="${esc(j.id)}">Recall my crew</button>`
            : `<button class="primary" data-dispatch="${esc(j.id)}" ${full ? 'disabled' : ''}>${full ? 'All crews busy' : 'Dispatch a crew'}</button>`}
        <button class="ghost" data-close>Close</button>
      </div>`;
  }

  // ------------------------------------------------------------ ticker/toast
  function pushFeed(e) {
    if (!e || state.seenFeed.has(e.id)) return;
    state.seenFeed.add(e.id);
    const div = document.createElement('div');
    div.className = e.kind;
    const time = new Date(e.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    div.textContent = `${time}  ${e.body}`;
    const t = $('ticker');
    t.prepend(div);
    while (t.childElementCount > 60) t.lastElementChild.remove();
    if (e.kind === 'incident') toast(e.body, 'warn');
    if (e.kind === 'system' && e.body.includes('reset')) setTimeout(() => location.reload(), 3000);
  }

  function toast(text, level = 'info') {
    const d = document.createElement('div');
    d.className = `toast ${level === 'good' ? 'good' : ''}`;
    d.textContent = text;
    $('toasts').append(d);
    setTimeout(() => d.remove(), 4200);
  }

  // ---------------------------------------------------------------- controls
  const setBoot = (m) => { $('bootStatus').innerHTML = m; };

  function fillCountySelect() {
    const sel = $('countySelect');
    sel.innerHTML = state.counties
      .map((c) => `<option value="${esc(c.name)}">${esc(c.name)} County — D${c.district}</option>`).join('');
    const saved = localStorage.getItem('wvdot.county');
    if (saved) sel.value = saved;
    $('nameInput').value = localStorage.getItem('wvdot.name') || '';
  }

  function fillFilters() {
    const d = $('districtFilter');
    for (let i = 1; i <= 10; i++) d.insertAdjacentHTML('beforeend', `<option value="${i}">District ${i}</option>`);
    const c = $('catFilter');
    for (const k of Object.keys(CATEGORY)) c.insertAdjacentHTML('beforeend', `<option value="${esc(k)}">${esc(k)}</option>`);
  }

  document.addEventListener('click', (e) => {
    const disp = e.target.closest('[data-dispatch]');
    if (disp) return dispatch(disp.dataset.dispatch);
    const rec = e.target.closest('[data-recall]');
    if (rec) return recall(rec.dataset.recall);
    if (e.target.closest('[data-close]') || e.target.id === 'jobModal') return closeJob();
    const jobEl = e.target.closest('[data-job]');
    if (jobEl) return openJob(jobEl.dataset.job);
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeJob(); });

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
  function dist(a, b) {
    if (!a || !b) return 1e9;
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  }

  boot().catch((e) => setBoot(`Startup failed: ${esc(e.message)}`));
})();
