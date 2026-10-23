// node baccarat/test/engine.test.js
const B = require('../engine.js');
const assert = require('assert');
let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('ok  ' + name); };

// ---------- exact odds for an 8 deck shoe ----------
// Enumerate every 6 card value sequence, weight it by its chance without replacement.
function exact(decks) {
  const counts = Array(10).fill(4 * decks); counts[0] = 16 * decks;
  const N = 52 * decks;
  const rankOf = v => (v === 0 ? 'T' : v === 1 ? 'A' : String(v)) + 's';
  const spots = B.SPOTS;
  const ev = Object.fromEntries(spots.map(k => [k, 0]));
  const evNC = { B: 0 };
  const freq = { P: 0, B: 0, T: 0, F7: 0, G8: 0, H9one: 0, H9both: 0, B7_3: 0, B7_2: 0, CA: 0 };
  const seq = [];
  function rec(depth, prob) {
    if (depth === 6) {
      let i = 0;
      const h = B.playHand(() => rankOf(seq[i++]));
      const o = B.outcome(h.p, h.b);
      for (const k of spots) ev[k] += prob * (B.payout(k, 1, o, 'commission') - 1);
      evNC.B += prob * (B.payout('B', 1, o, 'nocomm') - 1);
      freq[o.w] += prob;
      if (o.tr.F7) freq.F7 += prob;
      if (o.tr.G8) freq.G8 += prob;
      if (o.tr.H9 === 'one') freq.H9one += prob;
      if (o.tr.H9 === 'both') freq.H9both += prob;
      if (o.tr.B7 === '3card') freq.B7_3 += prob;
      if (o.tr.B7 === '2card') freq.B7_2 += prob;
      if (o.tr.CA) freq.CA += prob;
      return;
    }
    for (let v = 0; v < 10; v++) {
      if (!counts[v]) continue;
      const p = counts[v] / (N - depth);
      counts[v]--; seq.push(v);
      rec(depth + 1, prob * p);
      counts[v]++; seq.pop();
    }
  }
  rec(0, 1);
  return { ev, evNC, freq };
}

const E = exact(8);
const pct = x => (x * 100).toFixed(4) + '%';
console.log('\nHouse edge, 8 decks (negative = house wins):');
for (const k of B.SPOTS) console.log('  ' + B.SPOT_NAME[k].padEnd(12) + pct(E.ev[k]));
console.log('  Banker no-commission ' + pct(E.evNC.B));
console.log('Hit rates: ' + Object.entries(E.freq).map(([k, v]) => k + ' ' + pct(v)).join(', ') + '\n');

t('banker edge matches the published 1.06%', () => assert(Math.abs(E.ev.B + 0.010579) < 0.00002, E.ev.B));
t('player edge matches the published 1.24%', () => assert(Math.abs(E.ev.P + 0.012351) < 0.00002, E.ev.P));
t('tie 8:1 edge matches the published 14.36%', () => assert(Math.abs(E.ev.T + 0.143596) < 0.0001, E.ev.T));
t('no-commission banker edge matches the published 1.46%', () => assert(Math.abs(E.evNC.B + 0.014581) < 0.0001, E.evNC.B));
t('every 5 Treasures bet favours the house', () => { for (const k of B.SIDE) assert(E.ev[k] < 0, k); });
t('outcomes sum to 1', () => assert(Math.abs(E.freq.P + E.freq.B + E.freq.T - 1) < 1e-9));

// ---------- drawing rules spot checks ----------
const hand = (cards) => { let i = 0; return B.playHand(() => cards[i++]); };
t('natural 8 stands', () => { const h = hand(['8s', '2s', 'Ts', '3s', '9s', '9s']); assert.equal(h.p.length, 2); assert.equal(h.b.length, 2); });
t('player 5 draws, banker 3 stands on player third 8', () => { const h = hand(['2s', 'As', '3s', '2s', '8s', '9s']); assert.equal(h.p.length, 3); assert.equal(h.b.length, 2); });
t('banker 6 draws on player third 7', () => { const h = hand(['2s', '3s', '3s', '3s', '7s', '9s']); assert.equal(h.b.length, 3); });
t('player stands on 6, banker draws on 5', () => { const h = hand(['3s', '2s', '3s', '3s', '4s']); assert.equal(h.p.length, 2); assert.equal(h.b.length, 3); });
t('player stands on 7, banker stands on 6', () => { const h = hand(['3s', '3s', '4s', '3s', 'As']); assert.equal(h.p.length, 2); assert.equal(h.b.length, 2); });

