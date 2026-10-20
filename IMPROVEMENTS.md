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
| 8 | Optional interval bell (every 5 min) | feature | S | Nice for longer sits, but adds a control. Wait until Steve asks. |
| 9 | Last-7-days strip under the stats | feature | S | Tiny, but the streak number already covers most of the motivation. |
| 10 | Hint when Wake Lock is unsupported ("set Auto-Lock to Never during sessions") | iOS | XS | Only matters on older iOS. |
| 11 | Radio-group arrow-key navigation for the chips | a11y | XS | Keyboard-only; iPhone VoiceOver swipe works already. |
| 12 | Custom minutes field shows raw decimals if a fractional value is ever stored | polish | XS | Only reachable via test seeding today. |

Left out on purpose: haptics (iOS Safari has no `vibrate`), accounts or sync, more breathing patterns.
