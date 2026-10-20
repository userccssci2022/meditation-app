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
    return streak;
  }
  function logSession(seconds) {
    if (seconds < 60) return 0; // under a minute doesn't count
    history.push({ d: localDate(), s: Math.round(seconds), t: Date.now() });
    if (history.length > 2000) history = history.slice(-2000);
    save(HKEY, history);
    return renderStats();
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
  chimeToggle.addEventListener('change', () => { settings.chime = chimeToggle.checked; save(SKEY, settings); audio(); scheduleEnd(); });
  toneToggle.addEventListener('change', () => {
    settings.tone = toneToggle.checked; save(SKEY, settings); audio();
    if (state === 'running') settings.tone ? toneOn() : toneOff();
  });

  // ---------- audio (Web Audio, one shared context, resumed on every tap for iOS) ----------
  // iOS can leave the context 'suspended' or 'interrupted' (screen lock, background); only a tap brings it back.
  // The end chime lives on the audio clock and is re-synced to the wall-clock timer whenever the clock (re)starts.
  let ctx = null, master = null, tone = null, endChime = null;
  function audio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!ctx) {
      ctx = new AC();
      master = ctx.createGain(); master.gain.value = 0.8;
      master.connect(ctx.destination);
      ctx.onstatechange = () => { if (ctx.state === 'running' && state === 'running') scheduleEnd(); };
    }
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    return ctx;
  }
  // Soft bell: sine partials, quick attack, 2–4 s exponential decay. Partials sum to 0.37, so overlaps can't clip.
  function bell(t0) {
    return [[432, .2, 4], [433.3, .1, 4], [1192, .05, 2.2], [2333, .015, 1.2]].map(([f, amp, dur]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(amp, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + dur + 0.05);
      return o;
    });
  }
  function startChime() { if (settings.chime && audio()) bell(ctx.currentTime + 0.05); }
  function cancelEnd() {
    if (endChime && endChime.at > ctx.currentTime) endChime.nodes.forEach((o) => o.stop());
    endChime = null;
  }
  function scheduleEnd() {
    if (!ctx) return;
    cancelEnd();
    if (!settings.chime || state !== 'running') return;
    const at = ctx.currentTime + Math.max(0, (endAt - Date.now()) / 1000);
    endChime = { at, nodes: [...bell(at), ...bell(at + 1.6)] };
  }
  // Soft pad: two detuned low sines, lowpassed, very low level, slow swell, 3 s fades.
  function toneOn() {
    if (tone || !audio()) return;
    const t = ctx.currentTime;
    const out = ctx.createGain(), swell = ctx.createGain(), lp = ctx.createBiquadFilter();
    out.gain.setValueAtTime(0, t); out.gain.linearRampToValueAtTime(0.0125, t + 3);
    lp.type = 'lowpass'; lp.frequency.value = 400; lp.Q.value = 0.5;
    const oscs = [220, 220.6].map((f) => { const o = ctx.createOscillator(); o.frequency.value = f; o.connect(lp); o.start(t); return o; });
    const lfo = ctx.createOscillator(), depth = ctx.createGain();
    lfo.frequency.value = 0.07; depth.gain.value = 0.25;
    lfo.connect(depth); depth.connect(swell.gain); lfo.start(t);
    lp.connect(swell); swell.connect(out); out.connect(master);
    tone = { out, nodes: [...oscs, lfo] };
  }
  function toneOff() {
    if (!tone) return;
    const { out, nodes } = tone; tone = null;
    const t = ctx.currentTime;
    out.gain.cancelScheduledValues(t);
    out.gain.setValueAtTime(out.gain.value, t);
    out.gain.linearRampToValueAtTime(0, t + 2.5);
    nodes.forEach((o) => o.stop(t + 2.6));
  }

  // ---------- wake lock ----------
  async function lockScreen() {
    try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch {}
  }
  function unlockScreen() { try { wakeLock && wakeLock.release(); } catch {} wakeLock = null; }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (state === 'running') { lockScreen(); tick(); }
      if (ctx && ctx.state !== 'running' && state === 'running') ctx.resume().catch(() => {});
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
    const inSession = s === 'running' || s === 'paused';
    endBtn.hidden = !inSession; $('settings').inert = inSession;
  }
  function start() {
    totalMs = settings.minutes * 60000; remainingMs = totalMs; elapsedBefore = 0;
    resume(true);
  }
  function resume(fresh = false) {
    audio();
    endAt = Date.now() + remainingMs; startedAt = Date.now(); phaseIdx = 0;
    setState('running');
    if (fresh) startChime();
    scheduleEnd();
    if (settings.tone) toneOn();
    lockScreen();
    clearInterval(tickId); tickId = setInterval(tick, 250); tick();
    // let the opening chime land before the first inhale
    clearTimeout(phaseTimer);
    phaseTimer = setTimeout(runPhase, fresh ? 1500 : 0);
    if (fresh) { cueEl.textContent = 'Settle'; setOrb(.55, 1.2); }
  }
  function pause() {
    remainingMs = Math.max(0, endAt - Date.now());
    elapsedBefore += Date.now() - startedAt;
    clearInterval(tickId); setState('paused'); stopBreathing('Paused'); toneOff(); unlockScreen(); audio(); cancelEnd();
  }
  function sat() { return (elapsedBefore + (state === 'running' ? Date.now() - startedAt : 0)) / 1000; }
  function finish() {
    const secs = Math.min(sat(), totalMs / 1000);
    clearInterval(tickId); clearTimeout(phaseTimer);
    setState('done'); toneOff(); unlockScreen();
    const streak = logSession(secs);
    timeEl.textContent = secs < 60 ? '<1 min' : `${Math.round(secs / 60)} min`;
    cueEl.textContent = streak ? `Complete · ${streak}-day streak` : 'Complete';
    setOrb(1, 2.4);
  }
  function end() {
    const secs = sat();
    state = 'idle';
    clearInterval(tickId); toneOff(); unlockScreen(); cancelEnd();
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