// ---------- treasures ----------
const oc = (p, b) => B.outcome(p, b);
t('Fortune 7: banker wins with three card 7', () => { const o = oc(['Ts', '5s', 'Ts'], ['2s', '2s', '3s']); assert.equal(o.w, 'B'); assert(o.tr.F7); assert(o.tr.CA); assert.equal(B.payout('F7', 10, o), 410); });
t('Golden 8: player wins with three card 8', () => { const o = oc(['2s', '2s', '4s'], ['Ts', '3s', '2s']); assert(o.tr.G8); assert.equal(B.payout('G8', 10, o), 260); });
t('Heavenly 9 both pays 75', () => { const o = oc(['2s', '2s', '5s'], ['3s', '3s', '3s']); assert.equal(o.tr.H9, 'both'); assert.equal(B.payout('H9', 10, o), 760); assert.equal(B.payout('T', 10, o), 90); });
t('Blazing 7s three card pays 200', () => { const o = oc(['2s', '2s', '3s'], ['As', 'As', '5s']); assert.equal(o.tr.B7, '3card'); assert.equal(B.payout('B7', 10, o), 2010); });
t('Blazing 7s two card pays 50', () => { const o = oc(['3s', '4s'], ['2s', '5s']); assert.equal(o.tr.B7, '2card'); assert.equal(B.payout('B7', 10, o), 510); });
t('mixed 7s do not qualify', () => { const o = oc(['3s', '4s'], ['2s', '2s', '3s']); assert.equal(o.tr.B7, false); });
t('banker win commission and tie push', () => {
  const o = oc(['2s', '3s'], ['3s', '4s']);
  assert.equal(B.payout('B', 100, o, 'commission'), 195);
  const t6 = oc(['2s', '3s'], ['3s', '3s']);
  assert.equal(B.payout('B', 100, t6, 'nocomm'), 150);
  const tie = oc(['2s', '3s'], ['2s', '3s']);
  assert.equal(B.payout('P', 100, tie), 100); assert.equal(B.payout('B', 100, tie), 100);
});

// ---------- table flow ----------
t('full table flow with a person and bots', () => {
  let seed = 7; const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const room = B.createRoom('Test', {}, rng);
  const me = B.join(room, { token: 'a', name: 'Abhi', host: true }).seat;
  B.addBot(room, rng); B.addBot(room, rng);
  assert.equal(room.seats.length, 3);
  let now = 0;
  let money0 = room.seats.reduce((a, s) => a + s.chips, 0);
  for (let r = 0; r < 400; r++) {
    B.openBetting(room, now);
    assert.equal(B.placeBet(room, me.id, 'F7', 5).ok, false, 'side alone refused');
    assert(B.placeBet(room, me.id, 'B', 25).ok);
    assert(B.placeBet(room, me.id, 'CA', 5).ok);
    for (const s of room.seats.filter(x => x.bot)) { for (const [k, a] of B.botPlan(room, s, rng)) B.placeBet(room, s.id, k, a); B.setReady(room, s.id, true); }
    assert.equal(B.dealDue(room, now), false);
    B.setReady(room, me.id, true);
    assert(B.dealDue(room, now));
    B.startDeal(room);
    const pv = B.publicView(room, now);
    assert(pv.hand.p.every(c => c === null), 'cards hidden before reveal');
    while (!B.revealNext(room));
    B.settle(room);
    if (me.chips < 50) B.rebuy(room, me.id);
    now += 1000;
  }
  // Chips only move between seats and the house, never appear from nowhere: check bookkeeping.
  for (const s of room.seats) assert(Math.abs(s.chips - B.publicView(room, now).seats.find(x => x.id === s.id).chips) < 1e-9);
  assert(room.handNo === 400);
  assert(room.shoeNo >= 2, 'shoe reshuffled at the cut card');
  assert(money0 > 0);
});
t('undo removes side bets when the main bet goes', () => {
  const room = B.createRoom('T', {}, Math.random);
  const s = B.join(room, { token: 'x', name: 'A' }).seat;
  B.openBetting(room, 0);
  B.placeBet(room, s.id, 'P', 50); B.placeBet(room, s.id, 'G8', 10);
  B.undo(room, s.id); // takes the G8
  B.placeBet(room, s.id, 'H9', 10);
  B.undo(room, s.id); B.undo(room, s.id);
  assert.equal(B.sumBets(s.bets), 0); assert.equal(s.chips, 2000);
});
t('rebet repeats the last hand', () => {
  const room = B.createRoom('T', {}, Math.random);
  const s = B.join(room, { token: 'x', name: 'A' }).seat;
  B.openBetting(room, 0); B.placeBet(room, s.id, 'P', 50); B.placeBet(room, s.id, 'B7', 10);
  B.startDeal(room); while (!B.revealNext(room)); B.settle(room);
  B.openBetting(room, 0); assert(B.rebet(room, s.id).ok);
  assert.deepEqual(s.bets, { P: 50, B7: 10 });
});
t('limits and rejoin by token', () => {
  const room = B.createRoom('T', { max: 100 }, Math.random);
  const s = B.join(room, { token: 'x', name: 'A' }).seat;
  B.openBetting(room, 0);
  B.placeBet(room, s.id, 'P', 500); assert.equal(s.bets.P, 100);
  assert.equal(B.placeBet(room, s.id, 'B', 5).ok, false);
  const again = B.join(room, { token: 'x', name: 'A' }).seat; assert.equal(again.id, s.id);
  for (let i = 0; i < 6; i++) B.join(room, { token: 't' + i, name: 'P' + i });
  assert.equal(B.join(room, { token: 'zz', name: 'Late' }).ok, false);
});

t('net is right after a hand settles', () => {
  const room = B.createRoom('T', {}, Math.random);
  const s = B.join(room, { token: 'x', name: 'A' }).seat;
  B.openBetting(room, 0); B.placeBet(room, s.id, 'P', 100);
  B.startDeal(room); while (!B.revealNext(room)); B.settle(room);
  const v = B.publicView(room, 0).seats[0];
  assert.equal(v.net, s.last.net);
});
console.log('\n' + pass + ' passed');
