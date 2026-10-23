/* DJPal queue logic. Pure functions on a plain JSON party object so it can be saved and tested. */
(function (root) {
  'use strict';

  const DEFAULTS = { maxPerGuest: 3, explicit: true, open: true, mixAware: true };
  const VOTE = 10;          // one vote is worth 10 points
  const WAIT_PER_MIN = 0.5; // songs that have waited longer slowly rise
  const WAIT_CAP = 10;      // waiting is worth at most one vote
  const OWN_PENALTY = 4;    // your 2nd request sits a bit lower than your 1st, and so on
  const MIX_WINDOW = 10;    // mix-aware pick only reaches songs within one vote of the leader

  function createParty(name) {
    return { v: 1, name: name || 'The Party', settings: Object.assign({}, DEFAULTS), queue: [], now: null, played: [], guests: {} };
  }

  const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
  const okUrl = (u, hosts) => {
    try { const x = new URL(u); return x.protocol === 'https:' && hosts.some(h => x.hostname === h || x.hostname.endsWith('.' + h)) ? x.href : ''; } catch (e) { return ''; }
  };

  // Guests send whatever they want, so only keep the fields we need and only trust Apple's hosts.
  function cleanTrack(t) {
    if (!t || typeof t !== 'object') return null;
    const id = String(t.id || '').replace(/[^0-9]/g, '').slice(0, 15);
    const title = clip(t.title, 140).trim();
    const artist = clip(t.artist, 140).trim();
    if (!id || !title) return null;
    return {
      id, title, artist,
      album: clip(t.album, 140),
      genre: clip(t.genre, 40),
      dur: Math.max(0, Math.min(3600000, Number(t.dur) || 0)),
      explicit: !!t.explicit,
      art: okUrl(t.art, ['mzstatic.com']),
      preview: okUrl(t.preview, ['itunes.apple.com', 'apple.com']),
      url: okUrl(t.url, ['music.apple.com', 'itunes.apple.com'])
    };
  }

  function activeBy(party, token) { return party.queue.filter(q => q.by === token); }

  function score(party, item, now) {
    const own = activeBy(party, item.by).sort((a, b) => a.added - b.added);
    const nth = item.by === 'host' ? 0 : Math.max(0, own.findIndex(q => q.id === item.id));
    const waited = Math.min(WAIT_CAP, Math.max(0, (now - item.added) / 60000) * WAIT_PER_MIN);
    return item.votes.length * VOTE + waited - nth * OWN_PENALTY + (item.boost || 0);
  }

  function rank(party, now) {
    now = now || Date.now();
    return party.queue
      .map(q => ({ q, s: score(party, q, now) }))
      .sort((a, b) => b.s - a.s || a.q.added - b.q.added)
      .map(x => Object.assign({}, x.q, { score: Math.round(x.s * 10) / 10 }));
  }

  // ---------- mixing compatibility ----------
  function camelotParts(c) {
    const m = /^(\d{1,2})([AB])$/.exec(c || '');
    return m ? { n: +m[1], l: m[2] } : null;
  }
  function keyFit(a, b) {
    const x = camelotParts(a), y = camelotParts(b);
    if (!x || !y) return -1;
    const d = Math.min((x.n - y.n + 12) % 12, (y.n - x.n + 12) % 12);
    if (d === 0 && x.l === y.l) return 3;          // same key
    if (d === 0) return 2;                         // relative major/minor
    if (d === 1 && x.l === y.l) return 2;          // one step round the wheel
    if (d === 2 && x.l === y.l) return 1;          // energy boost, works sometimes
    return 0;
  }
  function tempoGap(a, b) {
    if (!a || !b) return null;
    let best = Infinity;
    [1, 2, 0.5].forEach(m => { best = Math.min(best, Math.abs(a * m - b) / b); });
    return best;
  }
  function compat(from, to) {
    if (!from || !to || !from.bpm || !to.bpm) return null;
    const k = keyFit(from.camelot, to.camelot);
    const g = tempoGap(from.bpm, to.bpm);
    const t = g <= 0.04 ? 2 : g <= 0.08 ? 1 : 0;
    const total = Math.max(0, k) + t;
    let label;
    if (k >= 2 && t === 2) label = 'Smooth mix';
    else if (k >= 2) label = 'Key fits, tempo jump';
    else if (t === 2) label = 'Tempo fits, key clash';
    else if (total >= 2) label = 'Workable';
    else label = 'Hard mix, cut it in';
    return { score: total, key: k, tempo: t, gap: Math.round(g * 100), label };
  }

  // The song that should play next. Votes decide; mix-aware only breaks near-ties.
  function pickNext(party, now) {
    const r = rank(party, now);
    if (!r.length) return null;
    const top = r[0];
    const from = party.now && party.now.a;
    if (!party.settings.mixAware || !from) return Object.assign({}, top, { why: 'Most votes' });
    const pool = r.filter(q => q.score >= top.score - MIX_WINDOW && q.a);
    let best = null, bestC = -1;
    pool.forEach(q => { const c = compat(from, q.a); const v = c ? c.score : -1; if (v > bestC) { best = q; bestC = v; } });
    const topC = top.a ? compat(from, top.a) : null;
    if (best && best.id !== top.id && bestC > (topC ? topC.score : -1) + 1) {
      return Object.assign({}, best, { why: 'Close on votes, mixes better out of what is playing' });
    }
    return Object.assign({}, top, { why: 'Most votes' });
  }

  // ---------- actions ----------
  function addGuest(party, token, name) {
    if (!token) return;
    party.guests[token] = { name: clip(name, 24).trim() || 'Guest', seen: Date.now() };
  }

  function request(party, token, raw, now) {
    now = now || Date.now();
    const isHost = token === 'host';
    const t = cleanTrack(raw);
    if (!t) return { ok: false, msg: 'That song did not come through. Try again.' };
    if (!isHost && !party.settings.open) return { ok: false, msg: 'Requests are paused for now.' };
    if (party.now && party.now.id === t.id) return { ok: false, msg: 'That one is playing right now.' };
    const dup = party.queue.find(q => q.id === t.id);
    if (dup) {
      if (!dup.votes.includes(token)) dup.votes.push(token);
      return { ok: true, msg: 'Already in the queue, added your vote.', id: t.id };
    }
    if (!isHost && party.played.some(p => p.id === t.id)) return { ok: false, msg: 'Already played tonight.' };
    if (!isHost && !party.settings.explicit && t.explicit) return { ok: false, msg: 'Explicit tracks are off tonight.' };
    if (!isHost && activeBy(party, token).length >= party.settings.maxPerGuest) {
      return { ok: false, msg: 'You have ' + party.settings.maxPerGuest + ' songs waiting. Vote for others until one plays.' };
    }
    const g = party.guests[token];
    party.queue.push(Object.assign(t, { by: token, byName: isHost ? 'DJ' : (g ? g.name : 'Guest'), votes: [token], added: now, a: null }));
    return { ok: true, msg: 'Requested. Get people to vote it up.', id: t.id };
  }

  function vote(party, token, id, on) {
    const q = party.queue.find(x => x.id === String(id));
    if (!q) return { ok: false, msg: 'That song is not in the queue anymore.' };
    const i = q.votes.indexOf(token);
    if (on && i < 0) q.votes.push(token);
    if (!on && i >= 0 && q.by !== token) q.votes.splice(i, 1);
    return { ok: true };
  }

  function take(party, id) {
    const i = party.queue.findIndex(q => q.id === String(id));
    return i < 0 ? null : party.queue.splice(i, 1)[0];
  }
  function finishNow(party, now) {
    if (party.now) {
      party.played.unshift({ id: party.now.id, title: party.now.title, artist: party.now.artist, art: party.now.art, byName: party.now.byName, at: now || Date.now() });
      party.played = party.played.slice(0, 200);
    }
    party.now = null;
  }
  // Put a specific song on (host tapped Play now, or advancing to the pick).
  function play(party, id, now) {
    const q = take(party, id);
    if (!q) return false;
    finishNow(party, now);
    party.now = Object.assign(q, { started: now || Date.now() });
    return true;
  }
  function next(party, now) {
    const n = pickNext(party, now);
    if (!n) { finishNow(party, now); return null; }
    play(party, n.id, now);
    return party.now;
  }
  function veto(party, id) { return !!take(party, id); }
  function boost(party, id, by) { const q = party.queue.find(x => x.id === String(id)); if (q) q.boost = (q.boost || 0) + by; return !!q; }
  function setAnalysis(party, id, a) {
    if (party.now && party.now.id === String(id)) party.now.a = a;
    const q = party.queue.find(x => x.id === String(id));
    if (q) q.a = a;
  }

  // What one guest gets to see. No other guests' tokens leave the host.
  function viewFor(party, token, now) {
    const r = rank(party, now);
    const nx = pickNext(party, now);
    const pub = q => ({
      id: q.id, title: q.title, artist: q.artist, art: q.art, byName: q.byName, explicit: q.explicit,
      votes: q.votes.length, mine: q.by === token, voted: q.votes.includes(token)
    });
    const order = nx ? [r.find(q => q.id === nx.id)].concat(r.filter(q => q.id !== nx.id)) : r;
    return {
      name: party.name,
      open: party.settings.open,
      explicit: party.settings.explicit,
      max: party.settings.maxPerGuest,
      now: party.now ? { id: party.now.id, title: party.now.title, artist: party.now.artist, art: party.now.art, byName: party.now.byName } : null,
      queue: order.map(pub),
      played: party.played.slice(0, 8).map(p => ({ id: p.id, title: p.title, artist: p.artist })),
      playedIds: party.played.map(p => p.id),
      left: Math.max(0, party.settings.maxPerGuest - activeBy(party, token).length),
      guests: Object.keys(party.guests).length
    };
  }

  const api = { createParty, cleanTrack, rank, pickNext, compat, keyFit, tempoGap, addGuest, request, vote, play, next, veto, boost, setAnalysis, viewFor, finishNow, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DJQ = api;
})(typeof window !== 'undefined' ? window : globalThis);
