/* Baccarat 5 Treasures: rules, shoe and table state. No DOM, no network.
   The host's browser runs this and sends everyone the public view. Node can load it for tests. */
(function (root) {
  'use strict';

  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
  const SUITS = ['s', 'h', 'd', 'c'];
  const MAIN = ['P', 'B', 'T'];
  const SIDE = ['F7', 'G8', 'H9', 'B7', 'CA'];
  const SPOTS = MAIN.concat(SIDE);
  const SPOT_NAME = { P: 'Player', B: 'Banker', T: 'Tie', F7: 'Fortune 7', G8: 'Golden 8', H9: 'Heavenly 9', B7: 'Blazing 7s', CA: 'Cover All' };
  const MAX_SEATS = 7;
  const DEFAULTS = { bankroll: 2000, min: 10, max: 1000, sideMin: 5, sideMax: 200, mode: 'commission', betSecs: 25, decks: 8 };
  const BOT_NAMES = ['Bunty', 'Pinky', 'Sharma ji', 'Lucky', 'Dolly', 'Tiger', 'Chintu', 'Rocky', 'Babloo', 'Sweety'];

  const r2 = x => Math.round(x * 100) / 100;
  const val = c => { const i = RANKS.indexOf(c[0]); return i >= 9 ? 0 : i + 1; };
  const total = cards => cards.reduce((a, c) => a + val(c), 0) % 10;

  // ---------- shoe ----------
  function newShoe(decks, rng) {
    const s = [];
    for (let d = 0; d < decks; d++) for (const r of RANKS) for (const u of SUITS) s.push(r + u);
    for (let i = s.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [s[i], s[j]] = [s[j], s[i]]; }
    s.shift(); // burn one
    return { cards: s, pos: 0, cut: s.length - 14 - Math.floor(rng() * 8) };
  }

  // ---------- drawing rules ----------
  // Returns both hands and the order the cards hit the table.
  function playHand(draw) {
    const p = [draw(), null], b = [draw(), null];
    p[1] = draw(); b[1] = draw();
    const order = ['p0', 'b0', 'p1', 'b1'];
    const pt = total(p), bt = total(b);
    if (pt >= 8 || bt >= 8) return { p, b, order }; // natural, both stand
    let p3 = null;
    if (pt <= 5) { p3 = draw(); p.push(p3); order.push('p2'); }
    const bt2 = total(b);
    let bankerDraws;
    if (p3 === null) bankerDraws = bt2 <= 5;
    else {
      const v = val(p3);
      if (bt2 <= 2) bankerDraws = true;
      else if (bt2 === 3) bankerDraws = v !== 8;
      else if (bt2 === 4) bankerDraws = v >= 2 && v <= 7;
      else if (bt2 === 5) bankerDraws = v >= 4 && v <= 7;
      else if (bt2 === 6) bankerDraws = v === 6 || v === 7;
      else bankerDraws = false;
    }
    if (bankerDraws) { b.push(draw()); order.push('b2'); }
    return { p, b, order };
  }

  function outcome(p, b) {
    const pt = total(p), bt = total(b);
    const w = pt > bt ? 'P' : bt > pt ? 'B' : 'T';
    const tr = {
      F7: w === 'B' && b.length === 3 && bt === 7,
      G8: w === 'P' && p.length === 3 && pt === 8,
      H9: (p.length === 3 && pt === 9 && b.length === 3 && bt === 9) ? 'both'
        : ((p.length === 3 && pt === 9) || (b.length === 3 && bt === 9)) ? 'one' : false,
      // Both hands land on 7 with the same card count. A 2 card 7 against a 3 card 7 does not qualify.
      B7: (pt === 7 && bt === 7 && p.length === 3 && b.length === 3) ? '3card'
        : (pt === 7 && bt === 7 && p.length === 2 && b.length === 2) ? '2card' : false
    };
    tr.CA = !!(tr.F7 || tr.G8 || tr.H9 || tr.B7);
    return { w, pt, bt, tr, natural: p.length === 2 && b.length === 2 && (pt >= 8 || bt >= 8) };
  }

  // Amount returned to the player for one spot (stake included). 0 means lost.
  function payout(spot, amt, o, mode) {
    if (!amt) return 0;
    switch (spot) {
      case 'P': return o.w === 'P' ? amt * 2 : o.w === 'T' ? amt : 0;
      case 'B':
        if (o.w === 'T') return amt;
        if (o.w !== 'B') return 0;
        if (mode === 'nocomm') return o.bt === 6 ? r2(amt * 1.5) : amt * 2;
        return r2(amt * 1.95);
      case 'T': return o.w === 'T' ? amt * 9 : 0;
      case 'F7': return o.tr.F7 ? amt * 41 : 0;
      case 'G8': return o.tr.G8 ? amt * 26 : 0;
      case 'H9': return o.tr.H9 === 'both' ? amt * 76 : o.tr.H9 === 'one' ? amt * 11 : 0;
      case 'B7': return o.tr.B7 === '3card' ? amt * 201 : o.tr.B7 === '2card' ? amt * 51 : 0;
      case 'CA': return o.tr.CA ? amt * 7 : 0;
    }
    return 0;
  }

  // Names of the treasures that hit, for banners and the road.
  function treasureLabels(o) {
    const out = [];
    if (o.tr.F7) out.push('Fortune 7');
    if (o.tr.G8) out.push('Golden 8');
    if (o.tr.H9 === 'both') out.push('Heavenly 9 x2');
    else if (o.tr.H9) out.push('Heavenly 9');
    if (o.tr.B7 === '3card') out.push('Blazing 7s');
    else if (o.tr.B7) out.push('Blazing 7s (2 card)');
    return out;
  }

  // =====================================================================
  // Table state
  // =====================================================================
  function createRoom(name, settings, rng) {
    const s = Object.assign({}, DEFAULTS, settings || {});
    return {
      v: 1, name: name || 'Baccarat', settings: s, seats: [], nextId: 1,
      phase: 'lobby', handNo: 0, deadline: 0, hand: null, result: null,
      road: [], shoe: newShoe(s.decks, rng), shoeNo: 1, log: []
    };
  }

  const seatOf = (room, id) => room.seats.find(x => x.id === id);
  const seatByToken = (room, tk) => room.seats.find(x => x.token === tk);
  const sumBets = bets => r2(Object.values(bets).reduce((a, b) => a + b, 0));
  const hasMain = bets => MAIN.some(k => bets[k] > 0);

  function join(room, o) {
    if (!o.bot) {
      const ex = seatByToken(room, o.token);
      if (ex) { ex.name = o.name || ex.name; ex.connected = true; return { ok: true, seat: ex }; }
    }
    if (room.seats.length >= MAX_SEATS) return { ok: false, msg: 'Table is full (' + MAX_SEATS + ' seats).' };
    let name = String(o.name || '').trim().slice(0, 16) || 'Guest';
    if (room.seats.some(x => x.name.toLowerCase() === name.toLowerCase())) name = name.slice(0, 13) + ' ' + (room.seats.length + 1);
    const seat = {
      id: room.nextId++, name, bot: !!o.bot, host: !!o.host, token: o.token || null, connected: true,
      chips: room.settings.bankroll, buyins: 1, bets: {}, stack: [], lastBets: null, ready: false, last: null
    };
    room.seats.push(seat);
    return { ok: true, seat };
  }

  function addBot(room, rng) {
    const used = new Set(room.seats.map(x => x.name));
    const free = BOT_NAMES.filter(n => !used.has(n));
    const name = free.length ? free[Math.floor(rng() * free.length)] : 'Bot ' + room.nextId;
    return join(room, { bot: true, name });
  }

  function removeSeat(room, id) {
    const i = room.seats.findIndex(x => x.id === id);
    if (i < 0) return { ok: false, msg: 'No such seat.' };
    const s = room.seats[i];
    if (room.phase === 'dealing' && sumBets(s.bets) > 0) return { ok: false, msg: 'Wait for this hand to finish.' };
    if (room.phase === 'betting') refund(s);
    room.seats.splice(i, 1);
    return { ok: true };
  }

  function refund(s) { s.chips = r2(s.chips + sumBets(s.bets)); s.bets = {}; s.stack = []; }

  function canBet(room) { return room.phase === 'betting'; }

  function placeBet(room, id, spot, amt) {
    const s = seatOf(room, id), st = room.settings;
    if (!s) return { ok: false, msg: 'Take a seat first.' };
    if (!canBet(room)) return { ok: false, msg: 'Bets are closed.' };
    if (!SPOTS.includes(spot)) return { ok: false, msg: 'Unknown bet.' };
    amt = Math.floor(Number(amt));
    if (!(amt > 0)) return { ok: false, msg: 'Bad amount.' };
    if (s.ready) s.ready = false;
    const isSide = SIDE.includes(spot);
    if (isSide && !hasMain(s.bets)) return { ok: false, msg: 'Put a Player, Banker or Tie bet down first.' };
    const cur = s.bets[spot] || 0;
    const lo = isSide ? st.sideMin : st.min, hi = isSide ? st.sideMax : st.max;
    if (cur + amt > hi) {
      amt = hi - cur;
      if (amt <= 0) return { ok: false, msg: SPOT_NAME[spot] + ' is maxed at ' + hi + '.' };
    }
    if (cur + amt < lo) return { ok: false, msg: SPOT_NAME[spot] + ' minimum is ' + lo + '.' };
    if (amt > s.chips) return { ok: false, msg: 'Not enough chips.' };
    s.chips = r2(s.chips - amt);
    s.bets[spot] = cur + amt;
    s.stack.push([spot, amt]);
    return { ok: true };
  }

  function undo(room, id) {
    const s = seatOf(room, id);
    if (!s || !canBet(room) || !s.stack.length) return { ok: false };
    const [spot, amt] = s.stack.pop();
    s.bets[spot] -= amt; s.chips = r2(s.chips + amt);
    if (!s.bets[spot]) delete s.bets[spot];
    s.ready = false;
    if (!hasMain(s.bets) && sumBets(s.bets) > 0) refund(s); // side bets cannot stand alone
    return { ok: true };
  }

  function clearBets(room, id) {
    const s = seatOf(room, id);
    if (!s || !canBet(room)) return { ok: false };
    refund(s); s.ready = false;
    return { ok: true };
  }

  function rebet(room, id, mult) {
    const s = seatOf(room, id);
    if (!s || !canBet(room)) return { ok: false };
    if (!s.lastBets || !sumBets(s.lastBets)) return { ok: false, msg: 'No last bet to repeat.' };
    refund(s);
    const order = MAIN.concat(SIDE);
    for (const k of order) {
      const a = (s.lastBets[k] || 0) * (mult || 1);
      if (a) { const r = placeBet(room, id, k, a); if (!r.ok) { refund(s); return r; } }
    }
    return { ok: true };
  }

  function setReady(room, id, on) {
    const s = seatOf(room, id);
    if (!s || !canBet(room)) return { ok: false };
    s.ready = !!on;
    return { ok: true };
  }

  function rebuy(room, id) {
    const s = seatOf(room, id);
    if (!s) return { ok: false };
    if (r2(s.chips + sumBets(s.bets)) >= room.settings.min) return { ok: false, msg: 'You can rebuy once you are under the table minimum.' };
    s.chips = r2(s.chips + room.settings.bankroll); s.buyins++;
    return { ok: true };
  }

  function humans(room) { return room.seats.filter(x => !x.bot); }

  // Deal once every connected person has hit Ready (or passed) and at least one person has money down,
  // or when the clock runs out with someone's money down.
  function dealDue(room, now) {
    if (room.phase !== 'betting') return false;
    const hs = humans(room).filter(x => x.connected);
    const anyHumanBet = humans(room).some(x => sumBets(x.bets) > 0);
    const botsPending = room.seats.some(x => x.bot && !x.ready);
    if (!anyHumanBet) return false;
    if (hs.length && hs.every(x => x.ready) && !botsPending) return true;
    return now >= room.deadline;
  }

  function openBetting(room, now) {
    const st = room.settings;
    let newShoeMsg = false;
    if (room.shoe.pos >= room.shoe.cut) { room.shoe = newShoe(st.decks, room._rng || Math.random); room.shoeNo++; room.road = []; newShoeMsg = true; }
    for (const s of room.seats) {
      s.bets = {}; s.stack = []; s.ready = false; s.last = null;
      if (s.bot && s.chips < st.min) { s.chips = r2(s.chips + st.bankroll); s.buyins++; }
    }
    room.phase = 'betting'; room.hand = null; room.result = null;
    room.deadline = now + st.betSecs * 1000;
    return { ok: true, newShoe: newShoeMsg };
  }

  function startDeal(room) {
    if (room.phase !== 'betting') return { ok: false };
    // Anyone who left side bets with no main bet gets them back. Should not happen, but be safe.
    for (const s of room.seats) { if (!hasMain(s.bets) && sumBets(s.bets)) refund(s); s.lastBetsPending = sumBets(s.bets) ? Object.assign({}, s.bets) : null; }
    const sh = room.shoe;
    const draw = () => { if (sh.pos >= sh.cards.length) throw new Error('shoe empty'); return sh.cards[sh.pos++]; };
    const h = playHand(draw);
    room.handNo++;
    room.hand = { no: room.handNo, p: h.p, b: h.b, order: h.order, shown: 0 };
    room.phase = 'dealing';
    return { ok: true };
  }

  // Reveal one more card. Returns true when every card is face up.
  function revealNext(room) {
    if (!room.hand) return true;
    if (room.hand.shown < room.hand.order.length) room.hand.shown++;
    return room.hand.shown >= room.hand.order.length;
  }

  function settle(room) {
    const h = room.hand, st = room.settings;
    const o = outcome(h.p, h.b);
    const per = {};
    for (const s of room.seats) {
      const staked = sumBets(s.bets);
      if (!staked) { s.last = null; continue; }
      const spots = {};
      let ret = 0;
      for (const k of Object.keys(s.bets)) { const r = payout(k, s.bets[k], o, st.mode); spots[k] = r2(r - s.bets[k]); ret += r; }
      ret = r2(ret);
      s.chips = r2(s.chips + ret);
      s.last = { net: r2(ret - staked), staked, spots };
      if (s.lastBetsPending) s.lastBets = s.lastBetsPending;
      delete s.lastBetsPending;
      per[s.id] = s.last;
    }
    room.result = { w: o.w, pt: o.pt, bt: o.bt, tr: o.tr, labels: treasureLabels(o), natural: o.natural, per };
    room.road.push({ w: o.w, pt: o.pt, bt: o.bt, t: treasureLabels(o).length > 0, n: h.no });
    if (room.road.length > 90) room.road.shift();
    room.phase = 'result';
    return room.result;
  }

  // ---------- bots ----------
  // A short list of chip placements for one bot this hand.
  function botPlan(room, seat, rng) {
    const st = room.settings, plan = [];
    const pick = (a) => a[Math.floor(rng() * a.length)];
    const room_ = Math.min(st.max, seat.chips);
    if (room_ < st.min) return plan;
    // Size: a few percent of the stack, rounded to table chips.
    const unit = st.min >= 25 ? 25 : st.min >= 10 ? 10 : 5;
    let size = Math.max(st.min, Math.round((seat.chips * (0.015 + rng() * 0.05)) / unit) * unit);
    if (rng() < 0.08) size = Math.max(st.min, Math.round(seat.chips * 0.2 / unit) * unit); // the occasional big swing
    size = Math.min(size, room_);
    // Read the road a little, like real players do.
    const last = room.road.filter(x => x.w !== 'T').slice(-3).map(x => x.w);
    let side;
    const r = rng();
    if (last.length === 3 && last.every(x => x === last[0]) && r < 0.6) side = last[0]; // ride the streak
    else side = r < 0.53 ? 'B' : r < 0.95 ? 'P' : 'T';
    if (side === 'T') size = Math.max(st.min, Math.round(size / 3 / unit) * unit);
    plan.push([side, size]);
    let left = seat.chips - size;
    if (side !== 'T' && rng() < 0.12 && left >= st.min) { plan.push(['T', st.min]); left -= st.min; }
    // 5 Treasures: some bots love them, some ignore them.
    const sideBase = Math.max(st.sideMin, Math.min(st.sideMax, unit));
    const style = seat.id % 3; // 0 = treasure hunter, 1 = casual, 2 = purist
    const chance = style === 0 ? 0.7 : style === 1 ? 0.3 : 0.06;
    if (rng() < chance && left >= sideBase) {
      if (rng() < 0.5) { plan.push(['CA', sideBase]); left -= sideBase; }
      else {
        const picks = side === 'B' ? ['F7', 'H9', 'B7'] : side === 'P' ? ['G8', 'H9', 'B7'] : ['B7', 'H9'];
        const k = pick(picks);
        plan.push([k, sideBase]); left -= sideBase;
        if (rng() < 0.3 && left >= sideBase) plan.push([pick(SIDE.filter(x => x !== k)), sideBase]);
      }
    }
    return plan;
  }

  // What everyone is allowed to see. The shoe order stays on the host.
  function publicView(room, now) {
    const h = room.hand;
    let hand = null;
    if (h) {
      const shownSet = new Set(h.order.slice(0, h.shown));
      const vis = (side) => h[side].map((c, i) => shownSet.has(side + i) ? c : null);
      hand = { no: h.no, p: vis('p'), b: vis('b'), order: h.order, shown: h.shown };
    }
    const sh = room.shoe;
    return {
      name: room.name, settings: room.settings, phase: room.phase, handNo: room.handNo,
      betLeft: room.phase === 'betting' ? Math.max(0, room.deadline - now) : 0,
      hand, result: room.phase === 'result' ? room.result : null,
      road: room.road, shoeNo: room.shoeNo, cardsLeft: sh.cards.length - sh.pos, cutReached: sh.pos >= sh.cut,
      seats: room.seats.map(s => ({
        id: s.id, name: s.name, bot: s.bot, host: s.host, connected: s.connected, chips: s.chips, buyins: s.buyins,
        bets: s.bets, ready: s.ready, last: s.last, hasLast: !!(s.lastBets && sumBets(s.lastBets)),
        net: r2(s.chips + (room.phase === 'result' ? 0 : sumBets(s.bets)) - s.buyins * room.settings.bankroll) // bets are already settled in the result phase
      }))
    };
  }

  const api = {
    RANKS, SUITS, MAIN, SIDE, SPOTS, SPOT_NAME, MAX_SEATS, DEFAULTS, BOT_NAMES,
    val, total, newShoe, playHand, outcome, payout, treasureLabels,
    createRoom, join, addBot, removeSeat, placeBet, undo, clearBets, rebet, setReady, rebuy,
    dealDue, openBetting, startDeal, revealNext, settle, botPlan, publicView, sumBets, hasMain, seatOf, seatByToken, r2
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BAC = api;
})(typeof window !== 'undefined' ? window : globalThis);
