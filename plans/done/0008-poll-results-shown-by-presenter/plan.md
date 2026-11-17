---
id: "0008"
title: "Poll results shown by the presenter"
type: plan
created: 2026-11-17
---

# 0008 — Poll results shown by the presenter

Recorded after the fact: the change was asked for and agreed in conversation
on 2026-11-17, implemented, then reviewed by an independent reviewer. This
plan keeps its decisions where code comments can point to them. It replaces
D7 of 0006 (participants see results once answers close; displays get live
counts) and D3 of 0007 (right answers revealed when answers close).

## Justification

The author teaches with slidecast. In class, the projector showed the live
counts from the moment a poll was launched, telling the room what people
were answering, and closing answers always showed the results to everyone.
The author wants the results secret, on the projector too, until they
choose to show them: people answer, the presenter closes the poll, then
shows what the room answered and the right answer, if there is one.

### Goals

- Presenter view, poll on the screens and taking answers: **Close and show
  results** (green) and **Take off the screens** (light blue) in sight;
  **More options** folds **Close without results**, **Show results** and
  **Reset poll** (red).
- Poll on the screens, answers closed: **Reopen answers** and **Take off the
  screens** in sight; **More options** folds **Show / Hide results** and
  **Reset poll**.
- Results secret to participants and the projector until shown; presenters
  always see them live.
- Works on computers and phones (Android, iPhone, upright and sideways)
  without breaking live use (throttled broadcasts, reconnections, keyboard).

### Non-goals

- Changing who may control polls, or the poll format in `deck.json`.
- Results on the projector without showing them to participants, or the
  other way round.

## Plan

### Context

Poll runs live in `src/polls.js` (`createPolls`), the protocol and
broadcasts in `src/live.js`; clients in `public/presenter-poll.js`,
`public/viewer-poll.js`, `public/poll.js` (results bars). Original design in
0006 (D1–D10) and 0007 (D1–D5). Tests: `npm test`, `npm run check`,
`PW_DISABLE_TS_ESM=1 npx playwright test`.

### Approach

A run gets a `revealed` flag next to `open`. The server decides what each
kind of client receives: presenters everything (unchanged), displays only
the shown run with counts once revealed, participants results once
revealed. Commands: `close` takes `results`, plus `reveal` and `conceal`.
The folded options open inside the card (in the page flow, like the phone
toolbar's "more"), so the phone's pop-up never clips them.

Discarded: hiding counts only on the projector's screen while still sending
them to every display (the screen in the room would still carry them); a
floating menu (clipped by the scrolling pop-up on phones, and anchor
positioning is not supported everywhere yet).

### Decisions

| # | Decision | Rationale | Source |
| --- | --- | --- | --- |
| D1 | Results are secret to participants and the projector until a presenter shows them. A run starts with `revealed: false`. Presenters always get every run with its counts. Replaces D7 of 0006. | The projector must not tell the room what people are answering. | author |
| D2 | `close` takes `results: true` ("Close and show results") or `false` / omitted ("Close without results"). `reveal` / `conceal` show or hide them at any time. Reopening answers makes them secret again. | A second round of answers is as blind as the first (peer instruction). | author (actions), agreed (reopen) |
| D3 | Right answers and grades become public only when answers are closed **and** the results shown. Replaces D3 of 0007. | Nobody copies the right answer while still answering. | agreed |
| D4 | Displays (projector tabs that do not control the slides) get only the shown run: question, options, how many answered, and counts / key / grades only as D1 and D3 allow. A projector tab that controls the slides connects as a presenter, gets everything, and keeps it off its screen until shown. | The server cannot tell a controlling projector from the presenter view; that tab already has presenter rights, so nothing reaches the audience. | agreed |
| D5 | Participants see, until shown: the form while open; once closed, the options with their own answer marked and "the results have not been shown yet". | They keep seeing what they answered. | agreed |
| D6 | Results shown while answers are open: participants follow the counts on the same throttle as presenters (300 ms, 1 s above 200 participants) through one shared message `{t: 'poll-counts', id, counts, voters}`, built once per tick. | Sending the whole poll to each participant every tick reached ~2 MB/s with 1000 people (review). | review |
| D7 | Buttons: green = close and show, light blue = take off the screens, red = reset (asks once more); the rest plain. On phones and touch screens the buttons fill their rows and are at least 44 px high. A focused button that goes away hands the focus to its stand-in (close ↔ reopen, a folded option → "More options"). | The author's colours; a lost focus would let the next Enter move the slide. | author (colours), review (focus) |

### Tasks

#### T1 — Server

- **Files:** `src/polls.js`, `src/live.js`, `test/polls.test.js`.
- **Acceptance criteria:**
  - [x] D1–D4, D6 over the WebSocket, including removing a participant while results are secret or public.

#### T2 — Clients

- **Files:** `public/presenter-poll.js`, `public/viewer-poll.js`, `public/viewer.js`, `public/poll.js`, `public/style.css`, `public/i18n.js`, `test/e2e/poll.spec.js`.
- **Acceptance criteria:**
  - [x] Buttons and folded options as in the goals; projector and participants follow D1, D3, D5.
  - [x] Controls fit, keep their colours (light and dark) and are easy to tap on an Android phone, a small iPhone and an iPhone sideways (Chromium emulation).
  - [x] Keyboard: the focus stays on the controls.

#### T3 — Docs

- **Files:** `README.md`, `docs/deck-format.md`, `docs/security.md`, `CHANGELOG.md`.

### Execution

Mode: single agent

### Verification

`npm run check`, `npm test`, `PW_DISABLE_TS_ESM=1 npx playwright test`;
screenshots of the presenter (computer light and dark, phones), a
participant and the projector checked by eye.

### Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Safari / iOS differences (`<dialog>` with Esc, `color-mix`, touch) | controls look or behave differently on iPhones | standard features only; checked in Chromium emulation; to try on a real iPhone |
| Old presenter pages still open during an update send `close` without `results` | answers close with results secret | the presenter shows them with one more tap; pages reload on update |

### Open questions

None.

## Implementation

Baseline (2026-11-17): `npm test` 182 passed; e2e 97 passed.

- [x] T1 — server — `revealed`, `setOpen(slide, on, revealed)`, `setRevealed`, `forDisplays`, `liveCounts`; `close` with `results`, `reveal`, `conceal`.
- [x] T2 — clients — presenter card with in-sight buttons and folded options; secret mode of the results bars; participant and projector views.
- [x] T3 — docs.

Fixes after an independent review (2026-11-17):
- The docs said viewers see how many answered while results are secret; only the projector does.
- Comments still cited D7 of 0006 / D3 of 0007 for the new rules; this plan now records them.
- The focus fell to the page after a folded option or after close ↔ reopen, so the next Enter moved the slide (e2e "keyboard: …").
- Live ticks sent each participant the whole poll; now one `poll-counts` message for all (D6).
- No test removed a participant while results were secret or public-and-open; added.

## Results

All goals delivered. `npm run check` clean; `npm test` 185 passed;
e2e 104 passed, and `poll.spec.js` 32 passed run twice. Screenshots checked
by eye: presenter on a computer (light and dark), Android phone, small
iPhone, iPhone sideways (with the folded options open), a participant with
results secret, and the projector with results secret. Not tried on a real
iPhone or Android device.

## Closure

2026-11-17 — done. Follow-up: try the controls on a real iPhone (Safari) and
Android phone in class.
