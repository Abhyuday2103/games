/* Craps: networking (PeerJS, host-authoritative) and UI */
(() => {
  'use strict';

  // Add a TURN server here if a friend on strict office or mobile Wi-Fi can never connect.
  const PEER_OPTS = {
    debug: 1,
    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }] }
  };
  const PREFIX = 'gn-craps-v1-';
  const { POINTS, ODDS_X, LAY_X, PLACE, HARD, PROPS, label } = CRAPS;
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => {
    const a = Math.abs(Math.round(n * 100) / 100);
    const s = Number.isInteger(a) ? a.toLocaleString() : a.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (n < 0 ? '-$' : '$') + s;
  };
  const signed = n => (n > 0 ? '+' : '') + money(n);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage off */ } }
  };

  let token = store.get('craps.token', null);
  if (!token) { token = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set('craps.token', token); }

  const app = {
    role: null, peer: null, table: null, conns: new Map(), conn: null, view: null, code: null,
    offline: false, chip: store.get('craps.chip', 5), take: false, lastRoll: -1, shakeT: null
  };

  // ---------- toast / banner ----------
  let toastT;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), 2800);
  }
  function banner(msg) {
    const b = $('#banner');
    if (!msg) { b.classList.add('hidden'); return; }
    b.innerHTML = msg; b.classList.remove('hidden');
  }

  // ---------- welcome ----------
  const params = new URLSearchParams(location.search);
  const roomParam = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  $('#nameIn').value = store.get('craps.name', '');
  if (roomParam) {
    $('#codeIn').value = roomParam;
    const n = $('#inviteNote');
    n.textContent = "You're invited to table " + roomParam + '. Enter your name and hit Join.';
    n.classList.remove('hidden');
    $('#hostCard').classList.add('hidden');
  }
  let startBank = 1000;
  $('#bankSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    startBank = +b.dataset.v;
    document.querySelectorAll('#bankSeg button').forEach(x => x.classList.toggle('on', x === b));
  });
  function getName() {
    const n = $('#nameIn').value.trim();
    if (!n) { $('#wErr').textContent = 'Enter your name first'; $('#nameIn').focus(); return null; }
    store.set('craps.name', n);
    return n;
  }
  $('#hostBtn').onclick = () => { const n = getName(); if (n) hostGame(n); };
  $('#joinBtn').onclick = () => {
    const n = getName(); if (!n) return;
    const c = $('#codeIn').value.trim().toUpperCase();
    if (c.length < 4) { $('#wErr').textContent = 'Enter the table code your host shared'; return; }
    joinGame(n, c);
  };
  $('#codeIn').addEventListener('keydown', e => { if (e.key === 'Enter') $('#joinBtn').click(); });
  $('#nameIn').addEventListener('keydown', e => { if (e.key === 'Enter') (roomParam ? $('#joinBtn') : $('#hostBtn')).click(); });

  function busy(on, msg) { $('#hostBtn').disabled = on; $('#joinBtn').disabled = on; $('#wErr').textContent = msg || ''; }
  function showGame() {
    $('#welcome').classList.add('hidden');
    $('#game').classList.remove('hidden');
    $('#codeOut').textContent = app.code || 'SOLO';
  }
  const genCode = () => {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = ''; for (let i = 0; i < 5; i++) s += A[Math.floor(Math.random() * A.length)];
    return s;
  };

  // ---------- host ----------
  function hostGame(name, tries = 0) {
    busy(true, 'Opening your table...');
    app.role = 'host';
    app.code = store.get('craps.hostCode', null) && tries === 0 ? store.get('craps.hostCode') : genCode();
    if (typeof Peer === 'undefined') {
      app.offline = true; app.code = null;
      app.table = new CRAPS.Table({ startBank, onChange: broadcast });
      app.table.join('host', name, token);
      showGame(); broadcast(); setNet(false);
      banner('Could not load the online lobby, so this table is <b>offline</b> (you plus computer players). Reload to try again.');
      return;
    }
    const peer = new Peer(PREFIX + app.code, PEER_OPTS);
    app.peer = peer;
    let opened = false;
    const startTable = () => {
      if (app.table) return;
      app.table = new CRAPS.Table({ startBank, onChange: broadcast });
      app.table.join('host', name, token);
      showGame();
      broadcast();
    };
    peer.on('open', () => {
      opened = true;
      store.set('craps.hostCode', app.code);
      history.replaceState(null, '', location.pathname + '?room=' + app.code);
      startTable();
      setNet(true);
    });
    peer.on('connection', conn => {
      conn.on('open', () => { app.conns.set(conn.peer, conn); });
      conn.on('data', m => onHostMsg(conn, m));
      conn.on('close', () => { app.conns.delete(conn.peer); if (app.table) app.table.disconnect(conn.peer); });
      conn.on('error', () => {});
    });
    peer.on('disconnected', () => { setNet(false); if (!peer.destroyed) setTimeout(() => peer.reconnect(), 1500); });
    peer.on('error', e => {
      if (e.type === 'unavailable-id' && !opened) {
        peer.destroy();
        if (tries < 4) { store.set('craps.hostCode', null); hostGame(name, tries + 1); }
        else busy(false, 'Could not reserve a table code. Try again.');
        return;
      }
      if (!opened && ['network', 'server-error', 'socket-error', 'socket-closed', 'browser-incompatible'].includes(e.type)) {
        app.offline = true; app.code = null;
        startTable(); setNet(false);
        banner('Could not reach the online lobby, so this table is <b>offline</b> (you plus computer players). Reload to try again.');
        return;
      }
      if (e.type === 'network' || e.type === 'socket-closed') setNet(false);
    });
  }
  function onHostMsg(conn, m) {
    if (!app.table || !m) return;
    if (m.t === 'join') {
      const i = app.table.join(conn.peer, m.name, m.token);
      if (i < 0) conn.send({ t: 'err', msg: 'All 8 spots at the rail are taken. You are watching for now.' });
      broadcast();
      return;
    }
    const err = app.table.command(conn.peer, m);
    if (err) conn.send({ t: 'err', msg: err });
  }
  function broadcast() {
    const t = app.table;
    if (!t) return;
    app.conns.forEach((c, id) => {
      if (c.open) { try { c.send({ t: 'state', v: t.view(t.seatOf(id)) }); } catch (e) { /* closed */ } }
    });
    app.view = t.view(t.seatOf('host'));
    render();
  }

  // ---------- guest ----------
  function joinGame(name, code) {
    busy(true, 'Connecting to table ' + code + '...');
    app.role = 'guest'; app.code = code;
    if (typeof Peer === 'undefined') { busy(false, 'Could not load the online lobby. Check your connection and reload.'); return; }
    const peer = new Peer(PEER_OPTS);
    app.peer = peer;
    let got = false;
    const fail = msg => { if (got) return; busy(false, msg); try { peer.destroy(); } catch (e) { /* noop */ } };
    const timer = setTimeout(() => fail('Could not reach table ' + code + '. Check the code, and make sure the host still has the page open.'), 15000);
    peer.on('open', () => {
      const conn = peer.connect(PREFIX + code, { reliable: true });
      app.conn = conn;
      conn.on('open', () => conn.send({ t: 'join', name, token }));
      conn.on('data', m => {
        if (!m) return;
        if (m.t === 'state') {
          if (!got) { got = true; clearTimeout(timer); history.replaceState(null, '', location.pathname + '?room=' + code); showGame(); setNet(true); }
          app.view = m.v; render();
        } else if (m.t === 'err') toast(m.msg);
      });
      conn.on('close', () => {
        setNet(false);
        if (got) banner('Lost connection to the host. <button class="btn sm gold" onclick="location.reload()">Reconnect</button> Your spot and chips are kept.');
      });
    });
    peer.on('error', e => {
      if (e.type === 'peer-unavailable') { clearTimeout(timer); fail('No open table with code ' + code + '. Double-check it with your host.'); }
      else if (!got) { clearTimeout(timer); fail('Connection problem (' + e.type + '). Try again.'); }
    });
    peer.on('disconnected', () => { if (!peer.destroyed) setTimeout(() => peer.reconnect(), 1500); });
  }

  function send(m) {
    if (app.role === 'host') { const err = app.table.command('host', m); if (err) toast(err); }
    else if (app.conn && app.conn.open) app.conn.send(m);
    else toast('Not connected');
  }
  function setNet(on) { $('#netDot').classList.toggle('off', !on); }

  $('#inviteBtn').onclick = async () => {
    if (!app.code) { toast('Offline table, nothing to share'); return; }
    const url = location.origin + location.pathname + '?room=' + app.code;
    if (navigator.share && /Mobi|Android|iPhone/i.test(navigator.userAgent)) {
      try { await navigator.share({ title: 'Craps', text: 'Get on the rail, dice are hot', url }); return; } catch (e) { /* fall through */ }
    }
    try { await navigator.clipboard.writeText(url); toast('Invite link copied'); }
    catch (e) { prompt('Copy this invite link', url); }
  };
  window.addEventListener('beforeunload', e => {
    if (app.role === 'host' && app.table && app.conns.size) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------- build the layout ----------
  const WORD = { 4: '4', 5: '5', 6: 'SIX', 8: '8', 9: 'NINE', 10: '10' };
  $('#nums').innerHTML = POINTS.map(N =>
    `<div class="spot num" data-bet="place${N}" data-n="${N}">
      <div class="puck pk hidden">ON</div>
      <div class="nl">${WORD[N]}</div>
      <div class="pay">Place ${PLACE[N][0]}:${PLACE[N][1]}</div>
      <div class="mine"></div><div class="cp"></div><div class="oth"></div>
    </div>`).join('');
  const PROP_ORDER = [
    ['hard6', 'Hard 6', [3, 3], '9 to 1'], ['hard10', 'Hard 10', [5, 5], '7 to 1'],
    ['hard8', 'Hard 8', [4, 4], '9 to 1'], ['hard4', 'Hard 4', [2, 2], '7 to 1'],
    ['any7', 'Any 7', null, '4 to 1', 'red'], ['anycraps', 'Any Craps', null, '7 to 1'],
    ['aces', 'Aces', [1, 1], '30 to 1'], ['acedeuce', 'Ace-Deuce', [1, 2], '15 to 1'],
    ['yo', 'Yo 11', [5, 6], '15 to 1'], ['twelve', 'Twelve', [6, 6], '30 to 1']
  ];
  $('#props').insertAdjacentHTML('beforeend', PROP_ORDER.map(([k, nm, d, pay, cls]) =>
    `<div class="spot prop ${cls || ''}" data-bet="${k}">
      ${d ? `<div class="mdice"><span>${d[0]}</span><span>${d[1]}</span></div>` : ''}
      <div class="nm">${nm}</div><div class="pay">${pay}</div>
      <div class="mine"></div><div class="oth"></div>
    </div>`).join(''));

  const DENOMS = [1, 5, 25, 100, 500];
  const chipCls = n => 'c' + ([1000, 500, 100, 25, 5, 1].find(d => n >= d) || 1);
  const chipLbl = n => n >= 1000 ? (Math.round(n / 100) / 10) + 'k' : (Number.isInteger(n) ? n : n.toFixed(2).replace(/\.?0+$/, ''));
  function chipHTML(n, sm) { return `<span class="chip ${chipCls(n)} ${sm ? 'sm' : ''}">${chipLbl(n)}</span>`; }
  if (!DENOMS.includes(app.chip)) app.chip = 5;
  $('#chips').innerHTML = DENOMS.map(d => `<button class="chip ${chipCls(d)}" data-chip="${d}" title="$${d} chip">${d}</button>`).join('');
  function markChip() { document.querySelectorAll('#chips .chip').forEach(c => c.classList.toggle('sel', +c.dataset.chip === app.chip)); }
  markChip();
  $('#chips').addEventListener('click', e => {
    const c = e.target.closest('[data-chip]'); if (!c) return;
    app.chip = +c.dataset.chip; store.set('craps.chip', app.chip); markChip();
    if (app.take) setTake(false);
  });
  function setTake(on) { app.take = on; $('#takeBtn').classList.toggle('on', on); $('#takeBtn').textContent = on ? 'Taking down (tap bets)' : 'Take down'; }
  $('#takeBtn').onclick = () => setTake(!app.take);
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'Escape') setTake(false);
    if (e.key === ' ' && !$('#rollBtn').classList.contains('hidden') && !$('#rollBtn').disabled) { e.preventDefault(); $('#rollBtn').click(); }
  });
  $('#clearBtn').onclick = () => send({ t: 'clear' });
  $('#rebuyBtn').onclick = () => send({ t: 'rebuy' });
  $('#rollBtn').onclick = () => send({ t: 'roll' });
  $('#passBtn').onclick = () => send({ t: 'pass' });
  $('#botBtn').onclick = () => send({ t: 'addBot' });
  $('#rollForBtn').onclick = () => send({ t: 'rollFor' });
  $('#skipBtn').onclick = () => send({ t: 'skip' });
  $('#plist').addEventListener('click', e => {
    const x = e.target.closest('[data-rm]'); if (x) send({ t: 'remove', seat: +x.dataset.rm });
  });
  $('#chatForm').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('#chatIn').value.trim();
    if (v) send({ t: 'chat', text: v });
    $('#chatIn').value = '';
  });

  // betting on the layout
  const felt = $('.felt');
  felt.addEventListener('click', e => {
    const el = e.target.closest('[data-bet]'); if (!el) return;
    const v = app.view; if (!v || v.you < 0) { toast('You are watching this one'); return; }
    const key = el.dataset.bet;
    if (app.take) send({ t: 'take', key });
    else send({ t: 'bet', key, amt: app.chip });
  });
  felt.addEventListener('contextmenu', e => {
    const el = e.target.closest('[data-bet]'); if (!el) return;
    e.preventDefault();
    send({ t: 'take', key: el.dataset.bet });
  });

  // ---------- rendering ----------
  const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  function face(el, n) { el.innerHTML = Array.from({ length: 9 }, (_, i) => `<i class="${PIPS[n].includes(i) ? 'on' : ''}"></i>`).join(''); }
  face($('#die1'), 6); face($('#die2'), 6);

  function spotFor(key) {
    let m;
    if (key === 'pass' || key === 'passOdds') return 'pass';
    if (key === 'dp' || key === 'dpOdds') return 'dp';
    if ((m = key.match(/^(?:come|comeOdds|dc|dcOdds|place)(\d+)$/))) return 'place' + m[1];
    return key;
  }
  const spotEl = s => felt.querySelector(`.spot[data-bet="${s}"]`);

  function render() {
    const v = app.view; if (!v) return;
    const me = v.players[v.you] || null;
    const on = v.point !== null;
    const isHost = app.role === 'host';
    const shooter = v.players[v.shooter];
    const rolling = v.phase === 'rolling';

    // dice + call
    const dice = $('#dice');
    if (rolling) {
      if (!app.shakeT) {
        dice.classList.remove('land'); dice.classList.add('rolling');
        app.shakeT = setInterval(() => { face($('#die1'), 1 + Math.floor(Math.random() * 6)); face($('#die2'), 1 + Math.floor(Math.random() * 6)); }, 90);
      }
    } else {
      if (app.shakeT) { clearInterval(app.shakeT); app.shakeT = null; }
      dice.classList.remove('rolling');
      face($('#die1'), v.dice[0]); face($('#die2'), v.dice[1]);
    }
    const call = $('#call');
    const h0 = v.history[0];
    call.textContent = v.call;
    call.classList.toggle('good', !rolling && !!h0 && ['win', 'made'].includes(h0.tag) && app.lastRoll === v.rollId);
    call.classList.toggle('bad', !rolling && !!h0 && ['out', 'craps'].includes(h0.tag) && app.lastRoll === v.rollId);
    $('#sub').textContent = v.sub;
    const bp = $('#bigPuck');
    bp.textContent = on ? v.point : 'OFF';
    bp.classList.toggle('on', on);

    // layout: your chips, others' totals, open/closed
    const others = {};
    v.players.forEach((p, i) => {
      if (i === v.you) return;
      for (const [k, a] of Object.entries(p.bets)) { const s = spotFor(k); others[s] = (others[s] || 0) + a; }
    });
    const mb = me ? me.bets : {};
    felt.querySelectorAll('.spot[data-bet]').forEach(el => {
      const key = el.dataset.bet;
      const mine = el.querySelector(':scope > .mine');
      const amt = mb[key] || 0;
      if (mine) mine.innerHTML = amt ? chipHTML(amt) : '';
      const oth = el.querySelector(':scope > .oth');
      if (oth) oth.textContent = others[key] ? 'Others ' + money(others[key]) : '';
      let closed = false;
      if ((key === 'pass' || key === 'dp') && on && !amt) closed = true;
      if ((key === 'come' || key === 'dc') && !on && !amt) closed = true;
      el.classList.toggle('closed', closed);
    });
    // number boxes: puck, come points, odds
    POINTS.forEach(N => {
      const el = spotEl('place' + N);
      el.querySelector('.pk').classList.toggle('hidden', v.point !== N);
      el.querySelector('.pay').textContent = (!on && mb['place' + N]) ? 'Place bet off' : 'Place ' + PLACE[N][0] + ':' + PLACE[N][1];
      let html = '';
      if (mb['come' + N]) {
        const o = mb['comeOdds' + N] || 0, mx = mb['come' + N] * ODDS_X[N];
        html += `<div class="cprow"><span>Come ${money(mb['come' + N])}</span><button class="oddsbtn ${o ? 'has' : ''}" data-bet="comeOdds${N}" title="Max ${money(mx)}">${o ? 'Odds ' + money(o) : '+ odds'}</button></div>`;
      }
      if (mb['dc' + N]) {
        const o = mb['dcOdds' + N] || 0, mx = mb['dc' + N] * LAY_X;
        html += `<div class="cprow dk"><span>DC ${money(mb['dc' + N])}</span><button class="oddsbtn ${o ? 'has' : ''}" data-bet="dcOdds${N}" title="Max ${money(mx)}">${o ? 'Lay ' + money(o) : '+ lay'}</button></div>`;
      }
      const cp = el.querySelector('.cp');
      if (cp.innerHTML !== html) cp.innerHTML = html;
    });
    const po = felt.querySelector('[data-bet="passOdds"]');
    po.classList.toggle('hidden', !(on && mb.pass));
    if (on && mb.pass) {
      po.classList.toggle('has', !!mb.passOdds);
      po.textContent = mb.passOdds ? 'Odds ' + money(mb.passOdds) + ' (max ' + money(mb.pass * ODDS_X[v.point]) + ')' : '+ Take odds (up to ' + money(mb.pass * ODDS_X[v.point]) + ')';
    }
    const dpo = felt.querySelector('[data-bet="dpOdds"]');
    dpo.classList.toggle('hidden', !(on && mb.dp));
    if (on && mb.dp) {
      dpo.classList.toggle('has', !!mb.dpOdds);
      dpo.textContent = mb.dpOdds ? 'Lay ' + money(mb.dpOdds) + ' (max ' + money(mb.dp * LAY_X) + ')' : '+ Lay odds (up to ' + money(mb.dp * LAY_X) + ')';
    }
    [4, 6, 8, 10].forEach(N => {
      const el = spotEl('hard' + N);
      el.querySelector('.pay').textContent = (!on && mb['hard' + N]) ? 'Off' : HARD[N] + ' to 1';
    });

    // flash results on a new roll
    if (v.rollId !== app.lastRoll) {
      const first = app.lastRoll === -1;
      app.lastRoll = v.rollId;
      if (!first && !rolling) {
        dice.classList.remove('land'); void dice.offsetWidth; dice.classList.add('land');
        call.classList.remove('pop'); void call.offsetWidth; call.classList.add('pop');
        call.classList.toggle('good', !!h0 && ['win', 'made'].includes(h0.tag));
        call.classList.toggle('bad', !!h0 && ['out', 'craps'].includes(h0.tag));
        if (me && me.last && me.last.rollId === v.rollId) {
          const per = {};
          me.last.items.forEach(([k, , n]) => { const s = spotFor(k); per[s] = (per[s] || 0) + n; });
          for (const [s, n] of Object.entries(per)) {
            const el = spotEl(s); if (!el || !n) continue;
            el.classList.remove('win', 'lose'); void el.offsetWidth;
            el.classList.add(n > 0 ? 'win' : 'lose');
            const f = document.createElement('div');
            f.className = 'float ' + (n > 0 ? 'w' : 'l'); f.textContent = signed(n);
            el.appendChild(f); setTimeout(() => f.remove(), 1700);
          }
        }
      }
    }

    // last roll panel
    if (me && v.history[0]) {
      const h = v.history[0];
      let html = `<div class="li" style="color:var(--muted)"><span>Rolled ${h.s} (${h.d[0]}+${h.d[1]})</span></div>`;
      if (me.last && me.last.rollId === v.rollId) {
        html += me.last.items.map(([, l, n]) => `<div class="li"><span>${esc(l)}</span><span class="${n > 0 ? 'pos' : n < 0 ? 'neg' : ''}">${n ? signed(n) : ''}</span></div>`).join('');
        html += `<div class="li tot"><span>Net</span><span class="${me.last.net > 0 ? 'pos' : me.last.net < 0 ? 'neg' : ''}">${signed(me.last.net)}</span></div>`;
      } else html += '<div class="li"><span>No action for you</span></div>';
      $('#lastOut').innerHTML = html;
    }

    // players
    $('#seatCount').textContent = v.players.length + '/8';
    $('#plist').innerHTML = v.players.map((p, i) => {
      const tags = [];
      if (i === v.you) tags.push('you');
      if (i === v.hostSeat) tags.push('host');
      if (p.bot) tags.push('computer');
      if (!p.connected && !p.bot) tags.push('away');
      if (p.rebuys) tags.push(p.rebuys + ' rebuy' + (p.rebuys > 1 ? 's' : ''));
      const canRm = isHost && i !== v.hostSeat && (p.bot || !p.connected);
      return `<div class="pl ${i === v.you ? 'me' : ''} ${i === v.shooter ? 'sh' : ''} ${canRm ? 'rm' : ''}">
        <div class="ic">${i === v.shooter ? '🎲' : p.bot ? '🤖' : i + 1}</div>
        <div class="nmz">${esc(p.name)}<small>${tags.join(' · ')}</small></div>
        <div class="mon">${money(p.total)}<small class="${p.net > 0 ? 'pos' : p.net < 0 ? 'neg' : ''}">${signed(p.net)}</small></div>
        ${canRm ? `<button class="x" data-rm="${i}" title="Remove">×</button>` : ''}
      </div>`;
    }).join('');
    $('#hostCtl').classList.toggle('hidden', !isHost);
    if (isHost) {
      $('#botBtn').disabled = v.players.length >= 8;
      $('#rollForBtn').disabled = rolling || !shooter || shooter.bot;
      $('#rollForBtn').textContent = v.shooter === v.you ? 'Roll' : 'Roll for ' + (shooter ? shooter.name : 'shooter');
      $('#skipBtn').disabled = rolling || v.players.length < 2;
    }

    // history
    $('#hist').innerHTML = v.history.slice(0, 18).map(h => `<span class="hb ${h.tag}" title="${h.d[0]} + ${h.d[1]}">${h.s}</span>`).join('') || '<span style="font-size:12px;color:var(--muted)">No rolls yet</span>';
    let hot = shooter ? `${esc(shooter.name)} has the dice, ${v.handRolls} roll${v.handRolls === 1 ? '' : 's'} this hand.` : '';
    if (v.hotHand && v.hotHand.name) hot += ` Longest hand tonight: ${esc(v.hotHand.name)}, ${v.hotHand.rolls} rolls.`;
    $('#hot').innerHTML = hot;
    $('#feed').innerHTML = v.log.map(l => `<div>${esc(l)}</div>`).join('');
    const msgs = $('#msgs');
    const atBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 30;
    msgs.innerHTML = v.chat.map(c => `<div><b>${esc(c.n)}:</b> ${esc(c.text)}</div>`).join('') || '<div style="color:var(--muted)">Talk some trash.</div>';
    if (atBottom) msgs.scrollTop = msgs.scrollHeight;

    // rack
    if (me) {
      const onT = Math.round((me.total - me.bank) * 100) / 100;
      $('#bankOut').textContent = money(me.bank);
      $('#bankSub').textContent = onT ? money(onT) + ' on the table' : 'Chips';
      $('#rebuyBtn').classList.toggle('hidden', me.total >= 5);
    } else {
      $('#bankOut').textContent = '-'; $('#bankSub').textContent = 'Watching';
    }
    const myTurn = me && v.shooter === v.you;
    const rb = $('#rollBtn');
    rb.classList.toggle('hidden', !myTurn);
    rb.disabled = rolling;
    rb.textContent = rolling ? 'Rolling' : on ? 'Roll' : 'Come out roll';
    rb.classList.toggle('pulse', !!myTurn && !rolling);
    $('#passBtn').classList.toggle('hidden', !(myTurn && !on && !rolling && v.players.length > 1));
    let st = '';
    if (!me) st = 'Table is full, you are watching';
    else if (rolling) st = 'Dice are out, no more bets';
    else if (myTurn) st = on ? 'You have the dice. Point is ' + v.point + '.' : "You're the shooter. Bet the line, then roll.";
    else if (shooter) st = esc(shooter.name) + (shooter.bot ? ' (computer)' : !shooter.connected ? ' (away)' : '') + ' is shooting';
    $('#status').innerHTML = st;
    ['#clearBtn', '#takeBtn'].forEach(s => { $(s).disabled = !me || rolling; });
  }
})();
