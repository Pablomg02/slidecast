---
id: "0007"
title: "Poll correct answers"
type: plan
created: 2026-11-16
---

# 0007 — Poll correct answers

## Justification

The author uses polls (0006) as quiz questions in class. A poll can now say
which answers are right; when the results are shown, each participant sees
whether they got it right, wrong, or partly right (several right answers,
not all of them chosen). Asked for by the author (2026-11-16); 0006 had
"correct answers" as a non-goal, now lifted for marking only.

### Goals

- Mark the right answers of a poll in the notes editor or in `deck.json`.
- Presenter: the right answers marked at all times, and how many got it
  right, partly right or wrong.
- Participants and the projector: the right answers and, for participants,
  their own verdict, once answers close.

### Non-goals

- Scores, leaderboards, points across questions.
- A separate "reveal" step after closing answers (author chose to tie it to
  closing).

## Plan

### Context

0006: text in `deck.json` (`slides.<id>.poll`), cleaned by `cleanPoll` /
`pollOf` (`src/polls.js`, mirrored in `public/poll.js`), runs in memory
(`createPolls`), `forPresenters` / `forParticipant` messages, results bars
in `public/poll.js`, UIs in `public/viewer-poll.js`,
`public/presenter-poll.js`, `public/editor.js`. Tests: `npm test`,
`npm run check`, `PW_DISABLE_TS_ESM=1 npx playwright test`.

### Approach

A new optional field `poll.correct`: positions of the right answers. The
server grades (one `gradeOf`), keeps grading anonymous like counts, and
sends participants the key and their grade only with the results.

Discarded: per-answer objects (`options: [{text, correct}]`), which would
break the 0006 format and every deck already written; grading on the client,
which would need the key before answers close.

### Decisions

| # | Decision | Rationale | Source |
| --- | --- | --- | --- |
| D1 | `correct: [i, …]`, positions from 0 in `options`, optional; absent or empty = opinion poll. Cleaned like the rest: follows its answers when empty ones are dropped; out-of-range positions dropped; wrong types rejected. Written only when non-empty. | Backward compatible, easy for an AI to write. | agreed |
| D2 | Several answers: right = exactly the right ones; partial = only right ones, not all; wrong = any wrong one. One answer: right if it is any of the listed ones (so switching the kind never loses the key). | Ticking everything must not earn "partial". | author |
| D3 | Revealed to participants and the projector when answers close; hidden again if reopened. Presenters see the key and the tally always. The key never travels to participants while open. | Author's choice; no cheating by reading the socket. | author |
| D4 | A changed key applies live to a run whose text is unchanged, even with answers; a changed text still waits for Reset (D2 of 0006). | Fix a wrong key in class without losing answers. | agreed |
| D5 | Presenters and displays get `correct` and `grades {right, partial, wrong}` per run; participants get `correct`, `grades` and their own `grade` inside `results`. | Anonymous, like counts (D6 of 0006). | agreed |

### Tasks

#### T1 — Server
- **Files:** `src/polls.js`, `src/decks.js`, `test/polls.test.js`.
- **Acceptance criteria:**
  - [x] Cleaning, remapping, rejection; API stores and removes `correct`.
  - [x] Grading rules (D2); presenters get tallies; participants get nothing about the key while open, key + grade + tallies once closed.
  - [x] Key fixed in the editor applies to an answered run with the same text.

#### T2 — Client
- **Files:** `public/poll.js`, `public/viewer-poll.js`, `public/presenter-poll.js`, `public/editor.js`, `public/shell.js` (icons), `public/i18n.js`, `public/style.css`, e2e.
- **Acceptance criteria:**
  - [x] Editor: a "Correct" tick per answer, kept through removals; hint for one answer with several ticked.
  - [x] Presenter preview and cards mark right answers, chip "With solution", tally line.
  - [x] Viewer: verdict (right / partly / wrong), right answers marked, own wrong answer in red; projector marks only once closed.

#### T3 — Docs
- **Files:** `README.md`, `docs/deck-format.md`, `site/index.html` (same AI prompt), `docs/security.md`, `CHANGELOG.md`.

### Execution

Mode: single agent

### Verification

`npm run check`, `npm test`, full e2e; screenshots (participant right /
partial / wrong, computer and phone, light and dark; projector; presenter;
editor) checked by eye.

### Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Key leaked before closing | cheating | D3: not in participant messages while open (unit test checks the JSON) |
| Index drift when answers are removed | wrong key | remapped in the editor and in `cleanPoll` (tests) |

### Open questions

None.

## Implementation

Baseline (2026-11-16): `npm test` 164 passed; e2e 85 passed.

- [x] T1 — `cleanPoll` reads `correct`, `gradeOf`, runs keep `correct` with `rekey` on show/refresh, `grades` in `forPresenters`, key/grade in `forParticipant` results once closed; `updateSlide` drops `correct` when none; 6 new tests.
- [x] T2 — results bars mark right answers instead of the leading one, own wrong answers in red; viewer verdict and tally; projector key only when closed; presenter preview marks, chip and tally; editor ticks with index remap; icons `check`, `cross`, `partial`; e2e "right answers…" and the editor test extended.
- [x] T3 — docs, site prompt, security, changelog.

Deviations:
- Focus navigation in the editor selected every `input` in the answers list; with the new checkboxes it is now `input[type=text]`.
- Letters on green or red use the surface colour, not white, for contrast in dark mode; the projector scales the "Correct" mark with its text.

## Results

- All goals delivered. `npm run check` clean; `npm test` 170 passed; e2e 92 passed.
- Screenshots checked by eye: participant right (dark), partial (phone, dark), wrong (light); projector closed; presenter open (dark) and preview; editor.

## Closure

2026-11-16 — done. Not yet tried in a real class.
