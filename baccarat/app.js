/* Baccarat 5 Treasures: host-authoritative table over PeerJS, same as the other Game Night tables. No server. */
(() => {
  'use strict';

  const B = window.BAC;
  const PEER_OPTS = {
    debug: 1,
    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }] }
  };
  const PREFIX = 'gn-bacc-v1-';
  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const CHIPS = [5, 10, 25, 100, 500, 1000];
  const REACTS = ['🔥', '🙏', '😭', '😂', '🤑'];
  const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };

  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => { n = Number(n) || 0; const r = Math.round(n * 100) / 100; return Number.isInteger(r) ? r.toLocaleString('en-US') : r.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  const sgn = n => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage off */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* noop */ } }
  };
  const rng = () => { try { return crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296; } catch (e) { return Math.random(); } };
  const BASE = location.origin + location.pathname.replace(/index\.html$/, '');

  let token = store.get('bacc.token', null);
  if (!token) { token = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set('bacc.token', token); }

  const app = {
    role: null, room: null, view: null, me: null, code: null,
    peer: null, conns: new Map(), tokenOf: new Map(), conn: null, offline: false,
    chip: store.get('bacc.chip', 25), betEnds: 0, seen: { no: -1, keys: new Set() }, timers: [], lastSave: 0
  };

  // ---------- small UI helpers ----------
  let toastT;
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600); }
  function genCode() { let s = ''; for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(rng() * CODE_CHARS.length)]; return s; }
  function qrSvg(text) {
    if (typeof qrcode !== 'function') return '<div style="width:132px;height:132px;display:grid;place-items:center;color:#000;font-size:12px">QR unavailable</div>';
    const q = qrcode(0, 'M'); q.addData(text); q.make();
    return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }
  const inviteUrl = () => BASE + '?room=' + app.code;
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (er) { /* noop */ } ta.remove(); return ok;
    }
  }
  function banner(html) { const b = $('#banner'); b.innerHTML = html || ''; b.classList.toggle('hide', !html); }
  function setDot(on) { $('#netDot').classList.toggle('on', !!on); }
  let wake = null;
  async function keepAwake() { try { if ('wakeLock' in navigator && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch (e) { /* not allowed */ } }
  function later(fn, ms) { const id = setTimeout(fn, ms); app.timers.push(id); return id; }

  // =====================================================================
  // HOST: runs the table
  // =====================================================================
  function startHost(name, resume) {
    app.role = 'host';
    const saved = store.get('bacc.room', null);
    let room;
    if (resume && saved && saved.v === 1) {
      room = saved;
      for (const s of room.seats) if (!s.bot && s.token !== token) s.connected = false;
    } else {
      room = B.createRoom(name + "'s table", {}, rng);
      B.join(room, { token, name, host: true });
    }
    room._rng = rng;
    app.room = room;
    app.code = (resume && store.get('bacc.code', null)) || genCode();
    store.set('bacc.code', app.code);
    store.set('bacc.room', room);
    showTable();
    openLobby(0);
    keepAwake();
    setInterval(hostTick, 250);
    // Pick up where a refresh left off.
    if (room.phase === 'dealing') { while (!B.revealNext(room)); finishHand(); }
    else if (room.phase === 'result') later(nextHand, 3000);
    else if (room.phase === 'betting') { room.deadline = Math.max(room.deadline, Date.now() + 10000); scheduleBots(); }
    publish();
  }

  function openLobby(tries) {
    if (typeof Peer === 'undefined') { offlineHost(); return; }
    const peer = new Peer(PREFIX + app.code, PEER_OPTS);
    app.peer = peer;
    let opened = false;
    peer.on('open', () => {
      opened = true; app.offline = false;
      history.replaceState(null, '', location.pathname + '?host=1');
      banner(''); setDot(true); render();
    });
    peer.on('connection', conn => {
      conn.on('open', () => app.conns.set(conn.peer, conn));
      conn.on('data', m => onGuestMsg(conn, m));
      conn.on('close', () => dropConn(conn.peer));
      conn.on('error', () => {});
    });
    peer.on('disconnected', () => { setDot(false); if (!peer.destroyed) setTimeout(() => { try { peer.reconnect(); } catch (e) { /* noop */ } }, 1500); });
    peer.on('error', e => {
      if (e.type === 'unavailable-id' && !opened) {
        // After a refresh the old code stays reserved for a bit. Keep trying it so the link people have still works.
        peer.destroy();
        if (tries < 6) { banner('Reclaiming table code ' + app.code + '... <span class="spin"></span>'); setTimeout(() => openLobby(tries + 1), 4000); }
        else { app.code = genCode(); store.set('bacc.code', app.code); toast('New table code: ' + app.code); openLobby(0); }
        return;
      }
      if (!opened && ['network', 'server-error', 'socket-error', 'socket-closed', 'browser-incompatible'].includes(e.type)) offlineHost();
    });
  }
  function offlineHost() {
    app.offline = true; setDot(false);
    banner('Cannot reach the online lobby right now, so friends cannot join. You can still play against bots. <b id="retryNet" style="text-decoration:underline;cursor:pointer">Retry</b>');
    const r = $('#retryNet'); if (r) r.onclick = () => { banner('Connecting... <span class="spin"></span>'); try { app.peer && app.peer.destroy(); } catch (e) { /* noop */ } openLobby(0); };
    render();
  }

  function dropConn(pid) {
    const tk = app.tokenOf.get(pid);
    app.conns.delete(pid); app.tokenOf.delete(pid);
    if (!tk || !app.room) return;
    // Only mark them away if they have no other live connection.
    if ([...app.tokenOf.values()].includes(tk)) return;
    const s = B.seatByToken(app.room, tk);
    if (s) { s.connected = false; publish(); }
  }

  function onGuestMsg(conn, m) {
    if (!m || typeof m !== 'object' || !app.room) return;
    const room = app.room;
    if (m.t === 'hello') {
      const tk = String(m.token || '').slice(0, 40) || conn.peer;
      app.tokenOf.set(conn.peer, tk);
      if (tk === token) { conn.send({ t: 'err', msg: 'This device is already the host.' }); return; }
      const r = B.join(room, { token: tk, name: String(m.name || '').slice(0, 16) });
      if (!r.ok) conn.send({ t: 'err', msg: r.msg + ' You can watch.' });
      publish();
      return;
    }
    const tk = app.tokenOf.get(conn.peer);
    const seat = tk && B.seatByToken(room, tk);
    if (m.t === 'react') { if (seat && REACTS.includes(m.e)) relayReact(seat.id, m.e); return; }
    if (!seat) { conn.send({ t: 'err', msg: 'You are watching this table.' }); return; }
    const r = act(seat.id, m);
    if (!r.ok && r.msg) conn.send({ t: 'err', msg: r.msg });
    publish();
  }

  // Every seat action, from the host's own taps or a guest's message.
  function act(id, m) {
    const room = app.room;
    let r = { ok: false };
    switch (m.t) {
      case 'bet': r = B.placeBet(room, id, m.spot, m.amt); break;
      case 'undo': r = B.undo(room, id); break;
      case 'clear': r = B.clearBets(room, id); break;
      case 'rebet': r = B.rebet(room, id, 1); break;
      case 'double': {
        const s = B.seatOf(room, id);
        if (s && B.sumBets(s.bets)) {
          const cur = Object.assign({}, s.bets);
          r = { ok: true };
          for (const k of B.MAIN.concat(B.SIDE)) if (cur[k]) { const x = B.placeBet(room, id, k, cur[k]); if (!x.ok) { r = x; break; } }
        } else r = B.rebet(room, id, 2);
        break;
      }
      case 'ready': r = B.setReady(room, id, !!m.on); break;
      case 'rebuy': r = B.rebuy(room, id); break;
    }
    // Give people a few seconds after any change before the clock deals.
    if (r.ok && room.phase === 'betting' && ['bet', 'rebet', 'double'].includes(m.t)) room.deadline = Math.max(room.deadline, Date.now() + 6000);
    return r;
  }

  function relayReact(id, e) {
    for (const c of app.conns.values()) { try { c.open && c.send({ t: 'react', id, e }); } catch (er) { /* closed */ } }
    showReact(id, e);
  }

  function hostTick() {
    const room = app.room;
    if (!room || room.phase !== 'betting') return;
    if (B.dealDue(room, Date.now())) beginDeal();
  }

  function beginDeal() {
    const room = app.room;
    if (!B.startDeal(room).ok) return;
    publish();
    const step = () => {
      const done = B.revealNext(room);
      publish();
      if (done) { later(finishHand, 1000); return; }
      const nextKey = room.hand.order[room.hand.shown];
      later(step, nextKey && nextKey.endsWith('2') ? 1650 : 700);
    };
    later(step, 450);
  }

  function finishHand() {
    const room = app.room;
    const res = B.settle(room);
    publish(true);
    later(nextHand, res.labels.length ? 7000 : 5200);
  }

  function nextHand() {
    const room = app.room;
    const r = B.openBetting(room, Date.now());
    if (r.newShoe) { toastAll('Cut card came out. Fresh shoe, new road.'); }
    publish(true);
    scheduleBots();
  }

  function toastAll(msg) {
    for (const c of app.conns.values()) { try { c.open && c.send({ t: 'err', msg }); } catch (e) { /* closed */ } }
    toast(msg);
  }

  function scheduleBots(only) {
    const room = app.room;
    const hand = room.handNo;
    for (const s of room.seats) {
      if (!s.bot || s.ready) continue;
      if (only && s.id !== only) continue;
      const plan = B.botPlan(room, s, rng);
      let t = 1200 + rng() * 5000;
      for (const [k, a] of plan) {
        later(() => { if (room.phase === 'betting' && room.handNo === hand && B.seatOf(room, s.id)) { B.placeBet(room, s.id, k, a); publish(); } }, t);
        t += 350 + rng() * 700;
      }
      later(() => { if (room.phase === 'betting' && room.handNo === hand && B.seatOf(room, s.id)) { B.setReady(room, s.id, true); publish(); } }, t + 300);
    }
  }

  function publish(save) {
    const room = app.room;
    const now = Date.now();
    const v = B.publicView(room, now);
    for (const [pid, c] of app.conns) {
      const tk = app.tokenOf.get(pid);
      const s = tk && B.seatByToken(room, tk);
      try { if (c.open) c.send({ t: 'state', v, me: s ? s.id : null }); } catch (e) { /* closed */ }
    }
    const mine = B.seatByToken(room, token);
    receive(v, mine ? mine.id : null);
    if (save || now - app.lastSave > 1500) { app.lastSave = now; store.set('bacc.room', room); }
  }

  // =====================================================================
  // GUEST
  // =====================================================================
  let everConnected = false, retryT = null;
  function startGuest(code, name) {
    app.role = 'guest'; app.code = code; app.name = name;
    history.replaceState(null, '', location.pathname + '?room=' + code);
    showTable();
    banner('Finding table ' + code + '... <span class="spin"></span>');
    connectGuest();
  }
  function retry(msg) {
    banner(esc(msg) + ' <span class="spin"></span>');
    clearTimeout(retryT); retryT = setTimeout(connectGuest, 3000);
  }
  function connectGuest() {
    if (typeof Peer === 'undefined') { banner('Could not load the connection library. Check your internet and refresh.'); return; }
    if (app.peer && !app.peer.destroyed) { try { app.peer.destroy(); } catch (e) { /* noop */ } }
    const peer = new Peer(PEER_OPTS);
    app.peer = peer;
    const giveUp = setTimeout(() => { if (!app.conn || !app.conn.open) { setDot(false); retry(everConnected ? 'Lost the table. Reconnecting...' : 'Cannot reach table ' + app.code + ' yet. Check the code and that the host has the table open. Retrying...'); } }, 12000);
    peer.on('open', () => {
      const conn = peer.connect(PREFIX + app.code, { reliable: true });
      app.conn = conn;
      // Own seat token for guests, so a host can also open a guest tab on the same device to test.
      conn.on('open', () => { clearTimeout(giveUp); everConnected = true; setDot(true); banner(''); conn.send({ t: 'hello', name: app.name, token: token + 'g' }); });
      conn.on('data', m => {
        if (!m) return;
        if (m.t === 'state') receive(m.v, m.me);
        else if (m.t === 'err') toast(m.msg);
        else if (m.t === 'react') showReact(m.id, m.e);
      });
      conn.on('close', () => { setDot(false); retry('Lost the host. Reconnecting...'); });
    });
    peer.on('error', e => {
      if (e.type === 'peer-unavailable') { clearTimeout(giveUp); setDot(false); retry(everConnected ? 'The host page went to sleep. Waiting for it to come back...' : 'No table open with code ' + app.code + ' right now. Retrying...'); }
      else if (!app.conn || !app.conn.open) { clearTimeout(giveUp); retry('Connection trouble. Retrying...'); }
    });
  }

  function send(m) {
    if (app.role === 'host') {
      const me = B.seatByToken(app.room, token);
      if (m.t === 'react') { if (me) relayReact(me.id, m.e); return; }
      if (!me) return;
      const r = act(me.id, m);
      if (!r.ok && r.msg) toast(r.msg);
      publish();
      return;
    }
    if (app.conn && app.conn.open) app.conn.send(m);
    else toast('Reconnecting to the table...');
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (app.role === 'host') { keepAwake(); if (app.peer && app.peer.disconnected && !app.peer.destroyed) { try { app.peer.reconnect(); } catch (e) { /* noop */ } } }
    if (app.role === 'guest' && (!app.conn || !app.conn.open)) connectGuest();
  });

  // =====================================================================
  // RENDER
  // =====================================================================
  function receive(v, me) {
    app.view = v; app.me = me;
    app.betEnds = Date.now() + (v.betLeft || 0);
    render();
  }

  const mySeat = () => app.view && app.me != null ? app.view.seats.find(s => s.id === app.me) : null;

  function showTable() {
    $('#landing').classList.add('hide');
    $('#table').classList.remove('hide');
    $('#setBtn').classList.toggle('hide', app.role !== 'host');
    $('#tCode').textContent = app.code || '----';
    renderChips();
  }

  function render() {
    const v = app.view;
    if (!v) return;
    const me = mySeat();
    $('#tName').textContent = v.name;
    $('#tCode').textContent = app.code;
    $('#tSub').textContent = v.handNo ? 'Hand ' + v.handNo + ' · Shoe ' + v.shoeNo + ' · ' + v.cardsLeft + ' cards' : '5 Treasures · ' + v.seats.length + '/' + B.MAX_SEATS + ' seats';
    $('#bOdds').textContent = v.settings.mode === 'nocomm' ? '1 : 1, 6 pays ½' : '0.95 : 1';
    renderRoad(v); renderLobby(v, me); renderStage(v); renderSeats(v); renderLayout(v, me); renderDock(v, me); renderStatus();
  }

  function renderRoad(v) {
    const cols = Math.max(12, Math.ceil((v.road.length + 1) / 6));
    let h = '';
    for (let i = 0; i < cols * 6; i++) {
      const r = v.road[i];
      h += r ? `<span class="bd ${r.w}${r.t ? ' tr' : ''}" title="Hand ${r.n}: Player ${r.pt}, Banker ${r.bt}">${r.w}</span>` : '<span class="bd e"></span>';
    }
    const el = $('#bead');
    el.innerHTML = '<div class="beadgrid">' + h + '</div>';
    el.scrollLeft = el.scrollWidth;
    const c = { P: 0, B: 0, T: 0 }; let tr = 0;
    v.road.forEach(r => { c[r.w]++; if (r.t) tr++; });
    $('#stats').innerHTML = `<span><i style="background:var(--bk)"></i>B ${c.B}</span><span><i style="background:var(--pl)"></i>P ${c.P}</span><span><i style="background:var(--tie)"></i>T ${c.T}</span><span><i style="background:var(--gold2)"></i>★ ${tr}</span>`;
  }

  function renderLobby(v, me) {
    const el = $('#lobby');
    let h = '';
    if (v.phase === 'lobby') {
      if (app.role === 'host') {
        h = `<h3>Table is open</h3><p>Send friends the code <b style="color:var(--gold2);letter-spacing:.15em">${esc(app.code)}</b> or the link. Add bots to fill seats, then start dealing. People can join between hands too.</p>
          <div class="row"><button class="btn ghost sm" data-do="invite">Invite</button><button class="btn ghost sm" data-do="bot">+ Add bot</button><button class="btn sm" data-do="start">Start dealing</button></div>`;
      } else {
        const host = v.seats.find(s => s.host);
        h = `<h3>You're at the table</h3><p>Waiting for ${esc(host ? host.name : 'the host')} to start dealing. ${v.seats.length} of ${B.MAX_SEATS} seats taken.</p>`;
      }
    } else if (!me && app.role === 'guest') {
      h = `<h3>Watching</h3><p>The table is full. You can watch the hands and jump in when a seat opens up (refresh then).</p>`;
    }
    el.innerHTML = h;
    el.classList.toggle('hide', !h);
  }

  function cardHtml(c, key, isNew, third) {
    const red = c[1] === 'h' || c[1] === 'd';
    const rk = c[0] === 'T' ? '10' : c[0];
    const cls = ['pc', third ? 'third' : '', isNew ? (third ? 'slow' : 'anim') : 'up'].join(' ');
    return `<div class="${cls}" data-k="${key}"><div class="k"></div><div class="f${red ? ' red' : ''}"><div><div class="rk">${rk}</div><div class="su">${SUIT[c[1]]}</div></div><div class="mid">${SUIT[c[1]]}</div><div class="br"><div class="rk">${rk}</div></div></div></div>`;
  }

  function renderStage(v) {
    const hand = v.hand;
    if (!hand) {
      app.seen = { no: -1, keys: new Set() };
      $('#cardsP').innerHTML = $('#cardsB').innerHTML = '<div class="pc ghost"></div><div class="pc ghost"></div>';
      $('#totP').textContent = $('#totB').textContent = '-';
    } else {
      if (app.seen.no !== hand.no) app.seen = { no: hand.no, keys: new Set() };
      for (const side of ['p', 'b']) {
        let h = '';
        hand[side].forEach((c, i) => {
          if (!c) return;
          const key = side + i;
          const isNew = !app.seen.keys.has(key);
          h += cardHtml(c, key, isNew, i === 2);
        });
        if (!h) h = '<div class="pc ghost"></div><div class="pc ghost"></div>';
        const box = side === 'p' ? $('#cardsP') : $('#cardsB');
        box.innerHTML = h;
        box.classList.toggle('n3', !!hand[side][2]);
        const shown = hand[side].filter(Boolean);
        (side === 'p' ? $('#totP') : $('#totB')).textContent = shown.length ? B.total(shown) : '-';
      }
      hand.p.forEach((c, i) => c && app.seen.keys.add('p' + i));
      hand.b.forEach((c, i) => c && app.seen.keys.add('b' + i));
    }
    const res = v.result;
    $('#sideP').classList.toggle('win', !!res && res.w === 'P');
    $('#sideB').classList.toggle('win', !!res && res.w === 'B');
    const rb = $('#resbar');
    if (res) {
      const key = 'r' + v.handNo;
      if (rb.dataset.k !== key) {
        rb.dataset.k = key;
        const word = res.w === 'P' ? 'Player wins' : res.w === 'B' ? 'Banker wins' : 'Tie';
        const score = res.w === 'B' ? res.bt + ' over ' + res.pt : res.w === 'P' ? res.pt + ' over ' + res.bt : res.pt + ' all';
        rb.innerHTML = `<div class="w ${res.w}">${word}<span style="font-family:Inter;font-size:12px;font-weight:600;opacity:.85">${score}${res.natural ? ' · natural' : ''}</span></div>` +
          (res.labels.length ? '<div class="treasure">' + res.labels.map(l => `<span>★ ${esc(l)}</span>`).join('') + '</div>' : '');
        rb.classList.remove('show'); void rb.offsetWidth; rb.classList.add('show');
        const me = mySeat();
        if (me && me.last && me.last.net > 0 && res.labels.length && navigator.vibrate) { try { navigator.vibrate([60, 40, 120]); } catch (e) { /* noop */ } }
      }
    } else { rb.classList.remove('show'); rb.dataset.k = ''; }
  }

  function betTags(bets) {
    return Object.keys(bets).map(k => `<i class="${B.MAIN.includes(k) ? k : 's'}">${k === 'P' || k === 'B' || k === 'T' ? k : k === 'CA' ? '★' : k} ${fmt(bets[k])}</i>`).join('');
  }

  function renderSeats(v) {
    const el = $('#seats');
    el.innerHTML = v.seats.map(s => {
      const delta = v.phase === 'result' && s.last ? `<span class="delta ${s.last.net > 0 ? 'up' : s.last.net < 0 ? 'dn' : ''}">${s.last.net ? sgn(s.last.net) : 'push'}</span>` : '';
      return `<div class="seat${s.id === app.me ? ' me' : ''}${!s.connected && !s.bot ? ' off' : ''}" data-seat="${s.id}">
        ${v.phase === 'betting' && s.ready ? '<span class="rdy"></span>' : ''}
        <div class="n">${s.host ? '★ ' : ''}${esc(s.name)}${s.bot ? ' <span class="tagbot">BOT</span>' : ''}</div>
        <div class="c"><span>${fmt(s.chips)}${!s.connected && !s.bot ? ' · away' : ''}</span>${delta}</div>
        <div class="bt">${betTags(s.bets)}</div></div>`;
    }).join('');
  }

  function renderLayout(v, me) {
    const res = v.result;
    const betting = v.phase === 'betting' && !!me;
    const hasMain = me && B.hasMain(me.bets);
    for (const el of $$('.spot')) {
      const k = el.dataset.spot;
      el.querySelectorAll('.stake,.others,.wonamt').forEach(x => x.remove());
      const mine = me && me.bets[k] || 0;
      const others = v.seats.filter(s => s.id !== app.me).reduce((a, s) => a + (s.bets[k] || 0), 0);
      if (mine) el.insertAdjacentHTML('beforeend', `<span class="stake">${fmt(mine)}</span>`);
      if (others && el.classList.contains('s') === false) el.insertAdjacentHTML('beforeend', `<span class="others">table ${fmt(others)}</span>`);
      let won = false, lost = false;
      if (res) {
        won = k === res.w || (k === 'F7' && res.tr.F7) || (k === 'G8' && res.tr.G8) || (k === 'H9' && res.tr.H9) || (k === 'B7' && res.tr.B7) || (k === 'CA' && res.tr.CA);
        lost = !won && !(res.w === 'T' && (k === 'P' || k === 'B'));
        if (me && me.last && me.last.spots[k] > 0) el.insertAdjacentHTML('beforeend', `<span class="wonamt">+${fmt(me.last.spots[k])}</span>`);
      }
      el.classList.toggle('won', won);
      el.classList.toggle('lost', !!res && lost);
      el.classList.toggle('dim', betting && el.classList.contains('s') && !hasMain);
      el.disabled = !betting;
    }
  }

  function renderChips() {
    const v = app.view;
    const min = v ? Math.min(v.settings.min, v.settings.sideMin) : 5;
    const list = CHIPS.filter(c => c >= min).slice(0, 5);
    if (!list.includes(app.chip)) app.chip = list[Math.min(1, list.length - 1)];
    $('#chips').innerHTML = list.map(c => `<button class="chip${c === app.chip ? ' sel' : ''}" data-v="${c}">${c >= 1000 ? (c / 1000) + 'K' : c}</button>`).join('');
  }

  function renderDock(v, me) {
    renderChips();
    const betting = v.phase === 'betting' && !!me;
    const staked = me ? B.sumBets(me.bets) : 0;
    $('#myChips').textContent = me ? fmt(me.chips) : '-';
    $('#myBet').textContent = staked ? (v.phase === 'result' ? 'Bet ' : 'On the table ') + fmt(staked) : '';
    const net = $('#myNet');
    if (me) { net.textContent = (me.net >= 0 ? 'Up ' : 'Down ') + fmt(Math.abs(me.net)); net.className = 'net ' + (me.net > 0 ? 'up' : me.net < 0 ? 'dn' : ''); } else net.textContent = '';
    $('#undoBtn').disabled = !betting || !staked;
    $('#clearBtn').disabled = !betting || !staked;
    $('#rebetBtn').disabled = !betting || !!staked || !me.hasLast;
    $('#dblBtn').disabled = !betting || (!staked && !me.hasLast);
    const rb = $('#readyBtn');
    const broke = me && me.chips + staked < v.settings.min;
    rb.disabled = false;
    if (!me) { rb.textContent = 'Watching'; rb.disabled = true; rb.dataset.do = ''; }
    else if (broke && !staked && v.phase !== 'dealing') { rb.textContent = 'Rebuy ' + fmt(v.settings.bankroll); rb.dataset.do = 'rebuy'; }
    else if (!betting) { rb.textContent = v.phase === 'dealing' ? 'No more bets' : v.phase === 'result' ? 'Next hand soon' : 'Waiting'; rb.disabled = true; rb.dataset.do = ''; }
    else if (staked) { rb.textContent = me.ready ? 'Ready ✓' : 'Deal'; rb.dataset.do = me.ready ? 'unready' : 'ready'; }
    else { rb.textContent = me.ready ? 'Sitting out' : 'Sit out'; rb.dataset.do = me.ready ? 'unready' : 'ready'; }
    rb.classList.toggle('ghost', !!(me && me.ready && betting));
    $('#reacts').classList.toggle('hide', !me);
  }

  function renderStatus() {
    const v = app.view;
    if (!v) return;
    const me = mySeat();
    const msg = $('#msg'), timer = $('#timer');
    let text = '', small = '';
    let showTimer = false;
    if (v.phase === 'lobby') { text = 'Waiting to start'; small = v.seats.length + ' at the table'; }
    else if (v.phase === 'betting') {
      const left = Math.max(0, app.betEnds - Date.now());
      const anyHuman = v.seats.some(s => !s.bot && B.sumBets(s.bets) > 0);
      const waitingOn = v.seats.filter(s => !s.bot && s.connected && !s.ready).map(s => s.id === app.me ? 'you' : s.name);
      if (!anyHuman && left <= 0) { text = 'Place a bet to deal'; small = 'Bots are waiting on a real player'; }
      else {
        showTimer = true;
        text = me && !B.sumBets(me.bets) ? 'Place your bets' : me && me.ready ? 'You are in' : 'Bets are open';
        small = waitingOn.length ? 'Waiting on ' + waitingOn.slice(0, 3).join(', ') + (waitingOn.length > 3 ? ' +' + (waitingOn.length - 3) : '') : 'Dealing when the clock runs out';
      }
      const secs = Math.ceil(left / 1000);
      $('#timerN').textContent = secs;
      const full = (v.settings.betSecs || 25) * 1000;
      $('#timerArc').style.strokeDashoffset = String(119.4 * (1 - Math.min(1, left / full)));
      $('#timerArc').style.stroke = secs <= 5 ? '#ff8080' : '#e3b341';
    } else if (v.phase === 'dealing') {
      const h = v.hand;
      text = 'No more bets';
      const next = h && h.order[h.shown];
      small = !h || h.shown < 4 ? 'Dealing' : next === 'p2' ? 'Player draws a third card' : next === 'b2' ? 'Banker draws a third card' : 'Turning cards';
    } else if (v.phase === 'result') {
      const r = v.result;
      if (me && me.last) { text = me.last.net > 0 ? 'You won ' + fmt(me.last.net) : me.last.net < 0 ? 'You lost ' + fmt(-me.last.net) : 'Push, money back'; }
      else text = r.w === 'P' ? 'Player wins' : r.w === 'B' ? 'Banker wins' : 'Tie';
      small = 'Next hand in a moment';
    }
    msg.innerHTML = esc(text) + (small ? '<small>' + esc(small) + '</small>' : '');
    timer.classList.toggle('hide', !showTimer);
  }
  setInterval(() => { if (app.view && app.view.phase === 'betting') renderStatus(); }, 250);

  function showReact(id, e) {
    const el = document.querySelector(`.seat[data-seat="${id}"]`);
    if (!el || !REACTS.includes(e)) return;
    // Float it in its own layer so seat redraws during betting do not wipe it.
    const r = el.getBoundingClientRect();
    const s = document.createElement('span'); s.className = 'react'; s.textContent = e;
    s.style.left = (r.left + r.width / 2) + 'px'; s.style.top = (r.top + 4) + 'px';
    document.body.appendChild(s); setTimeout(() => s.remove(), 1900);
  }

  // =====================================================================
  // MODALS
  // =====================================================================
  function openModal(html) { $('#sheet').innerHTML = html; $('#modal').classList.remove('hide'); }
  function closeModal() { $('#modal').classList.add('hide'); }
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal(); });

  function inviteModal() {
    const url = inviteUrl();
    openModal(`<h2>Invite <button class="x" data-close>✕</button></h2>
      <div class="qrbox"><div class="qr">${qrSvg(url)}</div><div><div class="bigcode">${esc(app.code)}</div><p style="font-size:13px;color:var(--muted);margin-top:4px">Scan, or open Baccarat on Game Night and type the code.</p></div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm" id="cpLink">Copy link</button>${navigator.share ? '<button class="btn ghost sm" id="shLink">Share</button>' : ''}</div>
      ${app.offline ? '<p style="margin-top:12px;color:var(--lose)">The online lobby is not reachable right now, so this link will not work until it reconnects.</p>' : ''}`);
    $('#cpLink').onclick = async () => toast((await copy(url)) ? 'Link copied' : url);
    const sh = $('#shLink'); if (sh) sh.onclick = () => navigator.share({ title: 'Baccarat 5 Treasures', text: 'Pull up a seat. Table ' + app.code, url }).catch(() => {});
  }

  function rulesModal() {
    const v = app.view;
    const nocomm = v && v.settings.mode === 'nocomm';
    openModal(`<h2>How it plays <button class="x" data-close>✕</button></h2>
      <p>Bet on which hand ends closer to 9: Player or Banker, or a Tie. Tens and face cards count 0, aces count 1, and only the last digit of the total counts (7 + 8 = 5). Nobody makes decisions after the bet. The cards are dealt by the fixed rules below.</p>
      <h4>Main bets</h4>
      <table class="pt"><tr><td>Player</td><td>1 to 1</td></tr>
      <tr><td>Banker</td><td>${nocomm ? '1 to 1, a winning 6 pays 1 to 2' : '1 to 1 less 5% commission'}</td></tr>
      <tr><td>Tie</td><td>8 to 1</td></tr></table>
      <p style="margin-top:8px">On a tie, Player and Banker bets push.</p>
      <h4>The 5 Treasures</h4>
      <table class="pt">
      <tr><td><b>Fortune 7</b>: Banker wins with a 3 card 7</td><td>40 to 1</td></tr>
      <tr><td><b>Golden 8</b>: Player wins with a 3 card 8</td><td>25 to 1</td></tr>
      <tr><td><b>Heavenly 9</b>: either hand ends on a 3 card 9</td><td>10 to 1</td></tr>
      <tr><td>Heavenly 9, both hands on 3 card 9s</td><td>75 to 1</td></tr>
      <tr><td><b>Blazing 7s</b>: both hands on 3 card 7s</td><td>200 to 1</td></tr>
      <tr><td>Blazing 7s, both hands on 2 card 7s</td><td>50 to 1</td></tr>
      <tr><td><b>Cover All</b>: any of the four above hits</td><td>6 to 1</td></tr></table>
      <p style="margin-top:8px">You need a Player, Banker or Tie bet down to play the Treasures. Blazing 7s needs both 7s to have the same number of cards. A Heavenly 9 counts whether the hand wins or not.</p>
      <h4>Drawing rules</h4>
      <ul><li>Either hand on 8 or 9 with two cards is a natural. Both stand.</li>
      <li>Player draws on 0 to 5 and stands on 6 or 7.</li>
      <li>If Player stood, Banker draws on 0 to 5.</li>
      <li>If Player drew, Banker goes by its total and Player's third card: 0 to 2 always draws. 3 draws unless the card is an 8. 4 draws on 2 to 7. 5 draws on 4 to 7. 6 draws on 6 or 7. 7 stands.</li></ul>
      <h4>House edge, 8 decks</h4>
      <div class="grid2"><table class="pt"><tr><td>Banker</td><td>${nocomm ? '1.46%' : '1.06%'}</td></tr><tr><td>Player</td><td>1.24%</td></tr><tr><td>Tie</td><td>14.36%</td></tr><tr><td>Cover All</td><td>2.97%</td></tr></table>
      <table class="pt"><tr><td>Fortune 7</td><td>7.61%</td></tr><tr><td>Golden 8</td><td>10.19%</td></tr><tr><td>Heavenly 9</td><td>9.31%</td></tr><tr><td>Blazing 7s</td><td>7.78%</td></tr></table></div>
      <p style="margin-top:8px;color:var(--muted);font-size:12px">Worked out exactly from every possible deal. 8 deck shoe, one burn card, cut card near the end, fresh road every shoe. Play money only.</p>`);
  }

  function settingsModal() {
    const room = app.room, st = room.settings;
    const seats = room.seats.map(s => `<div><span>${s.host ? '★ ' : ''}${esc(s.name)}${s.bot ? ' <span class="tagbot">BOT</span>' : ''}${!s.bot && !s.connected ? ' <span style="color:var(--muted)">away</span>' : ''} · ${fmt(s.chips)}</span>${s.token === token ? '' : `<button class="x" data-kick="${s.id}" title="Remove">✕</button>`}</div>`).join('');
    openModal(`<h2>Table settings <button class="x" data-close>✕</button></h2>
      <div class="field"><label>Table name</label><input id="sName" maxlength="28" value="${esc(room.name)}"></div>
      <div class="grid2">
        <div class="field"><label>Buy-in chips</label><input id="sBank" type="number" inputmode="numeric" value="${st.bankroll}"></div>
        <div class="field"><label>Bet clock (sec)</label><input id="sSecs" type="number" inputmode="numeric" value="${st.betSecs}"></div>
        <div class="field"><label>Main min</label><input id="sMin" type="number" inputmode="numeric" value="${st.min}"></div>
        <div class="field"><label>Main max</label><input id="sMax" type="number" inputmode="numeric" value="${st.max}"></div>
        <div class="field"><label>Treasure min</label><input id="sSMin" type="number" inputmode="numeric" value="${st.sideMin}"></div>
        <div class="field"><label>Treasure max</label><input id="sSMax" type="number" inputmode="numeric" value="${st.sideMax}"></div>
      </div>
      <div class="field"><label>Banker pays</label><select id="sMode"><option value="commission"${st.mode === 'commission' ? ' selected' : ''}>1 to 1 less 5% commission</option><option value="nocomm"${st.mode === 'nocomm' ? ' selected' : ''}>Commission free, a winning 6 pays half</option></select></div>
      <button class="btn" id="sSave" style="width:100%">Save</button>
      <h4>Seats ${room.seats.length}/${B.MAX_SEATS}</h4>
      <div class="seatlist">${seats}</div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button class="btn ghost sm" id="sBot"${room.seats.length >= B.MAX_SEATS ? ' disabled' : ''}>+ Add bot</button><button class="btn ghost sm" id="sInv">Invite</button><button class="btn ghost sm" id="sEnd" style="margin-left:auto;color:var(--lose)">Close table</button></div>
      <p style="margin-top:10px;font-size:12px;color:var(--muted)">Limit changes count from the next chip placed. A new buy-in amount applies to rebuys and new seats.</p>`);
    $('#sSave').onclick = () => {
      const n = id => Math.floor(Number($(id).value));
      const s = { bankroll: n('#sBank'), betSecs: n('#sSecs'), min: n('#sMin'), max: n('#sMax'), sideMin: n('#sSMin'), sideMax: n('#sSMax'), mode: $('#sMode').value };
      if (!(s.bankroll >= 10) || !(s.min >= 1) || !(s.max >= s.min) || !(s.sideMin >= 1) || !(s.sideMax >= s.sideMin) || !(s.betSecs >= 5 && s.betSecs <= 120)) { toast('Check the numbers: max at least min, clock 5 to 120 seconds.'); return; }
      Object.assign(room.settings, s);
      room.name = $('#sName').value.trim().slice(0, 28) || room.name;
      publish(true); closeModal(); toast('Table updated');
    };
    $('#sBot').onclick = () => { addBot(); settingsModal(); };
    $('#sInv').onclick = inviteModal;
    $('#sEnd').onclick = () => {
      if (!confirm('Close this table? Everyone gets disconnected and the chip counts are wiped.')) return;
      store.del('bacc.room'); store.del('bacc.code');
      try { app.peer && app.peer.destroy(); } catch (e) { /* noop */ }
      location.href = location.pathname;
    };
    $$('[data-kick]').forEach(b => b.onclick = () => {
      const r = B.removeSeat(room, Number(b.dataset.kick));
      if (!r.ok) toast(r.msg); else { publish(true); settingsModal(); }
    });
  }

  function addBot() {
    const r = B.addBot(app.room, rng);
    if (!r.ok) { toast(r.msg); return; }
    if (app.room.phase === 'betting') scheduleBots(r.seat.id);
    publish(true);
  }

  // =====================================================================
  // EVENTS
  // =====================================================================
  $('#layout').addEventListener('click', e => {
    const b = e.target.closest('.spot');
    if (!b || b.disabled) return;
    send({ t: 'bet', spot: b.dataset.spot, amt: app.chip });
  });
  $('#chips').addEventListener('click', e => {
    const c = e.target.closest('.chip'); if (!c) return;
    app.chip = Number(c.dataset.v); store.set('bacc.chip', app.chip); renderChips();
  });
  $('#undoBtn').onclick = () => send({ t: 'undo' });
  $('#clearBtn').onclick = () => send({ t: 'clear' });
  $('#rebetBtn').onclick = () => send({ t: 'rebet' });
  $('#dblBtn').onclick = () => send({ t: 'double' });
  $('#readyBtn').onclick = () => {
    const d = $('#readyBtn').dataset.do;
    if (d === 'ready') send({ t: 'ready', on: true });
    else if (d === 'unready') send({ t: 'ready', on: false });
    else if (d === 'rebuy') send({ t: 'rebuy' });
  };
  $('#reacts').addEventListener('click', e => { const b = e.target.closest('[data-e]'); if (b) send({ t: 'react', e: b.dataset.e }); });
  $('#lobby').addEventListener('click', e => {
    const b = e.target.closest('[data-do]'); if (!b || app.role !== 'host') return;
    if (b.dataset.do === 'invite') inviteModal();
    if (b.dataset.do === 'bot') addBot();
    if (b.dataset.do === 'start') { if (app.room.phase === 'lobby') nextHand(); }
  });
  $('#codeChip').onclick = () => inviteModal();
  $('#rulesBtn').onclick = rulesModal;
  $('#setBtn').onclick = settingsModal;

  // ---------- landing ----------
  function landing() {
    const params = new URLSearchParams(location.search);
    const name = store.get('bacc.name', '') || store.get('djpal.name', '') || '';
    $('#nm').value = name;
    const room = (params.get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    const saved = store.get('bacc.room', null), savedCode = store.get('bacc.code', null);
    if (saved && savedCode && saved.v === 1) {
      const rb = $('#resumeBtn');
      rb.textContent = 'Back to your table ' + savedCode + ' (hand ' + saved.handNo + ')';
      rb.classList.remove('hide');
      rb.onclick = () => startHost(saved.seats.find(s => s.host)?.name || name || 'Host', true);
      if (params.get('host') === '1') { startHost(saved.seats.find(s => s.host)?.name || 'Host', true); return; }
    }
    if (room) {
      $('#code').value = room;
      if (name) { startGuest(room, name); return; }
      $('#nm').focus();
    }
    const getName = () => { const n = $('#nm').value.trim().slice(0, 16); if (!n) { toast('Put your name in first'); $('#nm').focus(); return null; } store.set('bacc.name', n); return n; };
    $('#hostBtn').onclick = () => {
      const n = getName(); if (!n) return;
      if (saved && savedCode && !confirm('Start a new table? Your old table ' + savedCode + ' and its chip counts get wiped.')) return;
      store.del('bacc.room'); store.del('bacc.code');
      startHost(n, false);
    };
    const join = () => {
      const n = getName(); if (!n) return;
      const c = $('#code').value.toUpperCase().replace(/[^A-Z]/g, '');
      if (c.length !== 4) { toast('Table codes are 4 letters'); return; }
      startGuest(c, n);
    };
    $('#joinBtn').onclick = join;
    $('#code').addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
    $('#code').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); });
  }
  landing();
})();
