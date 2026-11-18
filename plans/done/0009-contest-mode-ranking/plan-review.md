# 0009 — Plan review (2026-11-18)

Two independent reviewers read the first version of the plan with the
author's request, without the planning conversation: one for the
implementation (soundness, executability), one for the experience (teacher
setup, teacher in class, students, projector). Both returned "ready with
fixes". Four proposals changed behaviour or scope and were put to the
author; the answers are recorded as `user` decisions in the plan.

## Implementation review

| Severity | Issue | Disposition |
| --- | --- | --- |
| serious | The editor drops `points`/`time`/`contest` and, with delete-when-absent, wipes them on save | Applied: D3 (editor carries the fields), T6 criterion |
| moderate | An invalid field in a hand-written deck.json makes the poll unlaunchable / turns the contest off | Applied: strict on save, lenient on read (D2, D3), T1 criteria |
| moderate | Admin settings dialog has no contest data | Applied: `deckRows()` carries `contest` (D22, T1) |
| moderate | Upload over an existing deck does not apply the new contest | Applied: `resetDeck` re-reads the meta (D22, T3 criterion) |
| moderate | Countdown timers without owner, cleanup or queue position | Applied: D10, T4 criteria |
| moderate | Ranking and score not sent on connect or join | Applied: D19, T4 criterion |
| moderate | Participant score messages unthrottled | Applied: one `rankingSoon`, send only changes (D19) |
| moderate | WebSocket and e2e points depend on wall-clock time | Applied: `buildServer({ now })` (D7), fake clock in WS tests, `speed: 0` and one right/one wrong in e2e |
| moderate | Empty names, null names in the ranking, stored anonymous choice, contest off | Applied: D13, D17 |
| moderate | Keeping offline participants: static `keep`, running timers, abuse | Applied: dynamic `keep`, only named with a ballot, `keepNow`/`expireOffline` (D15) |
| unclear | `run.seq`, launch order, "most recently counted" undefined | Applied: D18 |
| unclear | Contest or poll changes mid-round; retroactive rescoring | Applied: D9 (running countdown), D24 (rescoring) |
| suggestion | Tiny negative `t` on reopen | Applied: clamp in D6, T2 criterion |
| suggestion | AI prompt is tested against the website | Applied: prompt unchanged (D29) |
| suggestion | T3 and T4 too large | Applied: split into T3–T5 (server) and T6–T8 (clients) |
| suggestion | Uncommitted presenter work; phone layout of the Ranking tab | Applied: precondition; Ranking from **More** on a phone (D26) |

## Experience review

| Severity | Issue | Disposition |
| --- | --- | --- |
| serious | Speed points depend on when the teacher closes | Applied: T = countdown limit (D6) — it was also what the author had chosen |
| serious | Phone says "Incorrect" while giving points | Applied: verdict from `c`, explanation line (D5, D25) |
| serious | Tick-then-Send under a countdown loses answers | Applied: one tap sends one-answer polls in contest mode (D25) |
| moderate | A question can silently never count | Applied: `unscored` banner and launch confirmation (D19, D26) |
| moderate | Reopening rewards the second try | Asked: the author chose "reopen resumes the clock" (D8) |
| moderate | Ranking is in another tab and can stay on the screens | Applied: **Show ranking** on the poll card, strip **Take off**, slide change takes it off (D20, D26) |
| moderate | Kick is the only fix for a bad nickname | Asked: the author chose **Ask for another name** (D16) |
| moderate | A student who changes device can't recover | Asked: the author chose a message only (D14); merging points is a non-goal |
| moderate | Name settings and texts contradict contest mode | Applied: D13, D28 |
| moderate | Phone countdown reaches 0 after the server closed | Applied: 1 s grace, phones end 0.5 s early (D9) |
| suggestion | Plain-language labels for speed and per-poll fields | Applied: D28 ("Slowness penalty", live hint, editor fieldset always shown) |
| suggestion | Say whether a question counts, and the rules | Applied: chips, phone lines, join rules line (D25, D26) |
| suggestion | Projector ranking readable from the back | Applied: D27 |
| suggestion | CSV language and restart safety | Applied: `?lang`, restart confirmation offers the CSV first (D21, D26) |
| optional (scope) | Auto-close when everyone has answered | Asked: the author chose yes (D11) |
