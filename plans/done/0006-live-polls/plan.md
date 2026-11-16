---
id: "0006"
title: "Live polls"
type: plan
created: 2026-11-16
---

# 0006 — Live polls

## Justification

The author teaches with slidecast and wants interactive classes: a slide can
carry a poll (a question and its answers, one or several to choose), defined
next to the slide's notes. Arriving at that slide, the presenter view offers
to launch it; once launched, every viewer's screen makes room for it and the
audience answers from their own devices, while the presenter view and the
projector show the results, anonymous, in real time. The poll stays on the
screens until the presenter takes it away, whatever slide comes next; going
back to its slide offers to show it again as it was. Answers can be closed
and reopened at any time.

Agreed with the author in conversation (2026-11-16). Not released yet.

### Goals

- A poll per slide in `deck.json` (`slides[id].poll`), written in the notes
  editor or by hand / by an AI.
- Presenter view: launch, hide, show again, close and reopen answers, reset;
  live, anonymous results. On a computer a *Poll* tab; on a phone a strip
  and a pop-up with the results.
- Viewer on a computer or a phone on its side: the slide shrinks and the poll
  sits on the right, and can be minimised. Phone upright: slide on top, poll
  below.
- Projector (a viewer tab with presenter rights): live results.
- Robust in a live class: reconnections keep each answer, one answer per
  participant, server-side validation and limits, throttled broadcasts.

### Non-goals

- Correct answers, scoring, quizzes with a leaderboard.
- Polls created on the fly during the talk, without a slide.
- Free-text answers, word clouds.
- Keeping answers after the room closes or the server restarts; exporting
  them.

## Plan

### Context

Live hub `src/live.js` (rooms, participants `src/participants.js`, room
helpers `src/rooms.js`), deck store `src/decks.js` (`updateSlide`), notes
summary for updates `src/notes.js`, admin API `src/routes/admin.js`. Client:
`public/presenter.js` + `public/presenter-room.js` (tabs), `public/viewer.js`
+ `public/participant.js`, `public/editor.js`, `public/shell.js`,
`public/i18n.js`, `public/style.css` (no inline styles: CSP). Tests:
`npm test`, `npm run check`, `npm run test:e2e` (locally
`PW_DISABLE_TS_ESM=1 npx playwright test`).

### Approach

The poll's text lives in `deck.json`, like notes, so it travels with the deck
and an AI can write it. The live state of a poll (a *run*: its snapshot of the
text, open or closed, the answers) lives in the room, in memory, like hands.
The presenter sends commands naming a slide; the server reads the definition
from `deck.json` itself. Results go to presenters and displays as counts only.

Discarded: polls in the room settings (`config.json`), because they belong to
the content and must travel with the deck; a poll per step, because the
author thinks in slides; results to participants while voting, because they
bias the answers (they see them once answers close).

### Decisions

| # | Decision | Rationale | Source |
| --- | --- | --- | --- |
| D1 | One poll per slide: `slides[id].poll = {question, options, multiple}`. Plain text, not Markdown. Question up to 300 characters, 2–10 answers of up to 150, cleaned like names (no control characters, spaces collapsed). Launchable once it has a question and two answers; the editor may save it incomplete. Other fields inside `poll` are kept. | Simple to write by hand or by an AI; safe to show anywhere. | author |
| D2 | The server takes the text from `deck.json` when a poll is shown or reset, never from the presenter's message. A run keeps a snapshot; while nobody has answered, a new definition (editor, update) replaces it. With answers, the snapshot stays until *Reset*. | Answers always match the options they were given for. | agreed |
| D3 | At most one poll on the screens. Showing one hides the other, which keeps its answers and its open/closed state; showing a run again brings it back as it was. A shown poll stays shown on every slide until hidden. | "Shown until the presenter closes it". | author |
| D4 | Any presenter controls polls: `{t:'poll', action, slide}` with `show`, `hide`, `open`, `close`, `reset` (as if never launched: the run and its answers go and it leaves the screens; launching it again takes the current definition). Commands of a room run in order. | Same rights as hands. | agreed |
| D5 | One answer per participant, changeable while answers are open: exactly one option, or one or more when `multiple`. Only the shown poll takes answers. 10 answers per 10 s per participant. A removed participant's answer is deleted; one forgotten after the grace period keeps it. | A troll's answers go with them; people who left did answer. | agreed |
| D6 | Results are anonymous: presenters and displays get counts and the number of people who answered, never who chose what. The server keeps each participant's answer only to show it back to them and let them change it. Everything is in memory and gone when the room closes. | Privacy, as names and hands (D6 of 0003). | author |
| D7 | Presenters and displays get every run (`polls`), at most every 300 ms (1 s above 200 participants) while answers arrive, at once on commands. Participants get the shown poll and their own answer (`poll`); results only once answers are closed. | Avoids biasing answers; remote viewers still see the outcome. | agreed |
| D8 | Viewer, landscape: the slide shrinks and the poll takes a column on the right; it can be minimised to a button, and opens again by itself when a poll is shown again or a new one comes. Portrait: slide on top, poll below. *Blank* also hides the projector's poll, not the participants'. | The author's layout; participants keep their controls during a blank, like the hand bar. | author |
| D9 | Presenter view on a computer: a *Poll* tab (only while the slide has a poll or one is shown) with the shown poll and this slide's one; a strip above the other tabs announces the poll and launches it. On a phone: the same strip, and *See* opens a pop-up with the results and controls. | The phone has no room for a fourth tab. | author |
| D10 | Updates (0004): a poll goes with its slide id, like notes; a slide removed by an update with a poll counts as losing its notes. | Same rules as notes. | agreed |

