/* WVDOT Roadworks — client */
(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    jobs: new Map(),
    players: [],
    crews: [],
    counties: [],
    categories: {},
    leaderboard: [],
    day: {},
    stats: {},
    me: null,
    selected: null,
    seenEvents: new Set()
  };

  const layers = { jobs: new Map(), crews: new Map() };

  // ------------------------------------------------------------------- map
  const map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([38.85, -80.4], 8);
  L.tileLayer('https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap, &copy; CARTO | work orders: WV511 | routes: WVDOT GIS'
  }).addTo(map);

  // --------------------------------------------------------------- websocket
  let ws;
  let reconnectDelay = 800;
  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
    ws.onopen = () => { reconnectDelay = 800; setBoot('Connected. Loading today\'s report…'); };
    ws.onmessage = (e) => handle(JSON.parse(e.data));
    ws.onclose = () => {
      setBoot('Connection lost — reconnecting…');
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(8000, reconnectDelay * 1.6);
    };
  }
  const sendMsg = (o) => ws?.readyState === 1 && ws.send(JSON.stringify(o));

  function handle(msg) {
    switch (msg.type) {
      case 'welcome':
        state.categories = msg.categories;
        applyFull(msg.state);
        buildLegend();
        maybeAutoJoin();
        break;
      case 'delta':
        applyDelta(msg);
        break;
      case 'joined':
        localStorage.setItem('wvdot.token', msg.token);
        localStorage.setItem('wvdot.name', msg.you.name);
        localStorage.setItem('wvdot.county', msg.you.county);
        state.me = msg.you;
        $('boot').hidden = true;
        if (msg.you.home) map.setView([msg.you.home[1], msg.you.home[0]], 10);
        renderMe();
        break;
      case 'self':
        state.me = msg.you;
        renderMe();
        break;
      case 'newday':
        toast('A new daily road report just posted — board reset!', 'good');
        applyFull(msg.state);
        break;
      case 'toast':
        toast(msg.text, msg.level);
        break;
    }
  }

  // ------------------------------------------------------------ state apply
  function applyFull(s) {
    state.day = s.day || {};
    state.counties = s.counties || [];
    state.leaderboard = s.leaderboard || [];
    state.players = s.players || [];
    state.crews = s.crews || [];
    state.jobs.clear();
    for (const j of s.jobs || []) state.jobs.set(j.id, j);
    for (const [, l] of layers.jobs) map.removeLayer(l);
    layers.jobs.clear();
    for (const j of state.jobs.values()) upsertJobLayer(j);
    fillCountySelect();
    fillFilters();
    setLoading(s.loading);
    (s.events || []).forEach(pushEvent);
    renderAll();
  }

  function applyDelta(m) {
    state.day = m.day || state.day;
    state.stats = m.stats || state.stats;
    state.players = m.players || state.players;
    state.crews = m.crews || state.crews;
    state.leaderboard = m.leaderboard || state.leaderboard;
    for (const j of m.jobs || []) {
      if (j.removed) {
        state.jobs.delete(j.id);
        const l = layers.jobs.get(j.id);
        if (l) { map.removeLayer(l); layers.jobs.delete(j.id); }
        if (state.selected === j.id) closeJob();
      } else {
        state.jobs.set(j.id, j);
        upsertJobLayer(j);
      }
    }
    (m.events || []).forEach(pushEvent);
    setLoading(m.loading);
    renderAll();
  }

  // ------------------------------------------------------------- map layers
  function jobColor(j) {
    if (j.done) return '#2f9e5f';
    return (state.categories[j.category] || {}).color || '#8b98a8';
  }

  function upsertJobLayer(j) {
    if (!j.coords || j.coords.length < 2) return;
    const latlngs = j.coords.map((c) => [c[1], c[0]]);
    const busy = j.crewCount > 0;
    const style = {
      color: jobColor(j),
      weight: j.incident ? 7 : busy ? 6 : 4,
      opacity: j.done ? 0.35 : 0.9,
      dashArray: j.approx ? '5,6' : null
    };
    let line = layers.jobs.get(j.id);
    if (!line) {
      line = L.polyline(latlngs, style).addTo(map);
      line.on('click', () => openJob(j.id));
      layers.jobs.set(j.id, line);
    } else {
      line.setLatLngs(latlngs);
      line.setStyle(style);
    }
    line.bindTooltip(
      `<b>${esc(j.activity)}</b><br>${esc(j.routeLabel)} ${esc(j.routeName || '')}<br>` +
      `${esc(j.county)} Co. · D${j.district}${busy ? ` · ${j.crewCount} crew(s)` : ''}`,
      { sticky: true }
    );
  }

  function renderCrews() {
    const seen = new Set();
    for (const c of state.crews) {
      seen.add(c.id);
      const job = state.jobs.get(c.jobId);
      if (!job || !c.from || !c.to) continue;
      const t = c.phase === 'travel' ? Math.max(0, Math.min(1, c.pct)) : 1;
      const lat = c.from[1] + (c.to[1] - c.from[1]) * t;
      const lng = c.from[0] + (c.to[0] - c.from[0]) * t;
      const mine = state.me && c.playerId === state.me.id;
      const glyph = c.phase === 'travel' ? '🛻' : '🚧';
      let mk = layers.crews.get(c.id);
      if (!mk) {
        mk = L.marker([lat, lng], {
          icon: L.divIcon({ className: '', html: `<div class="crew-icon">${glyph}</div>`, iconSize: [20, 20] }),
          zIndexOffset: mine ? 900 : 400,
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
    $('legend').innerHTML = Object.entries(state.categories)
      .map(([k, v]) => `<div><i style="background:${v.color}"></i>${esc(k)}</div>`)
      .join('') + '<div><i style="background:#2f9e5f"></i>Closed today</div>';
  }

  // ------------------------------------------------------------------ render
  function renderAll() {
    renderHeader();
    renderCrews();
    renderMyCrews();
    renderLeaderboard();
    renderJobList();
    if (state.selected) renderJobCard();
  }

  function renderHeader() {
    $('dayDate').textContent = state.day.reportDate
      ? new Date(state.day.reportDate + 'T12:00:00').toLocaleDateString('en-US',
          { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
      : '—';
    const jobs = [...state.jobs.values()];
    const done = jobs.filter((j) => j.done).length;
    const open = jobs.length - done;
    const inc = jobs.filter((j) => j.incident && !j.done).length;
    $('progressLabel').textContent = `${done} / ${jobs.length} work orders closed`;
    $('dayFill').style.width = jobs.length ? `${(done / jobs.length) * 100}%` : '0';
    const badge = $('incidentBadge');
    badge.hidden = !inc;
    badge.textContent = `⚠ ${inc} active incident${inc === 1 ? '' : 's'}`;
    $('statOnline').textContent = state.players.filter((p) => p.online).length;
    $('statCrews').textContent = state.crews.length;
    $('statOpen').textContent = open;
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
    $('meFunds').textContent = `$${me.funds.toLocaleString()}`;
    $('meDone').textContent = me.jobsDone;
    $('meDayXp').textContent = me.dayXp;
    $('crewCount').textContent = `${me.crews.length}/${me.maxCrews}`;
  }

  function renderMyCrews() {
    if (!state.me) return;
    renderMe();
    const list = $('crewList');
    if (!state.me.crews.length) {
      list.innerHTML = '<p class="empty">No crews dispatched. Pick a work order on the map or in the queue.</p>';
      return;
    }
    list.innerHTML = state.me.crews.map((c) => {
      const j = state.jobs.get(c.jobId);
      const pct = j ? Math.round((j.progress / j.effort) * 100) : 0;
      return `<div class="crew ${c.phase}">
        <span class="dot"></span>
        <span class="who">
          <span class="act">${esc(j ? j.activity : 'Unknown')}</span>
          <span class="meta">${j ? esc(j.routeLabel) + ' · ' : ''}${c.phase === 'travel' ? `en route ${c.travelLeft}s` : `working ${pct}%`}</span>
        </span>
        <button title="Recall crew" data-recall="${c.id}">✕</button>
      </div>`;
    }).join('');
  }

  function renderLeaderboard() {
    $('leaderboard').innerHTML = state.leaderboard.map((p, i) =>
      `<li class="${state.me && p.id === state.me.id ? 'me' : ''}">
        <span class="rk">${i + 1}</span>
        <span class="nm">${esc(p.name)}<span style="color:var(--dim)"> · ${esc(p.county)}</span></span>
        <span class="sc">${p.dayXp}</span>
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
        if (hideDone && j.done) return false;
        if (d && String(j.district) !== d) return false;
        if (cat && j.category !== cat) return false;
        if (mineOnly && j.district !== state.me.district) return false;
        if (q && !(`${j.activity} ${j.routeLabel} ${j.routeName} ${j.county} ${j.detail}`.toLowerCase().includes(q))) return false;
        return true;
      })
      .sort((a, b) => {
        if (a.incident !== b.incident) return a.incident ? -1 : 1;
        if (!!a.crewCount !== !!b.crewCount) return b.crewCount - a.crewCount;
        if (home) return dist(home, a.centroid) - dist(home, b.centroid);
        return a.effort - b.effort;
      })
      .slice(0, 260);
  }

  function renderJobList() {
    const mineIds = new Set((state.me?.crews || []).map((c) => c.jobId));
    $('jobList').innerHTML = filteredJobs().map((j) => {
      const pct = Math.min(100, (j.progress / j.effort) * 100);
      return `<div class="job ${j.done ? 'done' : ''} ${mineIds.has(j.id) ? 'mine' : ''} ${j.incident ? 'incident' : ''}"
                   style="border-left-color:${jobColor(j)}" data-job="${j.id}">
        <div class="t">${j.incident ? '⚠ ' : ''}${esc(j.activity)}</div>
        <div class="r">
          <span class="tag">${esc(j.routeLabel)}</span>
          <span>${esc(j.routeName || j.category)}</span>
          <span>${esc(j.county)} Co. · D${j.district}</span>
          ${j.crewCount ? `<span style="color:var(--accent2)">👷 ${j.crewCount}</span>` : ''}
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
    const pct = Math.min(100, (j.progress / j.effort) * 100);
    const mine = (state.me?.crews || []).find((c) => c.jobId === j.id);
    const full = state.me && state.me.crews.length >= state.me.maxCrews;
    const eta = etaSeconds(j);
    $('jobCard').innerHTML = `
      <h2>${j.incident ? '⚠ ' : ''}${esc(j.activity)}</h2>
      <div class="sub">${esc(j.category)} · ${esc(j.county)} County · WVDOH District ${j.district}</div>
      <dl class="kv">
        <dt>Route</dt><dd>${esc(j.routeLabel)} ${j.routeName ? '— ' + esc(j.routeName) : ''}</dd>
        <dt>Milepoints</dt><dd>BMP ${j.bmp.toFixed(2)} → EMP ${j.emp.toFixed(2)} (${j.miles} mi)</dd>
        <dt>Scheduled</dt><dd>${esc(j.startTime)} – ${esc(j.endTime)}</dd>
        ${j.detail ? `<dt>Detail</dt><dd>${esc(j.detail)}</dd>` : ''}
        ${j.approx ? '<dt>Location</dt><dd class="warn">Milepoints fall outside the mapped route extent — full route shown.</dd>' : ''}
        ${j.incident ? `<dt>Clears at</dt><dd class="warn">${new Date(j.expiresAt).toLocaleTimeString()}</dd>` : ''}
      </dl>
      <div class="jobprog">
        <div class="lbl"><span>${j.done ? 'Closed' : `${Math.round(pct)}% complete`}</span>
          <span>${j.crewsWorking} crew(s) working${eta ? ` · ~${eta}s left` : ''}</span></div>
        <div class="bar"><div class="fill" style="width:${pct}%"></div></div>
      </div>
      <div class="helpers">${j.helpers.length ? '👷 ' + j.helpers.map(esc).join(', ') : 'No crews on site yet.'}</div>
      <div class="job-actions">
        ${j.done
          ? '<button class="ghost" data-close>Closed for today</button>'
          : mine
            ? `<button class="primary" data-recall="${mine.id}">Recall my crew</button>`
            : `<button class="primary" data-dispatch="${j.id}" ${full ? 'disabled' : ''}>${full ? 'All crews busy' : 'Dispatch a crew'}</button>`}
        <button class="ghost" data-close>Close</button>
      </div>`;
  }

  function etaSeconds(j) {
    const n = j.crewsWorking;
    if (!n || j.done) return 0;
    const mult = Math.min(3, 1 + 0.12 * (n - 1));
    return Math.ceil((j.effort - j.progress) / (n * mult));
  }

  // ------------------------------------------------------------ ticker/toast
  function pushEvent(e) {
    const key = `${e.t}|${e.text}`;
    if (state.seenEvents.has(key)) return;
    state.seenEvents.add(key);
    if (state.seenEvents.size > 400) state.seenEvents = new Set([...state.seenEvents].slice(-200));
    const div = document.createElement('div');
    div.className = e.type;
    const time = new Date(e.t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    div.textContent = `${time}  ${e.text}`;
    const t = $('ticker');
    t.prepend(div);
    while (t.childElementCount > 60) t.lastElementChild.remove();
    if (e.type === 'incident') toast(e.text, 'warn');
  }

  function toast(text, level = 'info') {
    const d = document.createElement('div');
    d.className = `toast ${level === 'good' ? 'good' : ''}`;
    d.textContent = text;
    $('toasts').append(d);
    setTimeout(() => d.remove(), 4200);
  }

  // ---------------------------------------------------------------- controls
  function setBoot(msg) { $('bootStatus').textContent = msg; }

  function setLoading(l) {
    if (!l) return;
    if (l.active) {
      $('boot').hidden = false;
      $('joinForm').hidden = true;
      setBoot(l.message || 'Working…');
    } else if ($('joinForm').hidden && !state.me) {
      $('joinForm').hidden = false;
      setBoot(`${state.jobs.size} work orders on the board.`);
    }
  }

  function fillCountySelect() {
    const sel = $('countySelect');
    if (sel.options.length) return;
    sel.innerHTML = state.counties
      .map((c) => `<option value="${esc(c.name)}">${esc(c.name)} County — D${c.district}</option>`).join('');
    const saved = localStorage.getItem('wvdot.county');
    if (saved) sel.value = saved;
    $('nameInput').value = localStorage.getItem('wvdot.name') || '';
  }

  function fillFilters() {
    const d = $('districtFilter');
    if (d.options.length <= 1) {
      for (let i = 1; i <= 10; i++) d.insertAdjacentHTML('beforeend', `<option value="${i}">District ${i}</option>`);
    }
    const c = $('catFilter');
    if (c.options.length <= 1) {
      for (const k of Object.keys(state.categories)) {
        c.insertAdjacentHTML('beforeend', `<option value="${esc(k)}">${esc(k)}</option>`);
      }
    }
  }

  function maybeAutoJoin() {
    const token = localStorage.getItem('wvdot.token');
    const name = localStorage.getItem('wvdot.name');
    const county = localStorage.getItem('wvdot.county');
    if (token && name && county) sendMsg({ type: 'join', token, name, county });
  }

  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    sendMsg({
      type: 'join',
      token: localStorage.getItem('wvdot.token') || null,
      name: $('nameInput').value.trim() || 'Manager',
      county: $('countySelect').value
    });
  });

  document.addEventListener('click', (e) => {
    const jobEl = e.target.closest('[data-job]');
    if (jobEl) return openJob(jobEl.dataset.job);
    const disp = e.target.closest('[data-dispatch]');
    if (disp) return sendMsg({ type: 'dispatch', jobId: disp.dataset.dispatch });
    const rec = e.target.closest('[data-recall]');
    if (rec) return sendMsg({ type: 'recall', crewId: rec.dataset.recall });
    if (e.target.closest('[data-close]') || e.target.id === 'jobModal') return closeJob();
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeJob(); });

  for (const id of ['search', 'districtFilter', 'catFilter', 'hideDone', 'onlyMine']) {
    $(id).addEventListener('input', renderJobList);
  }

  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('chatInput').value.trim();
    if (v) sendMsg({ type: 'chat', text: v });
    $('chatInput').value = '';
  });

  $('refreshBtn').addEventListener('click', () => {
    fetch('/api/refresh', { method: 'POST' });
    toast('Re-reading the WV511 district PDFs…');
  });

  // ------------------------------------------------------------------ utils
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function dist(a, b) {
    if (!a || !b) return 1e9;
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  }

  connect();
})();
