# Still: improvement audit (2026-10-21)

Audit method: drove the live app headless at 390x844 through a full Box 4·4·4·4 session
(Begin → settle → breathing → pause → resume → done), then read `index.html`, `style.css`, `app.js`.

Ranked by user delight ÷ size. ✅ = shipped in this pass.

| # | Item | Kind | Size | Why |
|---|------|------|------|-----|
| 1 | ✅ Breathing cue and circle drift apart after pause/resume | bug | XS | Pause snaps the circle to rest, resume restarts the *current* phase. Paused during the top "Hold" → resumes saying "Hold" while the circle expands. Resume should start a fresh cycle from Inhale. |
| 2 | ✅ VoiceOver chatter: the whole stage is `aria-live`, so the clock is announced every second | a11y bug | XS | Only the cue (Inhale/Hold/Exhale/Complete) should be live; the clock should be a `role="timer"`. |
| 3 | ✅ Settings stay reachable during a session (VoiceOver, keyboard) and sit at 25% as visual noise | UX + a11y | XS | Use `inert` and hide them fully while a session runs. Replaces the `pointer-events` hack (subtraction). |
| 4 | ✅ Flat end: "0:00 COMPLETE" with nothing to show for it | delight | S | Done state shows minutes sat and the streak, and the circle gives one slow bloom, so the end is clear without sound or haptics. |
| 5 | ✅ Chip and ring borders are 1.4:1 against the background | a11y | XS | WCAG non-text contrast wants 3:1. Raise the line colour. |
| 6 | ✅ Dead code: light-mode `.auto` block never applies; toggle transitions a property that never changes; `color-scheme: dark light` on a dark-only app; redundant `.custom` rule | remove | XS | Less to read, nothing visible changes. |
| 7 | End chime when the screen auto-locks (silent keep-alive buffer / media element) | iOS | M | High value, but iOS lock-screen audio behaviour can't be proven headless. Needs an on-device test. Wake Lock already keeps the screen on (iOS 18.4+ Home Screen apps). |
| 8 | ✅ (iter 2) Optional interval bell every 5 min | feature | S | Off by default. One softer strike a fifth above the chime (648 Hz, 60% level). Scheduled on the audio clock with the end chime in one `pending` list, cancelled on pause, re-synced on resume and when audio restarts. Harness proves bells at 5/13/18 s across a 3 s pause, and none when off. The switch row was tightened so three switches fit on one line. |
| 9 | ⏸ Last-7-days strip under the stats | feature | S | Skipped on purpose (iter 3 review). It adds a row of UI to a calm screen, and the streak number already carries the motivation. |
| 10 | ✅ (iter 3) Hint when the screen can't be kept awake | iOS | XS | More general than first planned: shown when Wake Lock is missing (older iOS) **or** refused (e.g. power saving). Shown once per session, hides after 8 s and on pause. Says to set Auto-Lock to Never or turn off Low Power Mode. Never shown when the lock is granted. Proved by `audit/check-iter3.js` (missing/rejected/granted, contrast 9.7). The clipped "Custom" placeholder was also fixed. |
| 11 | ⏸ Radio-group arrow-key navigation for the chips | a11y | XS | Skipped on purpose. An iPhone has no arrow keys, and VoiceOver swipe and Tab already work. |
| 12 | ✅ (iter 1) Custom length box could disagree with the timer: `999` showed while 99 min was set; `0`/`-3` were silently ignored | bug | XS | Digits only (`inputmode=numeric`), clamp to 180, and on blur the box always shows what's actually set. Dead spinner CSS removed. |
| 13 | ✅ (iter 1) First run opened on "0 day streak · 0 sessions · 0 min" | delight | XS | Stats row stays hidden until there is history (space kept, so no layout shift). |

Next if wanted: #7, after an on-device test with the screen locked.

Left out on purpose: haptics (iOS Safari has no `vibrate`), accounts or sync, more breathing patterns.