### Tasks

#### T1 — Server: definitions, runs, protocol

- **Objective:** D1–D7 in the live hub and the API.
- **Files:** `src/polls.js` (new), `src/live.js`, `src/participants.js`,
  `src/rooms.js`, `src/decks.js`, `src/notes.js`, tests
  `test/polls.test.js` (new), `test/notes.test.js`, `test/admin.test.js`.
- **Depends on:** —
- **Acceptance criteria:**
  - [ ] `PUT …/slides/:id` stores, cleans, validates and removes a poll; omitting `poll` keeps it.
  - [ ] Show/hide/open/close/reset over the WebSocket; participants answer, change, are refused when closed; presenters get counts without identities; displays get them too; participants get results only when closed.
  - [ ] Reconnection returns the participant's answer; a kick removes it; closing the room forgets everything; unknown slide or incomplete poll → `no-poll`.

#### T2 — Viewer: poll panel, layout, projector results

- **Objective:** D8.
- **Files:** `public/poll.js` (new), `public/viewer-poll.js` (new), `public/viewer.js`, `public/style.css`, `public/i18n.js`.
- **Depends on:** T1
- **Acceptance criteria:**
  - [ ] e2e: a participant answers, changes the answer, sees "closed" and the results; minimise and open again; portrait layout puts the poll under the slide.
  - [ ] e2e: the projector tab shows live counts.

#### T3 — Presenter view and editor

- **Objective:** D9 and the editor section.
- **Files:** `public/presenter-poll.js` (new), `public/presenter.js`, `public/presenter-room.js`, `public/editor.js`, `public/shell.js`, `public/style.css`, `public/i18n.js`, `examples/demo/deck.json`.
- **Depends on:** T1
- **Acceptance criteria:**
  - [ ] e2e: the editor writes a poll into `deck.json`; the presenter launches it, sees answers arrive, closes and reopens answers, hides it, shows it again with its results.
  - [ ] e2e: phone presenter: strip and pop-up.

#### T4 — Docs

- **Files:** `README.md`, `docs/deck-format.md`, `docs/security.md`, `CHANGELOG.md`.

### Execution

Mode: single agent

### Verification

`npm run check`, `npm test`, `npm run test:e2e` pass; screenshots of the
viewer (computer, phone upright and on its side), the projector and the
presenter (computer and phone) checked by eye.

### Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| 1 000 participants answering at once | broadcast storm | D7: counts throttled to presenters only; one small ack per answer |
| A deck that does not rescale when its window shrinks | slide cut off next to the poll | decks are told to scale to the window (deck format); the poll can be minimised |
| A participant forgotten after the grace period comes back as a new one | may answer twice | rare (more than 2 min away); accepted |

### Open questions

None.

## Implementation

Baseline (2026-11-16): `npm test` 144 passed; e2e 75 passed.

