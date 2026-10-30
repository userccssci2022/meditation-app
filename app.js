(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const app = $('app'), orb = $('orb'), timeEl = $('time'), cueEl = $('cue');
  const startBtn = $('startBtn'), endBtn = $('endBtn'), customMin = $('customMin');
  const chimeToggle = $('chimeToggle'), toneToggle = $('toneToggle'), intervalToggle = $('intervalToggle'), breathToggle = $('breathToggle');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // Each phase: [cue, seconds, target scale]
  const PATTERNS = {
    slow: [['Inhale', 6, 1], ['Exhale', 9, .55]], // same 2:3 as Relax, 15 s cycle = 4 breaths/min
    relax: [['Inhale', 4, 1], ['Exhale', 6, .55]], // longer exhale; default for new users
    calm: [['Inhale', 5, 1], ['Exhale', 5, .55]],
    box: [['Inhale', 4, 1], ['Hold', 4, 1], ['Exhale', 4, .55], ['Hold', 4, .55]],
    sigh: [['Inhale', 1.5, .82], ['Sip', 1.5, 1], ['Exhale', 6, .55]], // cyclic sigh: two short inhales + long exhale
    '478': [['Inhale', 4, 1], ['Hold', 7, 1], ['Exhale', 8, .55]],
    none: []
  };

  const SKEY = 'still.settings.v1', HKEY = 'still.history.v1';
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  const settings = Object.assign({ minutes: 5, custom: false, pattern: 'relax', chime: true, tone: false, interval: false, intervalMin: 5, breath: false }, load(SKEY, {}));
  let history = load(HKEY, []); // [{d:'YYYY-MM-DD', s:secondsSat, t:timestamp}]

  // ---------- state ----------
  let state = 'idle';       // idle | running | paused | done
  let totalMs = 0, remainingMs = 0, endAt = 0, startedAt = 0, elapsedBefore = 0;
  let tickId = 0, phaseTimer = 0, phaseIdx = 0, breathT0 = 0; // breathT0: performance.now() when phase 0 starts
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
    document.querySelector('.stats').style.visibility = history.length ? '' : 'hidden'; // first run: no row of zeros
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
    customMin.value = settings.custom ? settings.minutes : '';
    document.querySelectorAll('#patterns button').forEach((b) =>
      b.setAttribute('aria-checked', String(b.dataset.pattern === settings.pattern)));
    chimeToggle.checked = settings.chime;
    toneToggle.checked = settings.tone;
    intervalToggle.checked = settings.interval;
    breathToggle.checked = settings.breath;
    if (state === 'idle' || state === 'done') timeEl.textContent = fmt(settings.minutes * 60000);
  }
  $('durations').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-min]'); if (!b) return;
    settings.minutes = +b.dataset.min; settings.custom = false; customMin.value = '';
    save(SKEY, settings); resetToIdle(); renderSettings();
  });
  customMin.addEventListener('input', () => {
    const digits = customMin.value.replace(/\D/g, '');
    const v = Math.min(+digits, 180);
    customMin.value = v ? String(v) : digits;
    if (v >= 1) { settings.minutes = v; settings.custom = true; save(SKEY, settings); resetToIdle(); renderSettings(); }
  });
  customMin.addEventListener('blur', renderSettings); // the box always ends up showing what's actually set
  customMin.addEventListener('keydown', (e) => { if (e.key === 'Enter') customMin.blur(); });
  $('patterns').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-pattern]'); if (!b) return;
    settings.pattern = b.dataset.pattern; save(SKEY, settings); renderSettings();
  });
  chimeToggle.addEventListener('change', () => { settings.chime = chimeToggle.checked; save(SKEY, settings); audio(); scheduleBells(); });
  intervalToggle.addEventListener('change', () => { settings.interval = intervalToggle.checked; save(SKEY, settings); audio(); scheduleBells(); });
  breathToggle.addEventListener('change', () => { settings.breath = breathToggle.checked; save(SKEY, settings); audio(); cancelCues(); scheduleCues(true); });
  toneToggle.addEventListener('change', () => {
    settings.tone = toneToggle.checked; save(SKEY, settings); audio();
    if (state === 'running') settings.tone ? toneOn() : toneOff();
  });

  // ---------- audio (Web Audio, one shared context, resumed on every tap for iOS) ----------
  // iOS treats Web Audio as "ambient" sound by default: it obeys the silent switch and is suspended (its clock stops)
  // when the screen locks or the app leaves the foreground, so a bell scheduled for the end never sounds.
  // A 'playback' audio session (iOS 17+) lets it keep running like a media app; on iOS a near-silent looping
  // <audio> element also holds the media session open during a session. If the clock still stopped, the end chime
  // is owed and rung as soon as audio is back (within a minute of the end), and stale bells are cancelled.
  // Interval, end and breath sounds live on the audio clock and are re-synced to the wall-clock timer whenever it (re)starts.
  let ctx = null, master = null, tone = null, pending = [], owed = 0;
  const isIOS = /iP(hone|od|ad)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  function audio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    if (!ctx) {
      ctx = new AC();
      master = ctx.createGain(); master.gain.value = 0.8;
      master.connect(ctx.destination);
      ctx.onstatechange = () => {
        if (ctx.state !== 'running') return;
        if (state === 'running') { scheduleBells(); scheduleCues(); } else if (state === 'done') payOwed();
      };
    }
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    return ctx;
  }
  // Soft bell: sine partials, quick attack, 2–4 s exponential decay. Partials sum to 0.37, so overlaps can't clip.
  // pitch/level: the interval bell is a fifth higher (648 Hz) and softer, so it can't be mistaken for the end.
  function bell(t0, pitch = 1, level = 1) {
    return [[432, .2, 4], [433.3, .1, 4], [1192, .05, 2.2], [2333, .015, 1.2]].map(([f, amp, dur]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f * pitch;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(amp * level, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + dur + 0.05);
      return o;
    });
  }
  function startChime() { if (settings.chime && audio()) bell(ctx.currentTime + 0.05); }
  function cancelBells(keep) {
    if (ctx) pending.forEach((b) => { if (b !== keep && b.at > ctx.currentTime) b.nodes.forEach((o) => o.stop()); });
    pending = [];
  }
  function scheduleBells() {
    if (!ctx) return;
    cancelBells();
    if (state !== 'running') return;
    const now = ctx.currentTime, left = Math.max(0, (endAt - Date.now()) / 1000), total = totalMs / 1000, sat = total - left;
    if (settings.interval) {
      const step = settings.intervalMin * 60;
      for (let k = step; k < total - 1; k += step) if (k > sat) pending.push({ at: now + k - sat, nodes: bell(now + k - sat, 1.5, .6) });
    }
    if (settings.chime) pending.push({ at: now + left, end: true, nodes: [...bell(now + left), ...bell(now + left + 1.6)] });
  }
  // At the end: if the end chime is sounding (or just about to), keep it. Otherwise the audio clock was stopped,
  // so cancel the stale one and owe the chime; it rings once audio is running again, if that's within a minute.
  function finishBells() {
    const endBell = pending.find((b) => b.end);
    const heard = !!(ctx && endBell && ctx.state === 'running' && endBell.at <= ctx.currentTime + 0.5);
    cancelBells(heard ? endBell : null);
    owed = settings.chime && ctx && !heard ? Date.now() + 60000 : 0;
    payOwed();
  }
  function payOwed() {
    if (!owed || state !== 'done' || !ctx || ctx.state !== 'running') return;
    if (Date.now() < owed) { const t = ctx.currentTime + 0.05; bell(t); bell(t + 1.6); }
    owed = 0;
  }
  // Breath sound: a soft singing bowl per breath. Inhale a brighter bowl (540 Hz); exhale a lower bowl (324 Hz) with a
  // long decay. Bowl-like inharmonic partials (1, 2.76, 5.4) with slow beating; linear 12 ms onset from 0 (no click).
  // Level 0.804 puts the cue peak at about -23 dBFS at the output, against the chime's -11.
  function breathCue(t0, inhale) {
    const f = inhale ? 540 : 324, decay = inhale ? 3.2 : 5.5, level = 0.804;
    return [[1, .06, 1], [1.004, .03, 1], [2.76, .018, .55], [5.4, .004, .3]].map(([m, amp, dk]) => {
      const o = ctx.createOscillator(), g = ctx.createGain(), peak = amp * level, rel = decay * dk;
      o.type = 'sine'; o.frequency.value = f * m;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.012);
      g.gain.setValueAtTime(peak, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(peak * 0.001, t0 + 0.012 + rel);
      g.gain.linearRampToValueAtTime(0, t0 + 0.012 + rel + 0.05);
      o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + 0.012 + rel + 0.1);
      return o;
    });
  }
  // Cues are kept scheduled up to 5 min ahead on the audio clock (so they carry on if the page is asleep),
  // topped up every tick, and rebuilt if the audio clock and the wall clock drift apart (e.g. after a suspend).
  let cues = [], cueNext = 0, cueMap = null;
  function cancelCues() {
    if (ctx) cues.forEach((c) => { if (c.at > ctx.currentTime) c.nodes.forEach((o) => o.stop()); });
    cues = []; cueMap = null;
  }
  function scheduleCues(fresh = false) {
    const pat = PATTERNS[settings.pattern];
    if (!settings.breath || state !== 'running' || !pat.length) { if (cues.length) cancelCues(); return; }
    if (!ctx || ctx.state !== 'running') return;
    const nowW = performance.now(), map = ctx.currentTime - nowW / 1000;
    if (cueMap !== null && Math.abs(map - cueMap) > 0.05) cancelCues();
    if (cueMap === null) { cueMap = map; cueNext = 0; while (phaseStart(cueNext) < nowW + (fresh ? -100 : 20)) cueNext++; }
    cues = cues.filter((c) => c.at > ctx.currentTime - 5);
    const stopW = Math.min(nowW + 300000, nowW + (endAt - Date.now()) - 1000); // none in the last second: that's the end chime's
    for (let tw; (tw = phaseStart(cueNext)) < stopW; cueNext++) {
      const cue = pat[cueNext % pat.length][0];
      if (cue === 'Hold') continue;
      const at = Math.max(cueMap + tw / 1000, ctx.currentTime + 0.01);
      cues.push({ at, nodes: breathCue(at, cue !== 'Exhale') }); // Inhale and Sip share the brighter bowl
    }
  }
  // iOS only: a looping, near-silent clip (±1 LSB, about -90 dBFS) played from the Begin tap keeps the media session alive.
  let keep = null, keepOff = 0;
  function keepAlive(on) {
    clearTimeout(keepOff);
    if (!isIOS) return;
    if (!on) { if (keep) keep.pause(); return; }
    if (!keep) {
      const n = 8000, v = new DataView(new ArrayBuffer(44 + n * 2)), w = (o, str) => [...str].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
      w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
      v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      w(36, 'data'); v.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, i % 2 ? 1 : -1, true);
      keep = new Audio(URL.createObjectURL(new Blob([v], { type: 'audio/wav' })));
      keep.loop = true; keep.setAttribute('playsinline', '');
    }
    keep.play().catch(() => {});
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
  let hintShown = false, hintTimer = 0;
  function hint(show) { clearTimeout(hintTimer); $('hint').hidden = !show; if (show) hintTimer = setTimeout(() => { $('hint').hidden = true; }, 8000); }
  async function lockScreen() {
    if (wakeLock) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    catch { if (!hintShown && state === 'running') { hintShown = true; hint(true); } } // no Wake Lock (older iOS) or refused: say so once per session
  }
  function unlockScreen() { try { wakeLock && wakeLock.release(); } catch {} wakeLock = null; }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (state === 'running') { lockScreen(); tick(); }
      if (ctx && ctx.state !== 'running' && (state === 'running' || owed)) ctx.resume().catch(() => {});
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
  // Phase i starts at a fixed offset from breathT0, so the circle, the cue word and the breath sound share one timeline.
  function phaseStart(i) {
    const pat = PATTERNS[settings.pattern], cycle = pat.reduce((a, p) => a + p[1], 0);
    let s = Math.floor(i / pat.length) * cycle;
    for (let j = 0; j < i % pat.length; j++) s += pat[j][1];
    return breathT0 + s * 1000;
  }
  function runPhase() {
    const pat = PATTERNS[settings.pattern];
    if (!pat.length) { cueEl.textContent = 'Breathe naturally'; return; }
    const now = performance.now();
    while (phaseStart(phaseIdx + 1) <= now) phaseIdx++; // catch up if the page was asleep
    const [cue, , scale] = pat[phaseIdx % pat.length], left = Math.max(0, phaseStart(phaseIdx + 1) - now);
    cueEl.textContent = cue;
    setOrb(scale, left / 1000);
    if (settings.breath && cue !== 'Hold' && navigator.vibrate) try { navigator.vibrate(15); } catch {} // a light tap where supported (not iOS)
    phaseTimer = setTimeout(() => { phaseIdx++; runPhase(); }, left);
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
    if (remainingMs <= 0) finish(); else scheduleCues();
  }
  function setState(s) {
    state = s; app.dataset.state = s;
    startBtn.textContent = { idle: 'Begin', running: 'Pause', paused: 'Resume', done: 'Again' }[s];
    const inSession = s === 'running' || s === 'paused';
    endBtn.hidden = !inSession; $('settings').inert = inSession;
    if (s !== 'running') hint(false);
  }
  function start() {
    totalMs = settings.minutes * 60000; remainingMs = totalMs; elapsedBefore = 0; hintShown = false; owed = 0;
    resume(true);
  }
  function resume(fresh = false) {
    audio(); keepAlive(true);
    endAt = Date.now() + remainingMs; startedAt = Date.now(); phaseIdx = 0;
    breathT0 = performance.now() + (fresh ? 1500 : 0); // a fresh session lets the opening chime land first; a resume starts a new cycle
    setState('running');
    if (fresh) startChime();
    scheduleBells();
    cancelCues(); scheduleCues(true);
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
    clearInterval(tickId); setState('paused'); stopBreathing('Paused'); toneOff(); unlockScreen(); audio(); cancelBells(); cancelCues(); keepAlive(false);
  }
  function sat() { return (elapsedBefore + (state === 'running' ? Date.now() - startedAt : 0)) / 1000; }
  function finish() {
    const secs = Math.min(sat(), totalMs / 1000);
    clearInterval(tickId); clearTimeout(phaseTimer);
    setState('done'); toneOff(); unlockScreen(); cancelCues(); finishBells();
    keepOff = setTimeout(() => keepAlive(false), 6000); // after the end chime has rung out
    const streak = logSession(secs);
    timeEl.textContent = secs < 60 ? '<1 min' : `${Math.round(secs / 60)} min`;
    cueEl.textContent = streak ? `Complete · ${streak}-day streak` : 'Complete';
    setOrb(1, 2.4);
  }
  function end() {
    const secs = sat();
    state = 'idle';
    clearInterval(tickId); toneOff(); unlockScreen(); cancelBells(); cancelCues(); keepAlive(false);
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
