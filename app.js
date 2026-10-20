(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const app = $('app'), orb = $('orb'), timeEl = $('time'), cueEl = $('cue');
  const startBtn = $('startBtn'), endBtn = $('endBtn'), customMin = $('customMin');
  const chimeToggle = $('chimeToggle'), toneToggle = $('toneToggle');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // Each phase: [cue, seconds, target scale]
  const PATTERNS = {
    calm: [['Inhale', 5, 1], ['Exhale', 5, .55]],
    box: [['Inhale', 4, 1], ['Hold', 4, 1], ['Exhale', 4, .55], ['Hold', 4, .55]],
    '478': [['Inhale', 4, 1], ['Hold', 7, 1], ['Exhale', 8, .55]],
    none: []
  };

  const SKEY = 'still.settings.v1', HKEY = 'still.history.v1';
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  const settings = Object.assign({ minutes: 5, custom: false, pattern: 'calm', chime: true, tone: false }, load(SKEY, {}));
  let history = load(HKEY, []); // [{d:'YYYY-MM-DD', s:secondsSat, t:timestamp}]

  // ---------- state ----------
  let state = 'idle';       // idle | running | paused | done
  let totalMs = 0, remainingMs = 0, endAt = 0, startedAt = 0, elapsedBefore = 0;
  let tickId = 0, phaseTimer = 0, phaseIdx = 0;
  let wakeLock = null;

  // ---------- formatting ----------
  const fmt = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const localDate = (t = Date.now()) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  // ---------- stats ----------
  function renderStats() {
    const days = new Set(history.map((h) => h.d));
    let streak = 0;
    const cur = new Date(); cur.setHours(12, 0, 0, 0);
    if (!days.has(localDate(cur.getTime()))) cur.setDate(cur.getDate() - 1); // today not done yet: count from yesterday
    while (days.has(localDate(cur.getTime()))) { streak++; cur.setDate(cur.getDate() - 1); }
    $('statStreak').textContent = streak;
    $('statCount').textContent = history.length;
    $('statMinutes').textContent = Math.round(history.reduce((a, h) => a + h.s, 0) / 60);
  }
  function logSession(seconds) {
    if (seconds < 60) return; // under a minute doesn't count
    history.push({ d: localDate(), s: Math.round(seconds), t: Date.now() });
    if (history.length > 2000) history = history.slice(-2000);
    save(HKEY, history);
    renderStats();
  }

  // ---------- settings UI ----------
  function renderSettings() {
    document.querySelectorAll('#durations button').forEach((b) =>
      b.setAttribute('aria-checked', String(!settings.custom && +b.dataset.min === settings.minutes)));
    customMin.classList.toggle('active', settings.custom);
    if (settings.custom) customMin.value = settings.minutes;
    document.querySelectorAll('#patterns button').forEach((b) =>
      b.setAttribute('aria-checked', String(b.dataset.pattern === settings.pattern)));
    chimeToggle.checked = settings.chime;
    toneToggle.checked = settings.tone;
    if (state === 'idle' || state === 'done') timeEl.textContent = fmt(settings.minutes * 60000);
  }
  $('durations').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-min]'); if (!b) return;
    settings.minutes = +b.dataset.min; settings.custom = false; customMin.value = '';
    save(SKEY, settings); resetToIdle(); renderSettings();
  });
  customMin.addEventListener('input', () => {
    const v = Math.round(+customMin.value);
    if (v >= 1 && v <= 180) { settings.minutes = v; settings.custom = true; save(SKEY, settings); resetToIdle(); renderSettings(); }
  });
  customMin.addEventListener('keydown', (e) => { if (e.key === 'Enter') customMin.blur(); });
  $('patterns').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-pattern]'); if (!b) return;
    settings.pattern = b.dataset.pattern; save(SKEY, settings); renderSettings();
  });
  chimeToggle.addEventListener('change', () => { settings.chime = chimeToggle.checked; save(SKEY, settings); });
  toneToggle.addEventListener('change', () => {
    settings.tone = toneToggle.checked; save(SKEY, settings);
    if (state === 'running') settings.tone ? toneOn() : toneOff();
  });

  // ---------- audio (Web Audio, created on first tap for iOS) ----------
  let ctx = null, master = null, tone = null;
  function ensureAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!ctx) {
      ctx = new AC();
      master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  // Singing-bowl style chime: a few inharmonic partials, soft attack, long decay.
  function chime(strikes = 1) {
    if (!settings.chime || !ensureAudio()) return;
    const base = 432;
    for (let k = 0; k < strikes; k++) {
      const t0 = ctx.currentTime + 0.05 + k * 1.6;
      [[1, .32, 6], [2.76, .12, 3.5], [5.4, .05, 2], [1.003, .18, 6]].forEach(([ratio, amp, dur]) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = base * ratio;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(amp, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + dur + 0.1);
      });
    }
  }
  function toneOn() {
    if (tone || !ensureAudio()) return;
    const g = ctx.createGain(), lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 420;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 3);
    const oscs = [110, 164.81, 220.4].map((f, i) => {
      const o = ctx.createOscillator(); o.type = i ? 'sine' : 'triangle'; o.frequency.value = f;
      const og = ctx.createGain(); og.gain.value = [0.6, 0.3, 0.15][i];
      o.connect(og); og.connect(lp); o.start(); return o;
    });
    // very slow swell so the drone breathes
    const lfo = ctx.createOscillator(), lfoGain = ctx.createGain();
    lfo.frequency.value = 0.08; lfoGain.gain.value = 0.015;
    lfo.connect(lfoGain); lfoGain.connect(g.gain); lfo.start();
    lp.connect(g); g.connect(master);
    tone = { g, oscs: [...oscs, lfo] };
  }
  function toneOff() {
    if (!tone) return;
    const { g, oscs } = tone; tone = null;
    const now = ctx.currentTime;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(Math.max(g.gain.value, 0.0001), now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 1.5);
    oscs.forEach((o) => o.stop(now + 1.6));
  }

  // ---------- wake lock ----------
  async function lockScreen() {
    try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch {}
  }
  function unlockScreen() { try { wakeLock && wakeLock.release(); } catch {} wakeLock = null; }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (state === 'running') { lockScreen(); tick(); }
      if (ctx && ctx.state === 'suspended' && state === 'running') ctx.resume();
    }
  });

  // ---------- breathing ----------
  function setOrb(scale, seconds) {
    if (reduceMotion.matches) {
      orb.style.transitionDuration = `${Math.min(seconds, 1.5)}s`;
      orb.style.opacity = scale >= 1 ? '1' : '.45';
    } else {
      orb.style.transitionDuration = `${seconds}s`;
      orb.style.transform = `scale(${scale})`;
      orb.style.opacity = '1';
    }
  }
  function runPhase() {
    const pat = PATTERNS[settings.pattern];
    if (!pat.length) { cueEl.textContent = 'Breathe naturally'; return; }
    const [cue, secs, scale] = pat[phaseIdx % pat.length];
    cueEl.textContent = cue;
    setOrb(scale, secs);
    phaseTimer = setTimeout(() => { phaseIdx++; runPhase(); }, secs * 1000);
  }
  function stopBreathing(label) {
    clearTimeout(phaseTimer);
    setOrb(.55, 1.2);
    cueEl.textContent = label;
  }

  // ---------- timer ----------
  function tick() {
    if (state !== 'running') return;
    remainingMs = endAt - Date.now();
    timeEl.textContent = fmt(remainingMs);
    if (remainingMs <= 0) finish();
  }
  function setState(s) {
    state = s; app.dataset.state = s;
    startBtn.textContent = { idle: 'Begin', running: 'Pause', paused: 'Resume', done: 'Again' }[s];
    endBtn.hidden = !(s === 'running' || s === 'paused');
  }
  function start() {
    ensureAudio();
    totalMs = settings.minutes * 60000; remainingMs = totalMs; elapsedBefore = 0;
    phaseIdx = 0;
    resume(true);
  }
  function resume(fresh = false) {
    ensureAudio();
    endAt = Date.now() + remainingMs; startedAt = Date.now();
    setState('running');
    if (fresh) chime(1);
    if (settings.tone) toneOn();
    lockScreen();
    clearInterval(tickId); tickId = setInterval(tick, 250); tick();
    // let the opening chime land before the first inhale
    clearTimeout(phaseTimer);
    phaseTimer = setTimeout(runPhase, fresh ? 1500 : 0);
    if (fresh) cueEl.textContent = 'Settle';
  }
  function pause() {
    remainingMs = Math.max(0, endAt - Date.now());
    elapsedBefore += Date.now() - startedAt;
    clearInterval(tickId); setState('paused'); stopBreathing('Paused'); toneOff(); unlockScreen();
  }
  function sat() { return (elapsedBefore + (state === 'running' ? Date.now() - startedAt : 0)) / 1000; }
  function finish() {
    const secs = Math.min(sat(), totalMs / 1000);
    clearInterval(tickId); timeEl.textContent = '0:00';
    setState('done'); stopBreathing('Complete'); toneOff(); unlockScreen();
    chime(2); logSession(secs);
  }
  function end() {
    const secs = sat();
    state = 'idle';
    clearInterval(tickId); toneOff(); unlockScreen();
    logSession(secs);
    resetToIdle();
  }
  function resetToIdle() {
    if (state === 'running' || state === 'paused') return; // don't interrupt a session from settings
    setState('idle'); stopBreathing('Ready'); timeEl.textContent = fmt(settings.minutes * 60000);
  }
  startBtn.addEventListener('click', () => {
    if (state === 'running') pause();
    else if (state === 'paused') resume();
    else start();
  });
  endBtn.addEventListener('click', end);

  // ---------- boot ----------
  renderSettings(); renderStats(); setState('idle');
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
