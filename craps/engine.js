/* Craps: table rules engine. Runs on the host's browser (or in Node for tests). */
(function (root) {
  'use strict';

  const POINTS = [4, 5, 6, 8, 9, 10];
  const LIMITS = { seats: 8, lineMin: 5, propMin: 1, max: 1000, rollDelay: 1600, botDelay: 2800, awayPass: 9000 };
  const ODDS_X = { 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3 }; // 3-4-5x odds
  const LAY_X = 6;                                          // lay up to 6x the flat (wins 3-4-5x)
  const TRUE = { 4: [2, 1], 5: [3, 2], 6: [6, 5], 8: [6, 5], 9: [3, 2], 10: [2, 1] };
  const PLACE = { 4: [9, 5], 5: [7, 5], 6: [7, 6], 8: [7, 6], 9: [7, 5], 10: [9, 5] };
  const HARD = { 4: 7, 6: 9, 8: 9, 10: 7 };
  const PROPS = {
    any7: [4, s => s === 7, 'Any 7'],
    anycraps: [7, s => s === 2 || s === 3 || s === 12, 'Any Craps'],
    yo: [15, s => s === 11, 'Yo 11'],
    aces: [30, s => s === 2, 'Aces'],
    acedeuce: [15, s => s === 3, 'Ace-Deuce'],
    twelve: [30, s => s === 12, 'Twelve']
  };
  const BOT_NAMES = ['Lucky Lou', 'Dice Daddy', 'Big Red', 'Vegas Vic', 'Hot Hand Hana', 'Snake Eyes Sam', 'Mama Six', 'Yo Leven'];

  const r2 = n => Math.round(n * 100) / 100;
  const pay = (amt, [a, b]) => r2(amt * a / b);
  const lay = (amt, [a, b]) => r2(amt * b / a);

  function label(key) {
    if (PROPS[key]) return PROPS[key][2];
    const m = key.match(/^([a-zA-Z]+?)(\d+)?$/);
    const k = m[1], n = m[2];
    switch (k) {
      case 'pass': return 'Pass Line';
      case 'passOdds': return 'Pass Odds';
      case 'dp': return "Don't Pass";
      case 'dpOdds': return 'Lay Odds';
      case 'come': return n ? 'Come ' + n : 'Come';
      case 'comeOdds': return 'Come ' + n + ' Odds';
      case 'dc': return n ? "Don't Come " + n : "Don't Come";
      case 'dcOdds': return "Don't Come " + n + ' Odds';
      case 'place': return 'Place ' + n;
      case 'field': return 'Field';
      case 'hard': return 'Hard ' + n;
    }
    return key;
  }
  function validKey(key) {
    if (typeof key !== 'string') return false;
    if (['pass', 'passOdds', 'dp', 'dpOdds', 'come', 'dc', 'field'].includes(key) || PROPS[key]) return true;
    const m = key.match(/^(come|comeOdds|dc|dcOdds|place|hard)(\d+)$/);
    if (!m) return false;
    const n = +m[2];
    if (m[1] === 'hard') return [4, 6, 8, 10].includes(n);
    return POINTS.includes(n);
  }
  const isOdds = k => /Odds/.test(k);
  const isLineMin = k => /^(pass|dp|come|dc|field)$/.test(k) || /^place\d+$/.test(k);

  class Table {
    constructor(opts = {}) {
      this.start = opts.startBank || 1000;
      this.onChange = opts.onChange || (() => {});
      this.rng = opts.rng || Math.random;
      this.auto = opts.auto !== false;      // false in tests: no timers, no bot moves
      this.now = opts.now || (() => Date.now());
      this.players = [];
      this.shooter = 0;
      this.point = null;
      this.phase = 'bet';                   // bet | rolling
      this.rollAt = 0;
      this.dice = [6, 6];
      this.call = 'Coming out';
      this.sub = 'Place your bets. Shooter rolls when ready.';
      this.rollId = 0;
      this.handRolls = 0;
      this.history = [];
      this.chat = [];
      this.log = [];
      this.hotHand = { name: null, rolls: 0 };
      this.timer = null;
      this.botN = 0;
    }

    // ---------- seats ----------
    join(id, name, token) {
      const back = token && this.players.find(p => p.token === token && !p.bot && !p.connected && p.id !== 'host');
      if (back) {
        back.id = id; back.connected = true; back.name = String(name || back.name).slice(0, 18);
        this.say(back.name + ' is back');
        this.changed();
        return this.players.indexOf(back);
      }
      if (this.players.length >= LIMITS.seats) return -1;
      const p = this.newPlayer(id, name, token, false);
      this.players.push(p);
      if (this.players.length > 1) this.say(p.name + ' pulled up a seat');
      this.changed();
      return this.players.length - 1;
    }
    newPlayer(id, name, token, bot) {
      return {
        id, token: token || null, bot, name: String(name || 'Player').slice(0, 18),
        bank: this.start, bets: {}, rebuys: 0, connected: true, last: null, best: 0,
        style: bot ? (this.rng() < 0.3 ? 'dark' : 'right') : null, unit: bot ? (this.rng() < 0.5 ? 10 : 25) : 0
      };
    }
    addBot() {
      if (this.players.length >= LIMITS.seats) return 'Table is full';
      const used = new Set(this.players.map(p => p.name));
      let name = BOT_NAMES.find(n => !used.has(n)) || 'Bot ' + (++this.botN);
      const p = this.newPlayer('bot-' + (++this.botN) + '-' + Math.floor(this.rng() * 1e6), name, null, true);
      this.players.push(p);
      this.say(name + ' (computer) joined');
      if (this.phase === 'bet') this.botBets(p);
      this.changed();
      return null;
    }
    remove(seat) {
      const p = this.players[seat];
      if (!p) return 'No one in that seat';
      if (p.id === 'host') return "You can't remove yourself";
      if (!p.bot && p.connected) return 'Only computer players or away players can be removed';
      if (this.phase !== 'bet') return 'Wait for the dice to land';
      const shooterP = this.players[this.shooter];
      this.players.splice(seat, 1);
      if (shooterP === p) { this.shooter = seat % this.players.length; this.newShooter(false); }
      else this.shooter = this.players.indexOf(shooterP);
      this.say(p.name + ' left the table');
      this.changed();
      return null;
    }
    disconnect(id) {
      const p = this.players.find(x => x.id === id);
      if (!p) return;
      p.connected = false;
      this.say(p.name + ' stepped away');
      this.changed();
    }
    seatOf(id) { return this.players.findIndex(p => p.id === id); }

    // ---------- bets ----------
    onTable(p) { return r2(Object.values(p.bets).reduce((a, b) => a + b, 0)); }
    maxFor(p, key) {
      const b = p.bets;
      if (key === 'passOdds') return r2((b.pass || 0) * ODDS_X[this.point]);
      if (key === 'dpOdds') return r2((b.dp || 0) * LAY_X);
      let m = key.match(/^comeOdds(\d+)$/);
      if (m) return r2((b['come' + m[1]] || 0) * ODDS_X[m[1]]);
      m = key.match(/^dcOdds(\d+)$/);
      if (m) return r2((b['dc' + m[1]] || 0) * LAY_X);
      return LIMITS.max;
    }
    betError(p, key) {
      const on = this.point !== null, b = p.bets;
      if (/^(come|dc)\d+$/.test(key)) return 'Come points are moved there by the dice. Tap the box to place it instead.';
      if (key === 'pass' && on) return 'The Pass Line only takes bets on the come-out roll. Try Come or Pass Odds.';
      if (key === 'dp' && on) return "Don't Pass only takes bets on the come-out roll. Try Don't Come.";
      if ((key === 'come' || key === 'dc') && !on) return 'Come bets open once a point is on. Use the Pass Line now.';
      if (key === 'passOdds' && (!on || !b.pass)) return 'Pass Odds need a Pass Line bet and a point';
      if (key === 'dpOdds' && (!on || !b.dp)) return "Lay Odds need a Don't Pass bet and a point";
      let m = key.match(/^comeOdds(\d+)$/);
      if (m && !b['come' + m[1]]) return 'You need a Come bet sitting on ' + m[1];
      m = key.match(/^dcOdds(\d+)$/);
      if (m && !b['dc' + m[1]]) return "You need a Don't Come bet on " + m[1];
      return null;
    }
    bet(p, key, amt) {
      if (this.phase !== 'bet') return 'No more bets, dice are out';
      if (!validKey(key)) return 'Unknown bet';
      amt = r2(+amt);
      if (!(amt > 0)) return 'Pick a chip first';
      const e = this.betError(p, key);
      if (e) return e;
      const cur = p.bets[key] || 0;
      const max = this.maxFor(p, key);
      let add = Math.min(amt, r2(max - cur));
      if (add <= 0) return isOdds(key) ? 'Max odds here is ' + max : 'Table max is $' + LIMITS.max + ' per bet';
      add = Math.min(add, p.bank);
      if (add <= 0) return 'Out of chips. Take something down or rebuy.';
      const min = isLineMin(key) ? LIMITS.lineMin : LIMITS.propMin;
      if (cur + add < min) return 'Table minimum is $' + min + ' on ' + label(key);
      p.bets[key] = r2(cur + add);
      p.bank = r2(p.bank - add);
      this.changed();
      return null;
    }
    takeError(key) {
      if (/^(come|dc)\d+$/.test(key)) return "Come points stay up until they're decided";
      if (key === 'pass' && this.point !== null) return 'Pass Line is locked once the point is on';
      return null;
    }
    take(p, key) {
      if (this.phase !== 'bet') return 'No more bets, dice are out';
      if (!p.bets[key]) return 'Nothing to take down there';
      const e = this.takeError(key);
      if (e) return e;
      const amt = p.bets[key];
      delete p.bets[key];
      p.bank = r2(p.bank + amt);
      // odds can't sit alone
      if (key === 'dp' && p.bets.dpOdds) { p.bank = r2(p.bank + p.bets.dpOdds); delete p.bets.dpOdds; }
      this.changed();
      return null;
    }
    clear(p) {
      if (this.phase !== 'bet') return 'No more bets, dice are out';
      let n = 0;
      for (const k of Object.keys(p.bets)) {
        if (!p.bets[k] || this.takeError(k)) continue;
        p.bank = r2(p.bank + p.bets[k]); delete p.bets[k]; n++;
      }
      if (p.bets.dpOdds && !p.bets.dp) { p.bank = r2(p.bank + p.bets.dpOdds); delete p.bets.dpOdds; }
      if (!n) return 'Nothing you can take down right now';
      this.changed();
      return null;
    }
    rebuy(p) {
      if (r2(p.bank + this.onTable(p)) >= LIMITS.lineMin) return 'You can rebuy once you are under $' + LIMITS.lineMin;
      p.bank = r2(p.bank + this.start); p.rebuys++;
      this.say(p.name + ' rebought for $' + this.start);
      this.changed();
      return null;
    }

    // ---------- dice ----------
    startRoll(byName) {
      if (this.phase !== 'bet') return 'Dice are already out';
      if (!this.players.length) return 'No shooter';
      this.phase = 'rolling';
      this.rollAt = this.now() + LIMITS.rollDelay;
      this.call = 'Dice are out';
      this.sub = (byName ? byName + ' rolls for ' : '') + this.players[this.shooter].name + ' is rolling...';
      this.clearTimer();
      this.changed();
      if (this.auto) this.timer = setTimeout(() => { this.timer = null; this.resolve(); }, LIMITS.rollDelay);
      return null;
    }

    resolve(forced) {
      const d1 = forced ? forced[0] : 1 + Math.floor(this.rng() * 6);
      const d2 = forced ? forced[1] : 1 + Math.floor(this.rng() * 6);
      const s = d1 + d2, hard = d1 === d2, point = this.point, comeOut = point === null;
      const shooter = this.players[this.shooter];

      for (const p of this.players) {
        const b = p.bets, items = [];
        const win = (key, profit, ret) => {
          profit = r2(profit);
          const amt = b[key];
          if (ret) { p.bank = r2(p.bank + amt + profit); delete b[key]; } else p.bank = r2(p.bank + profit);
          items.push([key, label(key), profit]);
        };
        const lose = key => { items.push([key, label(key), -b[key]]); delete b[key]; };
        const back = key => { p.bank = r2(p.bank + b[key]); items.push([key, label(key) + ' back', 0]); delete b[key]; };

        // Pass line and odds
        if (b.pass) {
          if (comeOut) { if (s === 7 || s === 11) win('pass', b.pass); else if (s === 2 || s === 3 || s === 12) lose('pass'); }
          else if (s === point) win('pass', b.pass);
          else if (s === 7) lose('pass');
        }
        if (b.passOdds) {
          if (s === point) win('passOdds', pay(b.passOdds, TRUE[point]), true);
          else if (s === 7) lose('passOdds');
        }
        // Don't pass and lay odds
        if (b.dp) {
          if (comeOut) { if (s === 2 || s === 3) win('dp', b.dp); else if (s === 7 || s === 11) lose('dp'); }
          else if (s === 7) win('dp', b.dp);
          else if (s === point) lose('dp');
        }
        if (b.dpOdds) {
          if (s === 7) win('dpOdds', lay(b.dpOdds, TRUE[point]), true);
          else if (s === point) lose('dpOdds');
        }
        // Come and don't come points (before the box moves)
        for (const N of POINTS) {
          const ck = 'come' + N, ok = 'comeOdds' + N, dk = 'dc' + N, dok = 'dcOdds' + N;
          if (b[ck]) {
            if (s === N) { win(ck, b[ck], true); if (b[ok]) { if (comeOut) back(ok); else win(ok, pay(b[ok], TRUE[N]), true); } }
            else if (s === 7) { lose(ck); if (b[ok]) { if (comeOut) back(ok); else lose(ok); } }
          }
          if (b[dk]) {
            if (s === 7) { win(dk, b[dk], true); if (b[dok]) win(dok, lay(b[dok], TRUE[N]), true); }
            else if (s === N) { lose(dk); if (b[dok]) lose(dok); }
          }
        }
        // Come box
        if (b.come) {
          if (s === 7 || s === 11) win('come', b.come, true);
          else if (s === 2 || s === 3 || s === 12) lose('come');
          else { b['come' + s] = b.come; delete b.come; items.push(['come' + s, 'Come moves to ' + s, 0]); }
        }
        if (b.dc) {
          if (s === 2 || s === 3) win('dc', b.dc, true);
          else if (s === 7 || s === 11) lose('dc');
          else if (s !== 12) { b['dc' + s] = b.dc; delete b.dc; items.push(['dc' + s, "Don't Come moves to " + s, 0]); }
        }
        // Place bets work only while a point is on
        if (!comeOut) for (const N of POINTS) {
          const k = 'place' + N;
          if (!b[k]) continue;
          if (s === N) win(k, pay(b[k], PLACE[N]));
          else if (s === 7) lose(k);
        }
        // Field
        if (b.field) {
          if (s === 2) win('field', b.field * 2);
          else if (s === 12) win('field', b.field * 3);
          else if ([3, 4, 9, 10, 11].includes(s)) win('field', b.field);
          else lose('field');
        }
        // Hardways (off on the come-out)
        if (!comeOut) for (const N of [4, 6, 8, 10]) {
          const k = 'hard' + N;
          if (!b[k]) continue;
          if (s === N && hard) win(k, b[k] * HARD[N]);
          else if (s === N || s === 7) lose(k);
        }
        // One-roll props
        for (const k of Object.keys(PROPS)) {
          if (!b[k]) continue;
          if (PROPS[k][1](s)) win(k, b[k] * PROPS[k][0]); else lose(k);
        }
        // Lay odds left without a flat (flat was lost or won with nothing to pair) are impossible by construction
        const net = r2(items.reduce((a, it) => a + it[2], 0));
        p.last = items.length ? { rollId: this.rollId + 1, items, net } : null;
        if (net > p.best) p.best = net;
      }

      // Call and point movement
      let tag = '', sevenOut = false;
      this.handRolls++;
      if (comeOut) {
        if (s === 7 || s === 11) { this.call = s === 7 ? 'Seven, winner' : 'Yo eleven, winner'; this.sub = 'Front line winner. Pass wins, Don\'t Pass loses.'; tag = 'win'; }
        else if (s === 2 || s === 3 || s === 12) { this.call = 'Craps ' + s; this.sub = s === 12 ? "Pass loses. Don't Pass pushes on 12." : "Pass loses, Don't Pass wins."; tag = 'craps'; }
        else { this.point = s; this.call = 'Point is ' + s; this.sub = 'Odds, Come and Place bets are open.'; tag = 'point'; }
      } else if (s === point) {
        this.point = null; this.call = 'Winner, ' + s + (hard ? ' the hard way' : '');
        this.sub = shooter.name + ' made the point. Coming out again.'; tag = 'made';
      } else if (s === 7) {
        this.point = null; sevenOut = true; this.call = 'Seven out';
        tag = 'out';
      } else {
        this.call = (hard ? 'Hard ' : '') + s + (s === 11 ? ' yo' : '');
        this.sub = 'Point is still ' + point + '.';
      }
      this.dice = [d1, d2];
      this.rollId++;
      this.history.unshift({ d: [d1, d2], s, tag, p: point });
      if (this.history.length > 40) this.history.pop();

      if (sevenOut) {
        const rolls = this.handRolls;
        if (rolls > this.hotHand.rolls) this.hotHand = { name: shooter.name, rolls };
        this.say(shooter.name + ' sevened out after ' + rolls + ' roll' + (rolls === 1 ? '' : 's'));
        this.shooter = (this.shooter + 1) % this.players.length;
        this.newShooter(true);
      } else if (tag === 'made') this.say(shooter.name + ' hit the ' + s);

      this.phase = 'bet';
      this.changed();
      if (this.auto) this.players.filter(p => p.bot).forEach(p => this.botBets(p));
      this.schedule();
    }

    newShooter(fromSevenOut) {
      this.handRolls = 0;
      if (!this.players.length) return;
      const p = this.players[this.shooter];
      this.sub = (fromSevenOut ? 'Line away. ' : '') + 'New shooter: ' + p.name + '.';
      this.say('Dice go to ' + p.name);
    }
    passDice(p, byHost) {
      if (this.phase !== 'bet') return 'Dice are out';
      if (!byHost && this.players[this.shooter] !== p) return "You aren't the shooter";
      if (!byHost && this.point !== null) return 'Shooter keeps the dice until they seven out';
      if (this.players.length < 2) return 'Nobody to pass the dice to';
      const from = this.players[this.shooter];
      this.shooter = (this.shooter + 1) % this.players.length;
      if (from) this.say(from.name + ' passed the dice');
      this.newShooter(false);
      this.changed();
      this.schedule();
      return null;
    }

    // ---------- automation ----------
    clearTimer() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
    schedule() {
      if (!this.auto || this.phase !== 'bet' || this.timer) return;
      const sh = this.players[this.shooter];
      if (!sh) return;
      if (sh.bot) {
        this.timer = setTimeout(() => { this.timer = null; if (this.players[this.shooter] === sh && this.phase === 'bet') this.startRoll(); }, LIMITS.botDelay);
      } else if (!sh.connected) {
        this.timer = setTimeout(() => {
          this.timer = null;
          if (this.players[this.shooter] === sh && !sh.connected && this.phase === 'bet' && this.players.length > 1) {
            this.say(sh.name + ' is away, dice move on');
            this.shooter = (this.shooter + 1) % this.players.length;
            this.newShooter(false);
            this.changed();
          }
          this.schedule();
        }, LIMITS.awayPass);
      }
    }
    botBets(p) {
      if (this.phase !== 'bet') return;
      const b = p.bets, u = p.unit, on = this.point !== null;
      if (p.bank + this.onTable(p) < u) { p.bank = r2(p.bank + this.start); p.rebuys++; }
      const tryBet = (k, a) => { if (p.bank >= a) this.bet(p, k, a); };
      if (p.style === 'dark') {
        if (!on && !b.dp) tryBet('dp', u);
        if (on && b.dp && !b.dpOdds) tryBet('dpOdds', u * 2);
        if (on && !b.dc && this.rng() < 0.3) tryBet('dc', u);
        for (const N of POINTS) if (b['dc' + N] && !b['dcOdds' + N]) tryBet('dcOdds' + N, u * 2);
        return;
      }
      if (!on && !b.pass) tryBet('pass', u);
      if (on) {
        if (b.pass && !b.passOdds) tryBet('passOdds', u * 2);
        const comes = POINTS.filter(N => b['come' + N]).length;
        if (comes < 2 && !b.come && this.rng() < 0.55) tryBet('come', u);
        for (const N of POINTS) if (b['come' + N] && !b['comeOdds' + N]) tryBet('comeOdds' + N, u);
        if (u === 25 && !b.place6 && !b.place8 && this.point !== 6 && this.point !== 8) { tryBet('place6', 30); tryBet('place8', 30); }
        if (this.rng() < 0.12 && !b.hard8) tryBet('hard8', 5);
      }
      if (this.rng() < 0.1 && !b.field) tryBet('field', u);
    }

    // ---------- commands ----------
    command(id, m) {
      if (!m || typeof m !== 'object') return 'Bad message';
      const seat = this.seatOf(id);
      const p = this.players[seat];
      const isHost = id === 'host';
      if (m.t === 'chat') {
        const text = String(m.text || '').trim().slice(0, 200);
        if (!text) return null;
        this.chat.push({ n: p ? p.name : 'Watcher', text, at: this.now() });
        if (this.chat.length > 80) this.chat.shift();
        this.changed();
        return null;
      }
      if (!p) return 'Grab a seat first';
      switch (m.t) {
        case 'bet': return this.bet(p, m.key, m.amt);
        case 'take': return this.take(p, m.key);
        case 'clear': return this.clear(p);
        case 'rebuy': return this.rebuy(p);
        case 'roll':
          if (this.players[this.shooter] !== p) return "You aren't the shooter";
          return this.startRoll();
        case 'pass': return this.passDice(p, false);
      }
      if (!isHost) return 'Host only';
      switch (m.t) {
        case 'addBot': return this.addBot();
        case 'remove': return this.remove(+m.seat);
        case 'rollFor': {
          const sh = this.players[this.shooter];
          if (sh === p) return this.startRoll();
          return this.startRoll(p.name);
        }
        case 'skip': return this.passDice(p, true);
      }
      return 'Unknown command';
    }

    say(text) { this.log.unshift(text); if (this.log.length > 30) this.log.pop(); }
    changed() { this.onChange(); }

    view(seat) {
      return {
        you: seat,
        hostSeat: this.seatOf('host'),
        players: this.players.map(p => {
          const total = r2(p.bank + this.onTable(p));
          return {
            name: p.name, bank: p.bank, bets: p.bets, bot: p.bot, connected: p.connected, rebuys: p.rebuys,
            total, net: r2(total - this.start * (1 + p.rebuys)), last: p.last, best: p.best
          };
        }),
        shooter: this.shooter, point: this.point, phase: this.phase,
        rollIn: Math.max(0, this.rollAt - this.now()),
        dice: this.dice, call: this.call, sub: this.sub, rollId: this.rollId,
        handRolls: this.handRolls, hotHand: this.hotHand,
        history: this.history.slice(0, 24), chat: this.chat.slice(-60), log: this.log.slice(0, 12),
        start: this.start
      };
    }
  }

  const CRAPS = { Table, LIMITS, ODDS_X, LAY_X, TRUE, PLACE, HARD, PROPS, POINTS, label, validKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = CRAPS;
  else root.CRAPS = CRAPS;
})(typeof self !== 'undefined' ? self : this);
