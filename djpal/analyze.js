/* DJPal track analysis: estimates BPM, key (Camelot) and energy from a 30 second preview.
   analyzePCM is pure so it can be tested outside the browser. */
(function (root) {
  'use strict';

  const PULSE_LO = 6, PULSE_HI = 32, BRIGHT_LO = 0.17, BRIGHT_HI = 0.42;
  const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  // In-place radix-2 FFT
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }
  const hann = n => { const w = new Float32Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)); return w; };

  function frames(x, size, hop, cb) {
    const w = hann(size), re = new Float32Array(size), im = new Float32Array(size), mag = new Float32Array(size / 2);
    let f = 0;
    for (let s = 0; s + size <= x.length; s += hop, f++) {
      for (let i = 0; i < size; i++) { re[i] = x[s + i] * w[i]; im[i] = 0; }
      fft(re, im);
      for (let k = 0; k < size / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
      cb(mag, f);
    }
    return f;
  }

  function camelot(pc, minor) {
    const p = minor ? (pc + 3) % 12 : pc;
    return (((p * 7) % 12 + 7) % 12 + 1) + (minor ? 'A' : 'B');
  }

  function estimateBpm(x, sr) {
    const size = 1024, hop = 128, fps = sr / hop;
    const env = [];
    let prev = null;
    frames(x, size, hop, mag => {
      const cur = new Float32Array(mag.length);
      let flux = 0;
      for (let k = 1; k < mag.length; k++) {
        cur[k] = Math.log1p(100 * mag[k]);
        if (prev) { const d = cur[k] - prev[k]; if (d > 0) flux += k < 40 ? d * 1.5 : d; }
      }
      env.push(flux);
      prev = cur;
    });
    // remove slow trend so autocorrelation sees pulses, not loudness swells
    const n = env.length, e = new Float32Array(n), win = Math.round(fps * 0.5);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += env[i]; if (i >= win) acc -= env[i - win];
      const avg = acc / Math.min(i + 1, win);
      e[i] = Math.max(0, env[i] - avg);
    }
    const lagMin = Math.floor(fps * 60 / 200), lagMax = Math.ceil(fps * 60 / 60);
    const ac = new Float32Array(lagMax + 2);
    for (let L = lagMin - 1; L <= lagMax + 1; L++) {
      let s = 0;
      for (let i = 0; i + L < n; i++) s += e[i] * e[i + L];
      ac[L] = s / (n - L);
    }
    // a beat should also line up at 2x its period, so reward that, then lean toward normal dance tempos
    let best = -1, bestL = 0;
    for (let L = lagMin; L <= lagMax; L++) {
      const bpm = 60 * fps / L;
      const two = 2 * L <= lagMax + 1 ? ac[2 * L] : ac[L];
      const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 0.75, 2));
      const v = (ac[L] + 0.5 * two) * prior;
      if (v > best) { best = v; bestL = L; }
    }
    const a = ac[bestL - 1], b = ac[bestL], c = ac[bestL + 1];
    const off = (a - 2 * b + c) !== 0 ? 0.5 * (a - c) / (a - 2 * b + c) : 0;
    let bpm = 60 * fps / (bestL + Math.max(-0.5, Math.min(0.5, off)));
    while (bpm < 70) bpm *= 2;
    while (bpm > 180) bpm /= 2;
    const mean = ac.slice(lagMin, lagMax).reduce((s, v) => s + v, 0) / (lagMax - lagMin);
    return { bpm: Math.round(bpm * 10) / 10, confidence: mean > 0 ? Math.min(1, (b / mean - 1) / 3) : 0, onsetRate: e.reduce((s, v) => s + v, 0) / n };
  }

  // Tuned on 15 reference songs: spectral peaks only, 60 to 1000 Hz, linear weight, Krumhansl profiles.
  function estimateKey(x, sr) {
    const size = 8192, hop = 4096, chroma = new Float64Array(12);
    const binHz = sr / size;
    frames(x, size, hop, mag => {
      let tot = 0;
      for (let k = 1; k < size / 2; k++) tot += mag[k];
      if (tot <= 0) return;
      for (let k = 2; k < size / 2 - 1; k++) {
        const f = k * binHz;
        if (f < 60 || f > 1000) continue;
        if (!(mag[k] > mag[k - 1] && mag[k] >= mag[k + 1])) continue;
        const a = mag[k - 1], b = mag[k], c = mag[k + 1];
        const d = 0.5 * (a - c) / ((a - 2 * b + c) || 1e-9);
        const semi = Math.round(12 * Math.log2((k + d) * binHz / 440));
        chroma[((semi + 9) % 12 + 12) % 12] += mag[k] / tot;
      }
    });
    const corr = (prof, shift) => {
      let mx = 0, my = 0;
      for (let i = 0; i < 12; i++) { mx += chroma[(i + shift) % 12]; my += prof[i]; }
      mx /= 12; my /= 12;
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < 12; i++) { const a = chroma[(i + shift) % 12] - mx, b = prof[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
      return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
    };
    let best = { r: -2 }, second = -2;
    for (let pc = 0; pc < 12; pc++) {
      [[MAJOR, false], [MINOR, true]].forEach(([p, minor]) => {
        const r = corr(p, pc);
        if (r > best.r) { second = best.r; best = { r, pc, minor }; } else if (r > second) second = r;
      });
    }
    return { key: NOTES[best.pc] + (best.minor ? 'm' : ''), camelot: camelot(best.pc, best.minor), confidence: Math.max(0, Math.min(1, (best.r - second) * 8 + best.r * 0.3)) };
  }

  // Energy 1 to 10. Modern masters are all loud, so loudness counts least; pulse density and tempo carry it.
  function estimateEnergy(x, sr, onsetRate, bpm) {
    let ss = 0;
    for (let i = 0; i < x.length; i++) ss += x[i] * x[i];
    const db = 10 * Math.log10(ss / x.length + 1e-12);
    let lo = 0, hi = 0;
    const cut = Math.round(2000 / (sr / 2048));
    frames(x, 2048, 4096, mag => { for (let k = 1; k < mag.length; k++) { if (k < cut) lo += mag[k]; else hi += mag[k]; } });
    const c = v => Math.max(0, Math.min(1, v));
    const parts = {
      pulse: c((onsetRate - PULSE_LO) / (PULSE_HI - PULSE_LO)),
      tempo: c((bpm - 80) / 70),
      loud: c((db + 18) / 10),
      bright: c((hi / (lo + hi + 1e-9) - BRIGHT_LO) / (BRIGHT_HI - BRIGHT_LO))
    };
    const raw = 0.4 * parts.pulse + 0.3 * parts.tempo + 0.15 * parts.loud + 0.15 * parts.bright;
    return { energy: Math.max(1, Math.min(10, Math.round(1 + 9 * raw))), parts, onsetRate, db };
  }

  function analyzePCM(x, sr) {
    const t = estimateBpm(x, sr);
    const k = estimateKey(x, sr);
    const e = estimateEnergy(x, sr, t.onsetRate, t.bpm);
    return { bpm: t.bpm, key: k.key, camelot: k.camelot, energy: e.energy, conf: Math.round(Math.min(t.confidence, k.confidence) * 100) / 100 };
  }

  // ---------- browser wrapper ----------
  const SR = 11025;
  async function analyzeUrl(url) {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error('preview ' + res.status);
    const buf = await res.arrayBuffer();
    const Off = root.OfflineAudioContext || root.webkitOfflineAudioContext;
    const dec = new Off(1, 44100, 44100);
    const audio = await new Promise((ok, bad) => { const p = dec.decodeAudioData(buf, ok, bad); if (p && p.then) p.then(ok, bad); });
    const len = Math.ceil(audio.duration * SR);
    const ctx = new Off(1, len, SR);
    const src = ctx.createBufferSource();
    src.buffer = audio; src.connect(ctx.destination); src.start();
    const out = await ctx.startRendering();
    const x = out.getChannelData(0);
    await new Promise(r => setTimeout(r, 0));
    return analyzePCM(x, SR);
  }

  const api = { analyzePCM, analyzeUrl, camelot, fft };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DJAnalyze = api;
})(typeof window !== 'undefined' ? window : globalThis);
