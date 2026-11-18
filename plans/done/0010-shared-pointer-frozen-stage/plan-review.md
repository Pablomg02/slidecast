# Plan review — 0010

One independent critic read plan.md against the repository at commit
`86fb727`. Verdict: *ready with fixes*. Every issue was applied; none
changed the scope Pablo asked for, so no question went back to him.

| # | Severity | Issue | Disposition |
| --- | --- | --- | --- |
| 1 | serious | A pointer held still disappeared after 4 s (no message while still), and late joiners saw nothing until the mouse moved. | Applied: keep-alive every 1.5 s while the laser is on (D20); the 4 s hide stays only as a safety net (D19); e2e for a 5 s hold and a late joiner (T7). |
| 2 | serious | Closing sockets with 4000 missed screens whose socket was dead or asleep at that moment; they reconnect without reloading and keep the old layout. | Applied: a `layout` key in every `state` snapshot; pages reload when it differs from the one they loaded (D7, T4), with a loop guard (D27) and the API returning the live layout; e2e for an offline page. |
| 3 | moderate | Changing the aspect of a frozen deck (newly editable in T5) did not reload open screens. | Applied: the trigger is the layout key (frozen + aspect), `setLayout` instead of `setFrozen`, called when `frozen` or `aspect` changes (T4). |
| 4 | moderate | Viewers on another step in `back`/`free` mode would see the presenter's dot over the wrong slide. | Applied: dots only while `local === live.index` (D26, T7), e2e for a past step. |
| 5 | moderate | `off()` could be overtaken by a pending trailing move; "unchanged" after `off` could swallow the next move. | Applied: `off()` cancels pending sends and forgets the last position (T7); e2e asserts no move frame after the off frame. |
| 6 | moderate | `frame.spec.js` had no page to mount `createDeckFrame` on. | Applied: `test/e2e/frame-harness.html` served at `/__test/frame.html` via `test/e2e/server.js` (T2); deck size read with `frame.evaluate`. |
| 7 | moderate | Bridge "ignores invalid scale" contradicted its test. | Applied: a missing or invalid `scale` sets 1 (D14); test sequence fixed (T2). |
| 8 | suggestion | Reloading the presenter page reset the talk timer. | Applied: timer kept in `sessionStorage` (D28, T4) and asserted in e2e. |
| 9 | suggestion | Pointer e2e passed even with a misplaced overlay layer. | Applied: `.deck-layer` rect must equal the iframe rect at two viewports; `expect.poll` for positions (T2, T7). |
| 10 | suggestion | The presenter's local dot shared id 0 with the first remote slot. | Applied: own dot under key `'self'` (T7). |
| 11 | suggestion | Glow used `currentColor` but classes set only the background. | Applied: `.ptr-cN` set `background` and `color` (D22). |
| 12 | suggestion | Laser button shown on touch-only presenter layouts. | Applied: hidden under `(hover: none), (pointer: coarse)` (D3). |
| 13 | suggestion | Stale baseline (0009 already committed), T4 needs T3, `fit()` must post `frame.mode`, `deckThumb` takes an object. | Applied: Context updated to `86fb727`; T4 depends on T1, T3; `fit()` posts `frame.mode`; `deckThumb({ …, layout })`. |

Author fix found while applying #2: the API's live-layout fallback must not
use `??`, because `null` is a valid live layout (T4).