- [x] T1 — server — `src/polls.js` (cleanPoll, pollOf, createPolls), `src/live.js` (poll commands queued per room, `vote`, `polls`/`poll` messages, throttle, kick, close, notifyNotes refresh), `src/decks.js` (`updateSlide` with `poll`), `src/notes.js` (D10), `src/participants.js` (vote limit), `src/rooms.js` (`cleanLine`); `test/polls.test.js` 15 tests.
- [x] T2 — viewer — `public/poll.js` (rules and results bars), `public/viewer-poll.js` (participant form, projector results, minimise), `public/viewer.js`; styles for landscape and portrait; `test/e2e/poll.spec.js`.
- [x] T3 — presenter and editor — `public/presenter-poll.js` (strip, cards, controls), `public/presenter.js` (Poll tab, phone pop-up), `public/editor.js` (poll section, step-list mark, only touched polls are sent), demo deck poll on `roles`; e2e in `poll.spec.js` and `editor.spec.js`.
- [x] T4 — docs — `README.md`, `docs/deck-format.md` (and the same AI prompt in `site/index.html`, kept equal by `test/docs.test.js`), `docs/security.md`, `CHANGELOG.md`, `CONTRIBUTING.md`.

Additions and deviations:
- The strip also offers this slide's own poll while another one is on the screens, so a quiz with a poll per slide takes one click per question (D3).
- The projector shrinks the poll's text until it fits without scrolling (a long question with 10 answers).
- The viewer now lets Enter and Space press a focused button (raise hand, poll) instead of moving the slide; on the projector the poll's buttons give the focus back so a clicker's Space still moves the slide.
- `confirmButton` moved from `presenter-room.js` to `shell.js`, shared with the editor.
- An answer sent while the connection drops stays ticked as "not sent yet" instead of being lost.

Fixes after an independent review (2026-11-16), each with a regression test:
- The presenter's poll buttons were rebuilt on every update (several a second while answers arrive): a click could be lost, and the focused button vanished so Enter moved the slide. They are now built once and updated in place (e2e "while answers stream in…").
- A projector whose session ended kept receiving live counts; presenters and displays are now checked before every poll update, and a window that may no longer present is closed with 4401 (it reloads as a participant).
- A show still reading deck.json when the room closed survived the close; commands now carry the room's epoch.
- An answer sent after "close answers" could be counted while a slower command waited ahead of the close; answers now wait in the same queue while it is busy.
- Removing a participant after answers closed left stale results on participants' screens; they now get the new results.
- An unanswered run whose poll was deleted from deck.json could be shown again with its old text; it now goes away (and `refresh` drops such runs unless on the screens).
- The participant panel settles its answer on the server's acknowledgement (`ack`), not on any poll message, and says "could not be sent" after a reconnection that lost it.
- The editor showed a hand-written invalid poll as if valid; it now warns, shows it corrected and saves it corrected with the next change on that slide. The client's launch check has the server's length limits.
- `docs/security.md` and the README said answering twice was impossible; they now say it is once per participant (a browser), that private windows or scripts can add answers within the join limits, and that *Do not admit more people* stops it (D5).

Not done: in portrait, the "no deck API" message and an open hand-note card may cover the bottom of the poll (both rare, both dismissable).

## Results

- All goals delivered. `npm run check` clean; `npm test` 164 passed (20 in `test/polls.test.js`); e2e 85 passed (8 in `poll.spec.js`, 2 new in `editor.spec.js`), and 170 passed with the whole suite run twice. One unexplained failure of "closing the room takes the poll away…" in a repeated run could not be reproduced in 400+ further runs, also under full CPU load.
- Screenshots checked by eye: viewer on a computer (light and dark), phone upright and on its side, a narrow window, the projector (with a 10-answer poll that shrinks to fit), the presenter on a computer (light and dark) and on a phone (upright, on its side, pop-up), and the editor.

## Closure

2026-11-16 — done. All goals delivered and verified locally (unit, e2e,
screenshots), plus the fixes from an independent review. Not yet tried in a
real class with a large audience; CI on `main` pending at closing time.

## Closure

2026-11-16 — done. All goals delivered and verified locally (unit, e2e,
screenshots), plus the fixes from an independent review. Not yet tried in a
real class with a large audience; CI on `main` pending at closing time.
