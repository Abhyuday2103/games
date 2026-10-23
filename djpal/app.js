/* DJPal: party request queue. Host-authoritative over PeerJS, no server. */
(() => {
  'use strict';

  const PEER_OPTS = {
    debug: 1,
    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }] }
  };
  const PREFIX = 'djpal-v1-';
  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage off */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* noop */ } }
  };
  const BASE = location.origin + location.pathname.replace(/index\.html$/, '');

  let token = store.get('djpal.token', null);
  if (!token) { token = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set('djpal.token', token); }

  const app = { role: null, peer: null, party: null, conns: new Map(), tokenOf: new Map(), conn: null, code: null, view: null, offline: false };

  // ---------- small UI helpers ----------
  let toastT;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600); }
  function show(id) { ['#landing', '#hello', '#guest', '#host'].forEach(s => $(s).classList.toggle('hide', s !== id)); window.scrollTo(0, 0); }
  function genCode() { let s = ''; for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; return s; }
  function qrSvg(text) {
    if (typeof qrcode !== 'function') return '<div style="width:128px;height:128px;display:grid;place-items:center;color:#000;font-size:12px">QR unavailable</div>';
    const q = qrcode(0, 'M'); q.addData(text); q.make();
    return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }
  const inviteUrl = () => BASE + '?room=' + app.code;
  const fmtDur = ms => { const s = Math.round(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  // What to type into djay / streaming search: drop "(From ...)", "(feat ...)", "[...]" and keep the first artist.
  function searchText(t) {
    const title = t.title.replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/\s+-\s+.*$/, '').trim() || t.title;
    const artist = (t.artist || '').split(/,|&| feat\.? | x /i)[0].trim();
    return (title + ' ' + artist).trim();
  }
  const cleanTitle = t => t.replace(/\s*[([][^)\]]*[)\]]/g, '').trim() || t;

  // ---------- Android app bridge (only present inside the DJPal Android app) ----------
  const BR = window.DJPalBridge || null;
  const loadedOn = {}; // song id -> deck it was sent to
  const pendingLoad = {};
  function bridgeStatus() { try { return JSON.parse(BR.status()); } catch (e) { return {}; } }
  function renderBridge() {
    if (!BR || app.role !== 'host') return;
    const s = bridgeStatus();
    let msg = '';
    if (!s.ready) msg = 'DJPal Bridge is switched off, so Deck buttons can\'t reach djay yet.';
    else if (!s.djay) msg = 'djay isn\'t installed on this phone.';
    else if (!s.deck1 || !s.deck2) msg = 'Teach DJPal where djay\'s deck buttons are (20 seconds, one time).';
    $('#hBridge').innerHTML = msg ? '<div class="banner">' + msg + ' <button class="btn sm amber" data-bridge="setup">Bridge setup</button></div>' : '';
  }
  window.onDJPalBridgeStatus = renderBridge;
  window.onDJPalBridge = (key, ok, msg) => {
    const [id, deck] = String(key).split(':');
    delete pendingLoad[key];
    if (ok) loadedOn[id] = Number(deck);
    toast(msg);
    renderHost();
  };
  function deckButtons(q, big) {
    const sz = big ? '' : ' sm';
    return [1, 2].map(n => {
      const key = q.id + ':' + n, busy = pendingLoad[key];
      return '<button class="btn' + sz + (big && n === 1 ? ' hot' : '') + '" data-load="' + esc(q.id) + '" data-deck="' + n + '"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Loading...' : 'Deck ' + n) + '</button>';
    }).join('');
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (er) { /* noop */ } ta.remove(); return ok;
    }
  }

  // ---------- Apple catalog search (free, no key, ~20 lookups a minute per network) ----------
  const cache = new Map();
  let searchCtl = null;
  async function searchCatalog(q) {
    q = q.trim().toLowerCase();
    if (cache.has(q)) return cache.get(q);
    if (searchCtl) searchCtl.abort();
    searchCtl = new AbortController();
    const url = 'https://itunes.apple.com/search?media=music&entity=song&limit=25&country=us&term=' + encodeURIComponent(q);
    const res = await fetch(url, { signal: searchCtl.signal });
    if (!res.ok) throw new Error(res.status === 403 || res.status === 429 ? 'busy' : 'down');
    const j = await res.json();
    const out = (j.results || []).filter(r => r.kind === 'song').map(r => ({
      id: String(r.trackId), title: r.trackName, artist: r.artistName, album: r.collectionName, genre: r.primaryGenreName,
      dur: r.trackTimeMillis, explicit: r.trackExplicitness === 'explicit',
      art: (r.artworkUrl100 || '').replace('100x100bb', '200x200bb'), preview: r.previewUrl, url: r.trackViewUrl
    }));
    cache.set(q, out);
    return out;
  }
  function wireSearch(input, box, onResults) {
    let t, last = '';
    const run = async () => {
      const q = input.value.trim();
      if (q === last) return;
      last = q;
      if (q.length < 2) { onResults(null); return; }
      onResults('loading');
      try { const r = await searchCatalog(q); if (input.value.trim() === q) onResults(r); }
      catch (e) {
        if (e.name === 'AbortError') return;
        last = '';
        onResults(e.message === 'busy' ? 'busy' : 'error');
      }
    };
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 550); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(t); input.blur(); run(); } });
  }
  function resultsState(state) {
    if (state === 'loading') return '<div class="empty"><span class="spin"></span></div>';
    if (state === 'busy') return '<div class="empty">Search is busy with everyone on the same Wi-Fi. Give it a few seconds and hit search again.</div>';
    if (state === 'error') return '<div class="empty">Search did not go through. Check your connection and try again.</div>';
    return '<div class="empty">Nothing found. Try the song name plus the artist.</div>';
  }

  // =====================================================================
  // HOST
  // =====================================================================
  function startHost(name, resume) {
    app.role = 'host';
    const saved = store.get('djpal.party', null);
    app.party = resume && saved ? saved : DJQ.createParty(name);
    if (!resume) store.set('djpal.party', app.party);
    app.code = (resume && store.get('djpal.code', null)) || genCode();
    show('#host');
    renderHost();
    openLobby(0);
    keepAwake();
    setInterval(broadcast, 30000); // waiting time slowly lifts older requests
    analyzeQueue();
  }

  function openLobby(tries) {
    const peer = new Peer(PREFIX + app.code, PEER_OPTS);
    app.peer = peer;
    let opened = false;
    peer.on('open', () => {
      opened = true; app.offline = false;
      store.set('djpal.code', app.code);
      history.replaceState(null, '', location.pathname + '?host=1');
      setBanner('#hBanner', '');
      setDot('#hDot', true);
      renderHost();
    });
    peer.on('connection', conn => {
      conn.on('open', () => app.conns.set(conn.peer, conn));
      conn.on('data', m => onGuestMsg(conn, m));
      conn.on('close', () => { app.conns.delete(conn.peer); app.tokenOf.delete(conn.peer); });
      conn.on('error', () => {});
    });
    peer.on('disconnected', () => { setDot('#hDot', false); if (!peer.destroyed) setTimeout(() => { try { peer.reconnect(); } catch (e) { /* noop */ } }, 1500); });
    peer.on('error', e => {
      if (e.type === 'unavailable-id' && !opened) {
        // After a refresh the old code can stay reserved for a bit. Keep trying the same code so the QR people already scanned still works.
        peer.destroy();
        if (tries < 6) { setBanner('#hBanner', 'Reclaiming code ' + app.code + '... <span class="spin"></span>'); setTimeout(() => openLobby(tries + 1), 4000); }
        else { app.code = genCode(); toast('New party code: ' + app.code); openLobby(0); }
        return;
      }
      if (!opened && ['network', 'server-error', 'socket-error', 'socket-closed', 'browser-incompatible'].includes(e.type)) {
        app.offline = true; setDot('#hDot', false);
        setBanner('#hBanner', 'Could not reach the online lobby, so guests cannot join right now. You can still use the queue yourself. <button class="btn sm" onclick="location.reload()">Retry</button>');
        return;
      }
      if (e.type === 'network' || e.type === 'socket-closed') setDot('#hDot', false);
    });
  }

  function onGuestMsg(conn, m) {
    if (!m || typeof m !== 'object') return;
    const p = app.party;
    if (m.t === 'hello') {
      const tk = String(m.token || '').slice(0, 40) || conn.peer;
      app.tokenOf.set(conn.peer, tk);
      DJQ.addGuest(p, tk, m.name);
      save(); sendView(conn); renderHost();
      return;
    }
    const tk = app.tokenOf.get(conn.peer);
    if (!tk) return;
    let r = { ok: true };
    if (m.t === 'req') { r = DJQ.request(p, tk, m.track); if (r.ok) { const g = p.guests[tk]; toast((g ? g.name : 'Someone') + ' requested ' + (p.queue.find(q => q.id === r.id) || {}).title); } }
    else if (m.t === 'vote') r = DJQ.vote(p, tk, m.id, !!m.on);
    else return;
    if (m.t === 'req') conn.send({ t: 'msg', ok: r.ok, msg: r.msg });
    else if (!r.ok) conn.send({ t: 'msg', ok: false, msg: r.msg });
    changed();
  }

  function sendView(conn) {
    const tk = app.tokenOf.get(conn.peer);
    if (!tk || !conn.open) return;
    try { conn.send({ t: 'view', v: DJQ.viewFor(app.party, tk) }); } catch (e) { /* closed */ }
  }
  function broadcast() { if (app.role === 'host') app.conns.forEach(sendView); }
  function save() { store.set('djpal.party', app.party); }
  function changed() { save(); broadcast(); renderHost(); analyzeQueue(); }

  // ---------- mixing analysis (host only) ----------
  let analyzing = false;
  const failed = new Set();
  async function analyzeQueue() {
    if (analyzing || !window.DJAnalyze) return;
    const p = app.party;
    const todo = [p.now].concat(DJQ.rank(p)).filter(q => q && !q.a && q.preview && !failed.has(q.id));
    if (!todo.length) return;
    analyzing = true;
    const q = todo[0];
    try {
      let a = store.get('djpal.a.' + q.id, null);
      if (!a) { a = await DJAnalyze.analyzeUrl(q.preview); store.set('djpal.a.' + q.id, a); }
      DJQ.setAnalysis(p, q.id, a);
      save(); renderHost(); broadcast();
    } catch (e) { failed.add(q.id); }
    analyzing = false;
    setTimeout(analyzeQueue, 50);
  }

  // ---------- host rendering ----------
  function aTags(a, from) {
    if (!a) return '<span class="tag">reading BPM and key...</span>';
    let s = '<span class="tag b">' + Math.round(a.bpm) + ' BPM</span><span class="tag k">' + esc(a.camelot) + ' · ' + esc(a.key) + '</span><span class="tag">Energy ' + a.energy + '</span>';
    const c = from ? DJQ.compat(from, a) : null;
    if (c) s += '<span class="tag ' + (c.score >= 4 ? 'ok' : c.score >= 2 ? 'meh' : 'bad') + '">' + esc(c.label) + '</span>';
    return s;
  }
  function deckTag(q) {
    return loadedOn[q.id] ? '<span class="tag ok">On Deck ' + loadedOn[q.id] + '</span>' : '';
  }
  function handoff(q, big) {
    const sz = big ? '' : ' sm';
    const yt = 'https://music.youtube.com/search?q=' + encodeURIComponent(searchText(q));
    if (BR) return deckButtons(q, big) + '<button class="btn' + sz + ' ghost" data-copy="' + esc(q.id) + '">Copy</button>';
    return '<button class="btn' + sz + '" data-copy="' + esc(q.id) + '">Copy for djay</button>' +
      (q.url ? '<a class="btn' + sz + '" href="' + esc(q.url) + '" target="_blank" rel="noopener">Apple Music</a>' : '') +
      '<a class="btn' + sz + '" href="' + esc(yt) + '" target="_blank" rel="noopener">YT Music</a>';
  }
  function renderHost() {
    const p = app.party;
    if (!p) return;
    $('#hParty').textContent = p.name;
    const gN = Object.keys(p.guests).length, live = app.conns.size;
    $('#hGuests').textContent = gN + (gN === 1 ? ' guest' : ' guests') + (live ? ' · ' + live + ' connected' : '');
    $('#hCode').textContent = $('#hCode2').textContent = $('#tvCode').textContent = app.code || '----';
    $('#hUrl').textContent = BASE.replace(/^https?:\/\//, '');
    const qr = app.code ? qrSvg(inviteUrl()) : '';
    if ($('#hQr').dataset.code !== app.code) { $('#hQr').innerHTML = qr; $('#tvQr').innerHTML = qr; $('#hQr').dataset.code = app.code; }

    const from = p.now && p.now.a;
    // Now playing
    $('#hNow').innerHTML = p.now
      ? '<div class="label"><span class="eq"><i></i><i></i><i></i></span> Now playing</div>' +
        '<div class="now"><img class="art lg" src="' + esc(p.now.art) + '" alt=""><div class="grow"><div class="t" style="font-size:18px">' + esc(p.now.title) + '</div><div class="a">' + esc(p.now.artist) + ' · asked by ' + esc(p.now.byName) + '</div><div class="tags">' + aTags(p.now.a) + '</div></div></div>' +
        '<div class="acts"><button class="btn hot" data-act="next">Next song</button>' + handoff(p.now) + '</div>'
      : '<div class="label">Now playing</div><div class="now"><div class="grow"><div class="t">Nothing marked as playing</div><div class="a">Start the top request when you are ready, or just let the queue fill up.</div></div></div>' +
        (p.queue.length ? '<div class="acts"><button class="btn hot" data-act="next">Start the top request</button></div>' : '');

    // Up next
    const nx = DJQ.pickNext(p);
    $('#hNext').innerHTML = nx
      ? '<div class="label">Up next</div><div class="now"><img class="art lg" src="' + esc(nx.art) + '" alt=""><div class="grow"><div class="t" style="font-size:17px">' + esc(nx.title) + '</div><div class="a">' + esc(nx.artist) + ' · ' + nx.votes.length + (nx.votes.length === 1 ? ' vote' : ' votes') + ' · ' + esc(nx.byName) + '</div><div class="tags">' + deckTag(nx) + aTags(nx.a, from) + '</div><div class="why">' + esc(nx.why) + '</div></div></div>' +
        '<div class="acts">' + handoff(nx, true) + '<button class="btn ghost" data-veto="' + esc(nx.id) + '">Skip it</button></div>'
      : '<div class="label">Up next</div><div class="empty">No requests yet. Put the party screen up and they will roll in.</div>';

    // Queue
    const r = DJQ.rank(p).filter(q => !nx || q.id !== nx.id);
    $('#hCount').textContent = p.queue.length;
    $('#hQueue').innerHTML = r.length ? r.map((q, i) =>
      '<div class="item hitem"><div class="rank">' + (i + 2) + '</div><img class="art" src="' + esc(q.art) + '" alt=""><div class="grow">' +
      '<div class="t">' + esc(q.title) + (q.explicit ? ' <span class="tag e">E</span>' : '') + '</div><div class="a">' + esc(q.artist) + ' · ' + q.votes.length + (q.votes.length === 1 ? ' vote' : ' votes') + ' · ' + esc(q.byName) + '</div>' +
      '<div class="tags">' + deckTag(q) + aTags(q.a, from) + '</div>' +
      '<div class="acts"><button class="btn sm" data-play="' + esc(q.id) + '">Play now</button>' + (BR ? deckButtons(q, false) : '<button class="btn sm" data-copy="' + esc(q.id) + '">Copy for djay</button>') + '<button class="btn sm" data-boost="' + esc(q.id) + '">Bump up</button><button class="btn sm ghost" data-veto="' + esc(q.id) + '" style="color:var(--red)">Remove</button></div>' +
      '</div></div>').join('') : '<div class="empty">' + (nx ? 'Just the one so far.' : 'Empty.') + '</div>';

    // Settings
    document.querySelectorAll('[data-set]').forEach(b => b.classList.toggle('on', !!p.settings[b.dataset.set]));
    $('#maxPer').textContent = p.settings.maxPerGuest;

    // Played
    $('#hPlayedN').textContent = p.played.length;
    $('#hPlayed').innerHTML = p.played.length ? p.played.slice(0, 15).map(q => '<div class="item"><img class="art" src="' + esc(q.art) + '" alt=""><div class="grow"><div class="t">' + esc(q.title) + '</div><div class="a">' + esc(q.artist) + '</div></div></div>').join('') : '<div class="empty">Nothing yet.</div>';

    renderTv(nx, r);
    renderBridge();
  }

  function renderTv(nx, rest) {
    const p = app.party;
    $('#tvNow').innerHTML = p.now ? '<div class="label"><span class="eq"><i></i><i></i><i></i></span> Now playing</div><div class="now"><img class="art lg" src="' + esc(p.now.art) + '" alt=""><div class="grow"><div class="t" style="font-size:22px">' + esc(p.now.title) + '</div><div class="a" style="font-size:16px">' + esc(p.now.artist) + '</div></div></div>' : '';
    const list = (nx ? [nx] : []).concat(rest || []).slice(0, 5);
    $('#tvQueue').innerHTML = list.length ? list.map((q, i) => '<div class="item"><div class="rank">' + (i + 1) + '</div><img class="art" src="' + esc(q.art) + '" alt=""><div class="grow"><div class="t">' + esc(q.title) + '</div><div class="a">' + esc(q.artist) + ' · ' + esc(q.byName) + '</div></div><div class="vote"><span>' + q.votes.length + '</span><small>VOTES</small></div></div>').join('') : '<div class="empty" style="text-align:left;padding-left:0">Be the first request.</div>';
  }

  function hostClick(e) {
    const b = e.target.closest('button,a');
    if (!b || app.role !== 'host') return;
    const p = app.party, d = b.dataset;
    if (d.act === 'next') { DJQ.next(p); changed(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (d.play) { DJQ.play(p, d.play); changed(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    if (d.veto) { DJQ.veto(p, d.veto); changed(); return; }
    if (d.boost) { DJQ.boost(p, d.boost, 10); changed(); toast('Bumped up a vote\'s worth'); return; }
    if (d.bridge === 'setup') { if (BR) BR.setup(); return; }
    if (d.load && BR) {
      const q = (p.now && p.now.id === d.load) ? p.now : p.queue.find(x => x.id === d.load);
      if (!q) return;
      const key = q.id + ':' + d.deck;
      pendingLoad[key] = true;
      renderHost();
      setTimeout(() => { if (pendingLoad[key]) { delete pendingLoad[key]; renderHost(); } }, 20000);
      BR.load(JSON.stringify({ id: key, query: searchText(q), title: cleanTitle(q.title), deck: Number(d.deck) }));
      return;
    }
    if (d.copy) {
      const q = (p.now && p.now.id === d.copy) ? p.now : p.queue.find(x => x.id === d.copy);
      if (q) copy(searchText(q)).then(ok => toast(ok ? 'Copied "' + searchText(q) + '". Paste it in djay search.' : 'Could not copy. Type: ' + searchText(q)));
      return;
    }
    if (d.add) {
      const t = hostResults.find(x => x.id === d.add);
      if (t) { const r = DJQ.request(p, 'host', t); toast(r.msg); changed(); }
      return;
    }
    if (d.set) { p.settings[d.set] = !p.settings[d.set]; changed(); return; }
    if (d.step) { p.settings.maxPerGuest = Math.max(1, Math.min(10, p.settings.maxPerGuest + Number(d.step))); changed(); }
  }

  let hostResults = [];
  function renderHostResults(r) {
    const box = $('#hResults');
    if (r === null) { box.innerHTML = ''; hostResults = []; return; }
    if (!Array.isArray(r)) { box.innerHTML = resultsState(r); return; }
    hostResults = r;
    if (!r.length) { box.innerHTML = resultsState('none'); return; }
    box.innerHTML = r.slice(0, 12).map(t => '<div class="item"><img class="art" src="' + esc(t.art) + '" alt=""><div class="grow"><div class="t">' + esc(t.title) + (t.explicit ? ' <span class="tag e">E</span>' : '') + '</div><div class="a">' + esc(t.artist) + '</div></div><button class="btn sm" data-add="' + esc(t.id) + '">Add</button></div>').join('');
  }

  let wake = null;
  async function keepAwake() {
    try { if ('wakeLock' in navigator) { wake = await navigator.wakeLock.request('screen'); } } catch (e) { /* not allowed */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (app.role === 'host') { keepAwake(); if (app.peer && app.peer.disconnected && !app.peer.destroyed) { try { app.peer.reconnect(); } catch (e) { /* noop */ } } }
    if (app.role === 'guest' && (!app.conn || !app.conn.open)) connectGuest();
  });

  // =====================================================================
  // GUEST
  // =====================================================================
  let guestName = store.get('djpal.name', '');
  let retryT = null, everConnected = false;

  function startGuest(code) {
    app.role = 'guest'; app.code = code;
    history.replaceState(null, '', location.pathname + '?room=' + code);
    if (!guestName) { show('#hello'); $('#helloTitle').textContent = 'Joining party ' + code; setTimeout(() => $('#guestName').focus(), 50); return; }
    show('#guest');
    renderGuest();
    connectGuest();
  }

  function connectGuest() {
    clearTimeout(retryT);
    if (app.peer && !app.peer.destroyed) { try { app.peer.destroy(); } catch (e) { /* noop */ } }
    const peer = new Peer(PEER_OPTS);
    app.peer = peer;
    const giveUp = setTimeout(() => { if (!app.conn || !app.conn.open) { setDot('#gDot', false); retry(everConnected ? 'Lost the DJ. Reconnecting...' : 'Cannot reach party ' + app.code + ' yet. Make sure the code is right and the host has DJPal open. Retrying...'); } }, 12000);
    peer.on('open', () => {
      const conn = peer.connect(PREFIX + app.code, { reliable: true });
      app.conn = conn;
      conn.on('open', () => { clearTimeout(giveUp); conn.send({ t: 'hello', name: guestName, token }); });
      conn.on('data', m => {
        if (!m) return;
        if (m.t === 'view') { everConnected = true; app.view = m.v; setDot('#gDot', true); setBanner('#gBanner', ''); renderGuest(); }
        else if (m.t === 'msg') { toast(m.msg); }
      });
      conn.on('close', () => { setDot('#gDot', false); retry('Lost the DJ. Reconnecting...'); });
    });
    peer.on('error', e => {
      if (e.type === 'peer-unavailable') { clearTimeout(giveUp); setDot('#gDot', false); retry(everConnected ? 'The DJ page went to sleep. Waiting for it to come back...' : 'No party open with code ' + app.code + ' right now. Retrying...'); }
      else if (!app.conn || !app.conn.open) { clearTimeout(giveUp); retry('Connection trouble. Retrying...'); }
    });
  }
  function retry(msg) {
    setBanner('#gBanner', esc(msg) + ' <span class="spin"></span>');
    clearTimeout(retryT);
    retryT = setTimeout(connectGuest, 4000);
  }
  function gsend(m) {
    if (app.conn && app.conn.open) { app.conn.send(m); return true; }
    toast('Not connected to the DJ yet');
    return false;
  }

  function renderGuest() {
    const v = app.view;
    $('#gParty').textContent = v ? v.name : 'Party ' + app.code;
    if (!v) { $('#gNow').innerHTML = '<div class="empty"><span class="spin"></span> Connecting to the DJ...</div>'; $('#gQueue').innerHTML = ''; return; }
    $('#gSub').textContent = v.open ? 'Request a song, vote for the ones you want' : 'Requests are paused. You can still vote.';
    $('#gNow').innerHTML = v.now
      ? '<div class="label"><span class="eq"><i></i><i></i><i></i></span> Now playing</div><div class="now"><img class="art lg" src="' + esc(v.now.art) + '" alt=""><div class="grow"><div class="t" style="font-size:17px">' + esc(v.now.title) + '</div><div class="a">' + esc(v.now.artist) + ' · asked by ' + esc(v.now.byName) + '</div></div></div>'
      : '<div class="label">Now playing</div><div class="a">The DJ is warming up. Get your requests in.</div>';
    $('#gCount').textContent = v.queue.length;
    $('#gQueue').innerHTML = v.queue.length ? v.queue.map((q, i) =>
      '<div class="item"><div class="rank">' + (i + 1) + '</div><img class="art" src="' + esc(q.art) + '" alt=""><div class="grow"><div class="t">' + esc(q.title) + '</div><div class="a">' + esc(q.artist) + '</div>' +
      (q.mine ? '<div class="mine">Your request</div>' : '<div class="a" style="font-size:12px">' + esc(q.byName) + '</div>') + '</div>' +
      '<button class="vote' + (q.voted ? ' on' : '') + '" data-vote="' + esc(q.id) + '" data-on="' + (q.voted ? 0 : 1) + '"' + (q.mine ? ' disabled' : '') + '><span>' + (q.voted ? '♥ ' : '♡ ') + q.votes + '</span><small>' + (q.mine ? 'YOURS' : q.voted ? 'VOTED' : 'VOTE') + '</small></button></div>').join('')
      : '<div class="empty">Nobody has asked for anything yet. You go first.</div>';
    $('#gLeft').textContent = v.open ? (v.left ? 'You can request ' + v.left + ' more right now.' : 'You have ' + v.max + ' songs waiting. Vote others up until one plays.') : '';
    if (lastResults) renderGuestResults(lastResults);
  }

  let lastResults = null;
  function renderGuestResults(r) {
    lastResults = r;
    const box = $('#gResults');
    if (r === null) { box.classList.add('hide'); box.innerHTML = ''; return; }
    box.classList.remove('hide');
    if (!Array.isArray(r)) { box.innerHTML = resultsState(r); return; }
    if (!r.length) { box.innerHTML = resultsState('none'); return; }
    const v = app.view || { queue: [], playedIds: [], now: null, explicit: true };
    box.innerHTML = '<div class="label">Results</div><div class="list">' + r.slice(0, 12).map(t => {
      const inQ = v.queue.find(q => q.id === t.id);
      const playing = v.now && v.now.id === t.id;
      const played = (v.playedIds || []).includes(t.id);
      const blocked = !v.explicit && t.explicit;
      let btn;
      if (playing) btn = '<span class="tag ok">Playing</span>';
      else if (inQ) btn = inQ.voted || inQ.mine ? '<span class="tag ok">In queue</span>' : '<button class="btn sm" data-vote="' + esc(t.id) + '" data-on="1">♡ Vote</button>';
      else if (played) btn = '<span class="tag">Played</span>';
      else if (blocked) btn = '<span class="tag e">Explicit off</span>';
      else btn = '<button class="btn sm hot" data-req="' + esc(t.id) + '">Request</button>';
      return '<div class="item"><img class="art" src="' + esc(t.art) + '" alt=""><div class="grow"><div class="t">' + esc(t.title) + (t.explicit ? ' <span class="tag e">E</span>' : '') + '</div><div class="a">' + esc(t.artist) + (t.dur ? ' · ' + fmtDur(t.dur) : '') + '</div></div>' + btn + '</div>';
    }).join('') + '</div>';
  }

  function guestClick(e) {
    const b = e.target.closest('button');
    if (!b || app.role !== 'guest') return;
    if (b.dataset.req) {
      const t = (lastResults || []).find(x => x.id === b.dataset.req);
      if (t && gsend({ t: 'req', track: t })) {
        b.disabled = true; b.textContent = 'Sent';
        setTimeout(() => { $('#gSearch').value = ''; renderGuestResults(null); $('#gQueue').scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 700);
      }
    } else if (b.dataset.vote) {
      gsend({ t: 'vote', id: b.dataset.vote, on: b.dataset.on === '1' });
    }
  }

  // ---------- shared ----------
  function setDot(sel, on) { const d = $(sel); if (d) d.classList.toggle('off', !on); }
  function setBanner(sel, html) { $(sel).innerHTML = html ? '<div class="banner">' + html + '</div>' : ''; }

  // ---------- boot ----------
  function boot() {
    document.addEventListener('click', e => { hostClick(e); guestClick(e); });
    wireSearch($('#gSearch'), $('#gResults'), renderGuestResults);
    wireSearch($('#hSearch'), $('#hResults'), renderHostResults);

    $('#startBtn').onclick = () => {
      const old = store.get('djpal.party', null);
      if (old && (old.queue.length || old.played.length) && !confirm('Start a fresh party? The last one had ' + (old.queue.length + old.played.length) + ' songs. Cancel keeps it.')) { startHost(old.name, true); return; }
      store.del('djpal.code');
      startHost($('#partyName').value.trim() || 'The Party', false);
    };
    const join = () => {
      const c = $('#joinCode').value.trim().toUpperCase().replace(/[^A-Z]/g, '');
      if (c.length !== 4) { $('#landErr').textContent = 'Codes are 4 letters.'; return; }
      startGuest(c);
    };
    $('#joinBtn').onclick = join;
    $('#joinCode').addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
    const hello = () => {
      const n = $('#guestName').value.trim();
      if (!n) { $('#helloErr').textContent = 'Name please. First name is fine.'; return; }
      guestName = n.slice(0, 24); store.set('djpal.name', guestName);
      startGuest(app.code);
    };
    $('#helloBtn').onclick = hello;
    $('#guestName').addEventListener('keydown', e => { if (e.key === 'Enter') hello(); });

 if (BR) {
      $('#tvBtn').insertAdjacentHTML('beforebegin', '<button class="btn sm" data-bridge="setup">Bridge</button>');
      $('#djayTip').innerHTML = '<b>With djay:</b> tap <b>Deck 1</b> or <b>Deck 2</b> on any song and DJPal loads it in djay for you. Guests stay connected while you are in djay. If a load misses, open Bridge and teach the buttons again.';
    }
    $('#tvBtn').onclick = () => { $('#tv').classList.remove('hide'); renderHost(); };
    $('#tvClose').onclick = () => $('#tv').classList.add('hide');
    $('#copyLink').onclick = () => copy(inviteUrl()).then(ok => toast(ok ? 'Invite link copied' : inviteUrl()));
    $('#endBtn').onclick = () => {
      if (!confirm('End the party? The queue and history are cleared.')) return;
      store.del('djpal.party'); store.del('djpal.code');
      try { app.peer && app.peer.destroy(); } catch (e) { /* noop */ }
      location.href = location.pathname;
    };

    const qs = new URLSearchParams(location.search);
    const room = (qs.get('room') || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (room.length === 4) { startGuest(room); return; }
    if (qs.get('host') && store.get('djpal.party', null)) { startHost('', true); return; }
    if (!BR && /Android/i.test(navigator.userAgent)) $('#getApp').classList.remove('hide');
    const old = store.get('djpal.party', null);
    if (old) $('#startBtn').textContent = 'Start a party (or resume ' + old.name + ')';
    show('#landing');
  }

  if (typeof Peer === 'undefined') {
    document.body.innerHTML = '<div class="wrap"><div class="banner" style="margin-top:40px">Could not load the connection library. Check your internet and reload.</div></div>';
    return;
  }
  boot();
})();
