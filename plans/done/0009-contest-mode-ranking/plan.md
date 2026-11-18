---
id: "0009"
title: "Contest mode: scores, timing and ranking for graded polls"
type: plan
created: 2026-11-18
---

# 0009 — Contest mode: scores, timing and ranking for graded polls

## Justification

The author teaches with slidecast. Polls can already have right answers
(0007) and each participant learns whether they got it right once the
presenter shows the results (0008). There is no score and no ranking, so a
quiz in class cannot have a winner. The author wants a **contest mode**,
set per deck: every graded poll scores points, optionally faster answers
score more, the room sees a top 10 when the presenter chooses, each phone
sees its own points and place, and the presenter can download the final
ranking.

### Goals

- A deck can turn contest mode on, with points per question, a default
  countdown and a weight for speed, in the admin panel's deck settings
  (saved in `deck.json`).
- A poll can override, in the notes editor: its points, its countdown (or
  none), and whether it counts at all.
- In contest mode every participant enters with a name (a nickname is fine,
  "anonymous" is not offered), unique in the room; the presenter can ask a
  participant for another name without losing their points.
- The Raspberry (the server) stamps each answer when it receives it, with a
  monotonic clock; speed is measured against the countdown.
- Optional countdown, shown on the projector, phones and presenter; answers
  close by themselves when it ends or when everyone has answered.
- Points as in D5–D8, counted only once the presenter shows the results;
  each phone explains the points it got.
- Presenter: a Ranking tab, show/hide the top 10 on the screens from the
  poll card, download CSV, restart the contest.
- Participants: their points, their place, and the points of the last
  question.

### Non-goals

- Betting credits on answers (the idea in `CLAUDE.md`, 2026-11-18). The
  score of a question lives in one pure function (`pointsFor` in
  `src/contest.js`) so the bet can be added on top later.
- Keeping the ranking across a server restart or a closed room (it lives in
  memory, like poll answers: D6 of 0006).
- Moving a participant's points to another device (the user chose a
  message only, D14).
- Countdowns for polls outside contest mode.
- Teams, podium animations, sounds.
- Changing the AI prompt in `docs/deck-format.md` (it must equal
  `site/index.html`, checked by `test/docs.test.js`; D29).

### Preconditions

- The working tree has uncommitted work of the author's (first/last
  buttons, blank badge) in `CHANGELOG.md`, `public/i18n.js`,
  `public/presenter.js`, `public/shell.js`, `public/style.css`,
  `site/i18n/es.js`, `site/index.html`, `test/e2e/presenter.spec.js`.
  It must be committed (or set aside by the author) before T1 starts, so
  this plan's diffs do not mix with it. Do not commit it yourself; ask.

## Plan

### Context

- `src/polls.js` — `createPolls()`: one run per slide (`runs` Map, moved to
  the end on every `show`), the shown run, `ballots` (voter id → sorted
  choice array), `counts`, `open`/`revealed`, `define`, `rekey`, `refresh`,
  `setOpen`, `setRevealed`, `reset`, `forget`, `clear`, `forPresenters`,
  `forDisplays`, `forParticipant`, `liveCounts`. `cleanPoll(raw)` cleans a
  poll from `deck.json` or the editor; `pollOf(entry)` returns a launchable
  poll (or null); `gradeOf(choice, correct, multiple)`.
- `src/live.js` — `createLive(ctx, { heartbeatMs, graceMs })`: per-deck
  state `s` (`stateOf`), `snapshot` (`t: 'state'`), `broadcast`,
  `roomChanged` (throttled, 300 ms, 1 s above 200 participants), polls
  section (`sendPolls`, `pollsSoon`, `pollChanged`, `pollCommand` →
  `pollTask` queue → `runPollCommand`, `vote`), `handleConnection`
  (presenter/display connect sends `state`, `notes`, `room`, polls),
  `joinRoom`, `onParticipantMessage` (`name`, `hand`, `vote`), presenter
  commands (`ROOM_COMMANDS`; `kick` calls `s.polls.forget`), `closeRoom`,
  and the returned object (`notifyNotes`, `setViewerNav`, `roomUpdated`,
  `counts`, `resetDeck`, `close`).
- `src/server.js:56` — `createLive(ctx, { heartbeatMs, graceMs })` from
  `buildServer` options.
- `src/participants.js` — `createPeople({ graceMs, onExpire })`; `detach`
  arms a `graceMs` timer that removes the participant; `p.name` is `null`
  for anonymous.
- `src/rooms.js` — room settings in `config.json` (`askNames`, `hands`, …),
  `cleanName` (empty → null), `cleanLine`, `slidingLimit`.
- `src/decks.js` — `normalizeMeta`, `updateSettings(slug, {title,
  viewerNav, aspect})`, `updateSlide(slug, slideId, {notes, steps, poll})`
  (merges the cleaned poll into the stored one, deletes `correct` when
  absent), `upload` (may replace a deck and its deck.json).
- `src/routes/admin.js` — `deckRows()` (rows of `GET /api/admin/decks`, read
  by `openSettings(d)`), `POST /api/admin/decks` (upload →
  `live.resetDeck`), stage commit (→ `resetDeck`, `setViewerNav`,
  `notifyNotes`), `PATCH /api/admin/decks/:slug`, `PATCH
  /api/admin/rooms/:slug`, `PUT /api/admin/decks/:slug/slides/:slideId`.
  `src/routes/api.js` — `GET /api/decks/:slug`.
- Clients: `public/admin.js` (`openSettings(d)`), `public/editor.js`
  (`editablePoll`, `pollFixed`/`pollTouched`, save at ~398), 
  `public/participant.js` (name dialog, `storedChoice`, `who` button, bar),
  `public/viewer-poll.js` (poll on phones and on the projector, `display`
  flag; options tick, then **Send**), `public/viewer.js`,
  `public/presenter.js` (side panel tabs; on a phone the poll opens in a
  dialog, `openPollDialog`), `public/presenter-poll.js` (poll card, strip
  with one-tap **Launch**), `public/presenter-room.js`, `public/shell.js`
  (`confirmButton`, `participantLabel`), `public/poll.js` (client
  `pollOf`, results bars), `public/i18n.js` (en + es), `public/style.css`.
- Docs: `docs/deck-format.md`, `README.md`, `docs/security.md`,
  `CHANGELOG.md`.
- Commands: `npm run check` (syntax), `npm test` (unit + WebSocket tests,
  `test/*.test.js`, helpers in `test/helpers.js`),
  `PW_DISABLE_TS_ESM=1 npx playwright test` (e2e, `test/e2e/*.spec.js`;
  the env var is needed on this machine).

### Approach

Three server layers, each on top of the previous one, then the clients:

1. **Config** (`src/contest.js`): `cleanContest` for the deck's `contest`
   object and three optional poll fields in `cleanPoll`. Strict when saved
   through the API, lenient when read from `deck.json`.
2. **Timing and scoring** (`src/polls.js` + `src/contest.js`): each run has
   an *open clock* (time accumulated while answers are open, paused while
   closed); each ballot records the open clock when it was received. A run
   *counts* once closed with its results shown. `pointsFor` scores one
   ballot; `polls.scores(contest)` sums the counted runs per voter.
3. **Live** (`src/live.js`): contest config in the room state, names
   required and unique, participants kept while offline, countdown timers
   and auto-close through the poll queue, ranking and score messages behind
   one throttle, the `contest` commands, the CSV route.

Discarded:

- *Client timestamps*: phones' clocks differ and can be faked. The server
  stamps on receipt; classroom Wi-Fi delay (tens to hundreds of ms) is
  under 1 % of a 30 s countdown, and a 1 s grace covers late arrivals.
- *`Date.now()` for poll times*: a Raspberry Pi has no real-time clock and
  sets the time by NTP after boot, so the wall clock can jump mid-poll.
  `performance.now()` never jumps.
- *T = actual open time when there is a countdown*: closing early (everyone
  answered) would halve the points of the same answer (UX review).
- *A fresh countdown on reopen*: someone wrong at first could beat someone
  right at first. Reopen resumes the clock instead (user, D8).
- *Speed by order of arrival*: milliseconds of jitter would decide places.
- *Score sent with every vote*: points are secret until the results are
  shown (0008); the ranking changes only when a run starts or stops
  counting.
- *Ranking kept on disk*: answers are never written to disk (D6 of 0006);
  the CSV covers "keep today's result".
- *Moving points to a new device*: the user chose the message only.

### Decisions

Source `user` = asked and answered; `review` = came from the two plan
reviews (see `plan-review.md`); `agreed` = decided by the planner, open to
the author's override.

| # | Decision | Rationale | Source |
| --- | --- | --- | --- |
| D1 | Contest mode is a deck setting: `deck.json` → `"contest": {"on": true, "points": 1000, "time": 30, "speed": 50}`, edited in the admin deck settings dialog. The presenter cannot turn it on or off live; they see the ranking and can restart it. | Rules fixed before class; travels with the deck. | user |
| D2 | `cleanContest(raw, { strict })`: fields `on` boolean (default `false`); `points` integer 1–10000 (default 1000); `time` `null` (no countdown) or integer seconds 5–600 (default 30); `speed` integer 0–100, percent (default 50). Missing fields take the default. Strict (the API) → `{error}` on any invalid field. Lenient (`contestOf(meta)`, reading `deck.json`) → each invalid field takes its default, the rest are kept; a non-object `contest` → all defaults (off). | A hand-written deck with one bad field keeps its contest. | agreed, review |
| D3 | Per-poll fields, all optional: `points` (integer 1–10000; absent = deck default), `time` (`null` = no countdown, integer 5–600; absent = deck default), `contest` (`false` = does not count; absent = counts). `cleanPoll(raw, { strict })`: strict (API) → `{error}` when present and invalid; lenient (`pollOf`, reading `deck.json`) → drops the invalid field and keeps the poll launchable. Kept only when present and valid (`time: null` is kept, `contest: true` is dropped). `updateSlide` deletes each of them from the stored poll when the cleaned poll lacks it. The editor always carries the three fields in its poll object (`editablePoll` and its `same` check include them), shown or not. | Hard questions get more time or points; warm-up questions stay out; nothing is lost by editing with contest off. | user, review |
| D4 | A poll *counts* when contest mode is on, it has right answers, its `contest` is not `false`, it is closed, and its results have been shown since it was last closed (`run.scored`: set by `close` with results or by `reveal` while closed; cleared by `open`; `conceal` does not clear it). Opinion polls never count. A poll that would count once scored is called *graded for the contest* (first three conditions). | Points stay secret until shown (0008); reopening means answers may change. | user, agreed |
| D5 | Correctness `c` of a ballot (C = right options, W = wrong options): one-answer poll → `c = 1` if the choice is right, else 0; several-answer poll → `c = max(0, hits/|C| − misses/|W|)` (second term 0 when `|W| = 0`). No answer → 0. A ballot is *right* when `c = 1`, *partly right* when `0 < c < 1`, *wrong* when `c = 0`; in contest mode these, not `gradeOf`, drive the phone's verdict, the presenter's `right` count and the CSV. | Proportional, guessing does not pay, never below 0; verdict and points always agree. | user, review |
| D6 | Points: `round(P · c · (1 − (speed/100) · t/T))`. P = the poll's points. t = the open clock when the ballot was last received, clamped to `[0, T]`. T = the poll's countdown limit when it has one; without a countdown, the open clock at its last close (`T = 0` → `t/T = 0`). A total is the sum of the rounded points of counted runs. | Speed is measured against the limit, so closing early never lowers anyone's points; a fast wrong answer earns nothing. | user, review |
| D7 | The server stamps each `vote` with `performance.now()` when `onParticipantMessage` receives it, before the poll queue. Changing an answer restamps it. The clock is injectable: `createPolls({ now })`, `createLive(ctx, { now })`, and `buildServer({ now })` passes it on (`src/server.js`). | The server is the only trusted clock; a monotonic one never jumps; tests need a fake one. | user, agreed |
| D8 | Each run has an open clock: `run.openMs` (accumulated) and `run.openedAt` (set while open). `clock(run) = openMs + (open ? now − openedAt : 0)`. `open` on a closed run resumes the clock (no fresh countdown). In contest mode, `open` on a run graded for the contest whose countdown is used up (`clock ≥ limit`) is refused with `{t:'error', code:'time-up'}`, and the presenter card shows "Time's up" instead of **Reopen answers**. Other polls reopen as today. | Reopening is a pause, not a second chance worth more. | user |
| D9 | Countdown limit: the poll's `time` if present, else the deck's `time`, and only for polls graded for the contest; none otherwise. The deadline is reached when the clock reaches the limit. Votes are accepted up to 1000 ms after the deadline (grace), with t capped at T; later ones get `poll-closed`. Clients show the countdown ending 500 ms early and lock the form at 0. Hiding a poll from the screens does not pause it. Poll messages carry `left` (ms left when the message was built; `null` without a countdown); clients count down from their own receipt time. A running countdown keeps its limit until answers close; `time` edits apply from the next opening; turning contest off cancels countdowns (answers stay open). | Predictable rule; slow Wi-Fi does not cost an answer. | user, review |
| D10 | Timers: live keeps `s.countdowns` (slide → timeout, `unref`'d). `syncCountdowns(s)` runs after every poll command, `refresh`, `reset`, `restart`, `closeRoom` and `setContest`; it arms a timer for each open run with a limit from `polls.deadlines()` (slide → ms left incl. grace) and clears the others. Each timer enqueues `pollTask(s, () => expire(slide))`. `closeRoom`, `resetDeck({ removed })` and `close()` clear `s.countdowns` and the ranking throttle timer. | One owner; expiry runs in queue order, so a vote stamped before the deadline but queued behind a `show` is still accepted. | review |
| D11 | Auto-close: in contest mode, a run graded for the contest closes by itself (results secret) when every online participant with a name has a ballot in it; checked after each accepted vote and when a participant goes offline or is kicked. With at least one such participant. | No waiting for the countdown; with D6 nobody loses points. | user |
| D12 | When a poll is closed with results secret, the presenter card shows **Show results** (green) in sight, next to **Reopen answers** (or "Time's up") and **Take off the screens**; it leaves the **More options** fold. Applies to every deck. | After a countdown or auto-close, showing results is the next step. | agreed |
| D13 | In contest mode a participant must have a name. The join dialog has no anonymous button, a hint "Your name will appear in the ranking on the projector and in the teacher's results file. A nickname is fine." and one rules line (D25). `name` messages are accepted even with `askNames` off; a name that cleans to null gets `name-needed`. A `vote` without a name gets `{t:'error', code:'name-needed', about:'poll'}` and the page opens the dialog. The page asks again when the stored choice is anonymous (`{name: null}`). The "You: …" button stays enabled in contest mode. Turning `askNames` off keeps names while contest is on; turning contest off while `askNames` is off wipes names as `roomUpdated` does. Duplicates that existed before contest was turned on are left alone. | Everyone enters with a name; texts tell the truth about who sees it. | user, review |
| D14 | Names are unique per room in contest mode, compared with `toLocaleLowerCase('und')` after `cleanName`, against every participant kept (online or not). A taken name gets `{t:'error', code:'name-taken', offline: <bool>}`; the dialog stays open with "That name is already taken; add an initial" or, when its owner is offline, "That name belongs to someone who is offline. If it's you on another device, the presenter can free it by removing that entry (its points are lost), or pick another name." | Two "Ana" in a public ranking confuse; a student who changed device knows what to do. | agreed, user (message only) |
| D15 | Kept participants: `createPeople({ graceMs, keep: (p) => boolean })`, checked in `detach` and in the timer callback. Live passes `keep = (p) => contest on && p.name !== null && polls has a ballot of p.id`. A kept participant stays (offline) until the room closes, it is kicked, or contest is turned off; the same browser (token) comes back as the same participant. On contest on, grace timers of qualifying participants are cancelled (`people.keepNow()`); on contest off, `people.expireOffline()` arms grace timers for offline ones. | A locked phone keeps its score; join-and-leave clients still expire. | agreed, review |
| D16 | "Ask for another name": `{t:'contest', action:'rename', id}` from presenters sets that participant's name to null, keeps its points, and sends it `{t:'you', …, renameAsked: true}`; its phone opens the dialog with "The presenter asked you to pick another name". Until it does, it shows as `#n` (participant number) in the ranking. | Fix a bad nickname without throwing the student out. | user |
| D17 | Ranking: participants with at least one ballot in a counted run, sorted by points (descending), then name (`localeCompare`, null names last, shown as `#n`). Equal points share a place (1, 2, 2, 4). | Simple and explainable. | agreed, review |
| D18 | `run.seq`: per-room counter set when a run is created (CSV column order). `run.scoredSeq`: per-room counter set each time `scored` becomes true; `last` (D19) is the counted run with the highest `scoredSeq`. | Map order is "last shown", not launch order. | review |
| D19 | Messages, all built by one throttled `rankingSoon(s)` (300 ms, 1 s above 200 participants) that computes the ranking once: presenters `{t:'ranking', on, shown, counted, unscored, rows:[{id, n, name, online, points, pos, answered, right}]}` (`counted` = counted runs; `unscored` = slides of runs graded for the contest, closed, results not shown; `answered`/`right` per D5); displays `{t:'ranking', shown, total, rows:[{pos, name, points}]}` (first 10 while shown, else `rows: []`; `total` = ranked participants); each participant `{t:'score', on, points, pos, of, last}` (`pos` null when not ranked; `last` = `{id, points, c, t, T}` of D18's run, or null), sent only to participants whose message changed. Triggers: a run starts/stops counting, a key/points/exclusion/speed change, rename, kick, contest settings change, show/hide ranking, restart. Also sent on connect (`handleConnection`: ranking to presenters and displays) and on join (`joinRoom`: score). | Bounded load on a Raspberry with 1000 people; reloads and reconnections see the ranking at once. | agreed, review |
| D20 | Commands `{t:'contest', action}` from presenters, in the poll queue: `show-ranking`, `hide-ranking`, `restart` (forgets every run of the room with `polls.clear()`, cancels countdowns, hides the ranking; participants and names stay), `rename` (D16). All refused with `contest-off` when contest is off, `forbidden` from participants. Showing the ranking takes the poll off the screens; showing a poll, or a presenter moving to another slide, takes the ranking off. | One overlay at a time; the ranking never stays over the slides by mistake. | agreed, review |
| D21 | CSV: `GET /api/decks/:slug/contest.csv?lang=en\|es`, allowed when `auth.canPresent(req, slug)` (else 403), 404 when the deck has no live state. UTF-8 with BOM, `;` separator, CRLF. Columns: position, name (`#n` when null), number, points, right, answered (en `Position;Name;Number;Points;Right;Answered`, es `Puesto;Nombre;Número;Puntos;Aciertos;Respondidas`), then one per counted run in `seq` order, headed by its question, holding that participant's points. Cells quoted with `"` (doubled inside); a cell starting with `=`, `+`, `-`, `@`, tab or CR gets a leading `'`. File name `<slug>-ranking-<YYYY-MM-DD>.csv`. The presenter page links with its own language. | Spreadsheet-ready in Spanish Excel; no formula injection from names. | user, agreed, review |
| D22 | `snapshot` (`t:'state'`) and `GET /api/decks/:slug` carry `contest: <on>`; `GET /api/decks/:slug` also carries `contestConfig` (the cleaned object) for presenters. `deckRows()` carries `contest: contestOf(meta)`. `live.setContest(slug, config)` applies a config live; called after `PATCH /api/admin/decks/:slug`, and by `resetDeck(slug)` (not removing), which re-reads the meta, so uploads and stage commits apply it too. | Every page and path has the config it needs. | agreed, review |
| D23 | Runs that count are never dropped by the 100-run cap in `polls.show`. | A long contest keeps old points. | agreed |
| D24 | Scores are computed from the runs each time: changing a key (0007 rekey), a poll's points or exclusion, or the deck's points or speed rescores counted runs; the docs say so. | One source of truth; a wrong key can be fixed in class. | review |
| D25 | Phone (participant): in contest mode, a one-answer poll sends on tap (tapping another option re-sends it); several-answer polls keep **Send**, with "Not sent yet" while the selection is unsent. Above the question: "Up to {P} points · faster earns more" or "This question does not count for the contest". Under a countdown: the seconds left and "Changing your answer resets your time". After results: verdict from `c` (D5) and one line, e.g. "You got 1 of 2 right answers and ticked 1 wrong one · answered in 10 s of 20 s → +750 of 1000" ("You didn't answer: +0"). When answers reopen on a counted run: "This question's points are on hold". Bar: "{points} pts · {pos}º of {of}", or "0 pts · not ranked yet". Join dialog rules line: "Each question gives up to {P} points; answering sooner gives more; wrong ticks take points away." | Fun, fair and explainable on the screen students watch. | review |
| D26 | Presenter: poll card chips "Contest · {P} pts · {s} s" or "Does not count"; after a graded poll's results are shown, **Show ranking** in sight next to **Take off the screens**; while the ranking is on the screens, the strip reads "Ranking on the screens" with a **Take off** button (light blue `p-poll-off` style). Ranking tab (only in contest mode; label "Ranking"): banner "{n} question(s) not scored yet: show their results so they count" with a **Show results** button per run (from `unscored`); rows with place, name, points, right/answered, offline mark, **Ask for another name**, and kick; **Show / Take off ranking**, **Download CSV**, **Restart contest** (red; confirmation "All points will be erased." with **Download CSV first** and **Restart**). Launching another poll while one is in `unscored` uses `confirmButton`: "The previous question has not scored yet. Launch anyway?". On a phone the Ranking opens in a dialog from the **More** menu, as the poll does (`openPollDialog`). | The natural flow (countdown → show results → show ranking → next slide) takes no tab switch; no question silently fails to count. | review |
| D27 | Projector: the ranking is a full-screen overlay titled "Ranking · top 10 of {total}"; rows in large type with a fixed minimum size (no shrinking below it), names cut at 20 characters with an ellipsis, points with a thousands separator (`toLocaleString`), the first three rows bold with the accent colour. The countdown is a large number that turns to the warning colour in the last 5 s. | Readable from the back row. | review |
| D28 | Admin settings dialog: a "Contest" section above the **Save changes** row: "Contest mode" checkbox; "Points per question" (1000); "Countdown" (seconds, with "No countdown"); "Slowness penalty" % (50); the fields disabled while the mode is off; a live hint "Right at once: {P} · at the last second: {P·(1−w)} · 0 % = time does not matter. Only polls with right answers count, and they score when you show the results." While contest mode is ticked, the name checkbox shows ticked and disabled with "Contest mode always asks for a name". Editor: a graded poll always shows a "Contest" fieldset (points, countdown select "Deck default ({s} s)" / "No countdown" / "Custom" + seconds, "Counts for the contest" checkbox); with the deck's mode off it is disabled with "Contest mode is off for this deck (Settings in the admin panel)"; opinion polls show "Opinion polls do not count"; several-answer graded polls show "Each wrong option ticked takes away 1/{W} of the points". All texts in en and es. | Every setting explains itself where it is set. | review |
| D29 | The AI prompt block in `docs/deck-format.md` is not changed (it must equal `site/index.html`, which has the author's uncommitted work). The new fields are documented elsewhere in that file. | Avoids touching the website and a failing docs test. | review |

### Tasks

#### T1 — Contest config in deck.json and the poll fields

- **Objective:** Contest settings and per-poll fields are validated
  (strict on save, lenient on read), saved and served (D1–D3, D22 API
  parts).
- **Files:** `src/contest.js` (new: `CONTEST_DEFAULTS`, `CONTEST_LIMITS`,
  `cleanContest`, `contestOf`), `src/polls.js` (`cleanPoll`, `pollOf`),
  `src/decks.js` (`updateSettings` accepts `contest`; `updateSlide` deletes
  absent poll fields), `src/routes/admin.js` (PATCH passes and returns
  `contest`; `deckRows()` adds `contest`), `src/routes/api.js` (`contest`,
  `contestConfig`), `test/contest.test.js` (new), `test/polls.test.js`,
  `test/decks.test.js`, `test/routes.test.js`.
- **Depends on:** —
- **Acceptance criteria:**
  - [ ] `npm test` passes, with tests: `cleanContest({}, {strict: true})` returns the D2 defaults; strict out-of-range `points`/`time`/`speed` or non-boolean `on` → `{error}`; `contestOf({contest: {on: true, time: 3}})` → `on: true, time: 30`; `contestOf({})` → defaults, `on: false`.
  - [ ] Strict `cleanPoll` keeps `points: 2000`, `time: null`, `time: 60`, `contest: false`, drops `contest: true`, rejects `time: 3`, `points: 0`, `contest: 'no'`; `pollOf` of a slide with `time: 3` returns a launchable poll without `time`.
  - [ ] `PATCH /api/admin/decks/:slug` with `{contest: {on: true, time: null}}` saves and answers the cleaned object; invalid → 400; `GET /api/admin/decks` rows carry `contest`.
  - [ ] `PUT …/slides/:slideId` with a poll without `points` deletes a stored `points` (same for `time`, `contest`).
  - [ ] `GET /api/decks/:slug` has `contest` (boolean) for everyone and `contestConfig` only for presenters.

#### T2 — Open clock, deadlines and scoring in the runs

- **Objective:** Runs keep an open clock and ballot stamps with an
  injectable clock, know when they count, enforce deadlines with grace,
  and produce scores and a ranking (D4–D9 core, D17, D18, D23, D24).
- **Files:** `src/contest.js` (`pointsFor({ choice, at }, run, contest)` →
  `{points, c, t, T}`, `rankingOf(scores, people)`), `src/polls.js`
  (`createPolls({ now })`; `run.openMs`, `run.openedAt`, `run.stamps` Map
  voter → `at` next to `ballots`; `run.scored`, `run.seq`,
  `run.scoredSeq`; per-poll fields on the run, followed by `rekey`;
  `vote(voter, id, choice, at, contest)`; `clock(slide)`;
  `deadlines(contest)`; `expire(slide, contest)`; `answeredBy(slide)`;
  `scores(contest)`; `left` in the three `for…` views; `setOpen` returns
  `'time-up'` per D8; D23 cap rule), `test/contest.test.js`,
  `test/polls.test.js`.
- **Depends on:** T1
- **Acceptance criteria:**
  - [ ] `npm test` passes with fake-clock tests, for P = 1000, speed 50, 5 options, right `[0, 2]`, countdown 20 s: ballot `[0, 2]` at 10 s → 750; `[0, 1]` at 0 s → 167; `[1, 3]` → 0; one-answer poll, right at 20 s → 500, wrong → 0; speed 0 → 1000 at any time; a ballot at 10 s still scores 750 when answers closed at 12 s.
  - [ ] Without a countdown, closed at 8 s: a right ballot at 4 s → 750.
  - [ ] Close at 6 s, reopen, a ballot at 2 s after reopening has t = 8 s; with the 20 s countdown used up, `setOpen(slide, true)` returns `'time-up'` in contest mode.
  - [ ] A vote at deadline + 900 ms is accepted with t = T; at deadline + 1100 ms → `poll-closed`; `expire` closes with results secret; a stamp below 0 or above T is clamped (points never exceed P).
  - [ ] `scored` follows D4 (close with results → counts; close without, then `reveal` → counts; `open` → stops; `conceal` → still counts); an opinion poll and a `contest: false` poll never appear in `scores`; changing `speed` rescores.
  - [ ] `rankingOf` gives 1, 2, 2, 4 on ties, orders ties by name, puts null names last; `seq` and `scoredSeq` follow D18.

#### T3 — Live: names, kept participants, rename

- **Objective:** Contest mode's rules for people work over the WebSocket
  (D13–D16, D22 live part).
- **Files:** `src/live.js` (contest in state and snapshot, `setContest`,
  `resetDeck` re-reads contest, `name` handling, `rename` command),
  `src/participants.js` (`keep`, `keepNow`, `expireOffline`),
  `src/server.js` (`now` option, D7), `test/contest-live.test.js` (new),
  `test/routes.test.js`.
- **Depends on:** T2
- **Acceptance criteria:**
  - [ ] `npm test` passes with WebSocket tests: vote without a name → `name-needed`; empty name → `name-needed`; duplicate name in another case → `name-taken` (with `offline` true when its owner is offline); `askNames` off keeps names while contest is on; contest off with `askNames` off wipes them.
  - [ ] With a small `graceMs`, a named participant with a ballot is still listed offline after the grace time and reconnecting with its token keeps its id; an unnamed one expires; after contest off the named one expires.
  - [ ] `rename` clears the name, keeps points, and the participant gets `renameAsked: true`.
  - [ ] An upload replacing a deck with a different `contest` updates `snapshot.contest` without a restart.

#### T4 — Live: countdowns, auto-close, ranking and commands

- **Objective:** Countdowns, auto-close, ranking/score messages and the
  `contest` commands work end to end (D8–D11, D19, D20).
- **Files:** `src/live.js` (vote stamping before the queue, `s.countdowns`,
  `syncCountdowns`, auto-close, `rankingSoon`, sends on connect and join,
  `show-ranking`/`hide-ranking`/`restart`, ranking off on slide change and
  poll show, cleanup in `closeRoom`/`resetDeck`/`close`),
  `test/contest-live.test.js`.
- **Depends on:** T3
- **Acceptance criteria:**
  - [ ] `npm test` passes; WebSocket tests use the fake clock from `buildServer({ now })` for points, and real timers only for one 5 s countdown test.
  - [ ] A 5 s deck countdown closes answers by itself with results secret; `left` is in poll messages; a vote stamped before the deadline but queued behind a pending `show` is accepted.
  - [ ] Two named online participants answering a graded poll close it by themselves.
  - [ ] After close-and-show, presenters get `t:'ranking'` with the expected points and `unscored: []`; before showing, `unscored` lists the slide; each participant gets `t:'score'` with points, place and `last`; displays get `rows: []` until `show-ranking`, then at most 10 rows; `show-ranking` takes the poll off the screens; a `goto` takes the ranking off; `restart` empties the ranking.
  - [ ] A presenter or display connecting while the ranking is shown gets it; a participant reconnecting gets its `score`.
  - [ ] `contest` commands with contest off → `contest-off`; from a participant → `forbidden`; `open` on a used-up countdown → `time-up`.
  - [ ] A test closes the room while a 5 s countdown runs, reopens it, and receives no `poll` or `ranking` message caused by the old timer during the next 6 s.

#### T5 — CSV route

- **Objective:** Presenters download the ranking as a spreadsheet-ready
  CSV (D21).
- **Files:** `src/live.js` (`contestCsv(slug, lang)`), `src/routes/api.js`
  (route), `test/contest-live.test.js`.
- **Depends on:** T4
- **Acceptance criteria:**
  - [ ] `npm test` passes: 403 without presenter rights; 404 without live state; for a presenter, a body starting with the BOM and `Position;Name;Number;Points;Right;Answered`; with `?lang=es`, `Puesto;Nombre;Número;Puntos;Aciertos;Respondidas`; a name `=1+1` written as `"'=1+1"`; one column per counted run in `seq` order; `Content-Disposition` with `<slug>-ranking-<YYYY-MM-DD>.csv`.

#### T6 — Admin and editor

- **Objective:** The author sets contest mode up in the admin panel and
  per poll in the editor (D3 editor part, D28).
- **Files:** `public/admin.js`, `public/editor.js`, `public/i18n.js`,
  `public/style.css`, `test/e2e/contest.spec.js` (new), `test/e2e/editor.spec.js`.
- **Depends on:** T1
- **Acceptance criteria:**
  - [ ] `npm run check` and `npm test` (incl. `test/i18n.test.js`) pass.
  - [ ] e2e: turning contest on in settings saves `contest.on: true`, disables-and-ticks the name checkbox, and the hint shows "1000 · … 500"; the editor shows the Contest fieldset for a graded poll and saves `points: 2000`; with contest off, editing that poll's question keeps `points: 2000`; a hand-written poll with `points` loads without the "fixed" warning.

#### T7 — Participant phone and projector

- **Objective:** Students join, answer, follow the countdown and see their
  score; the projector shows countdown and ranking (D13, D14, D16, D25, D27).
- **Files:** `public/participant.js`, `public/viewer-poll.js`,
  `public/viewer.js`, `public/i18n.js`, `public/style.css`,
  `test/e2e/contest.spec.js`.
- **Depends on:** T4, T6
- **Acceptance criteria:**
  - [ ] `npm run check` and `npm test` pass.
  - [ ] e2e (contest deck, `speed: 0` so points are deterministic): a participant cannot enter without a name and has no anonymous button; a taken name keeps the dialog open with the error; a one-answer poll sends on tap; after close-and-show the phone shows the verdict, the explanation line and "+1000 of 1000" (right) or "+0" (wrong), and its place in the bar; after `rename` the phone asks for a name; the projector shows the countdown, then after **Show ranking** the overlay with the right participant first.
  - [ ] Screenshots checked by eye: phone with countdown, phone with score (Android and small iPhone emulation), projector ranking.

#### T8 — Presenter

- **Objective:** The presenter runs the contest from the poll card and the
  Ranking tab (D8 card part, D12, D26).
- **Files:** `public/presenter.js`, `public/presenter-ranking.js` (new),
  `public/presenter-poll.js`, `public/i18n.js`, `public/style.css`,
  `test/e2e/contest.spec.js`, `test/e2e/poll.spec.js`.
- **Depends on:** T7
- **Acceptance criteria:**
  - [ ] `npm run check` and `npm test` pass; `PW_DISABLE_TS_ESM=1 npx playwright test` passes in full.
  - [ ] e2e: chips show "Contest · 1000 pts · 5 s"; after the countdown, **Show results** is in sight (also covered in `poll.spec.js` for a non-contest deck closed without results); then **Show ranking** is in sight and puts the ranking on the projector, the strip shows **Take off**; the Ranking tab lists one right and one wrong participant in that order; the banner lists a closed unscored poll and its **Show results** scores it; launching another poll over an unscored one asks first; **Download CSV** downloads a file starting with `Position;Name` (or `Puesto;Nombre` in Spanish); **Restart contest** asks, then empties the list; on a phone-sized page the Ranking opens from **More**.
  - [ ] Screenshots checked by eye: Ranking tab light and dark, poll card with countdown, phone presenter dialog.

#### T9 — Docs

- **Objective:** Authors and teachers can learn contest mode without
  reading code.
- **Files:** `docs/deck-format.md` (`contest` and the three poll fields
  outside the AI prompt block, the formulas of D5–D6 with T2's numbers,
  reopen and rescoring rules), `README.md` (feature line),
  `docs/security.md` (names in a public ranking, CSV download by
  presenters, formula-injection guard, server-side times),
  `CHANGELOG.md`, `CLAUDE.md` (betting idea: one line saying it builds on
  0009's `pointsFor`).
- **Depends on:** T8
- **Acceptance criteria:**
  - [ ] `npm test` passes (including `test/docs.test.js`; the AI prompt block is unchanged).
  - [ ] `grep -n '"contest"' docs/deck-format.md` finds the example; the doc shows 750, 167 and 0 for T2's first case.

### Execution

Mode: single agent. `src/live.js`, `src/polls.js`, `public/i18n.js` and
`public/style.css` are shared by most tasks, and the clients need the exact
message shapes of T3–T5; packages would share files.

### Verification

- `npm run check`, `npm test`, `PW_DISABLE_TS_ESM=1 npx playwright test`
  all pass; `poll.spec.js` and `contest.spec.js` run twice in a row without
  a failure (no flaky timing).
- Manual scenario with a presenter, a projector and two phone-sized
  participants: 1000 points, 30 s countdown, speed 50 %, one one-answer and
  one several-answer graded poll; points match D5–D6 by hand; reopen
  resumes the clock; the CSV opens in LibreOffice with one column per
  question.

### Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Phones receive the poll a few hundred ms apart on a busy Wi-Fi | small speed differences not caused by the student | accepted: under 1 % of points with a 30 s countdown; 1 s grace for late votes; documented |
| Kept offline participants fill the room cap (`maxViewers * 2 + 50`) | newcomers refused in very large rooms | only named participants with a ballot are kept (D15); kick frees them |
| Timing tests flaky | CI noise | fake clock for points; one real 5 s countdown per suite; per memory, find the root cause before any retry |
| Ranking work on a Raspberry with 1000 people | lag on reveal | one throttled computation; score sent only to participants whose value changed (D19) |
| Offensive nicknames on the projector | embarrassment in class | presenter sees the ranking first; **Ask for another name** (D16); kick |
| Uncommitted author work in the tree | mixed diffs | precondition: committed or set aside before T1 |

### Open questions

None.

## Implementation

Baseline (2026-11-18, after the author's commit f6834ba): `npm test` 185
passed; e2e 105 passed.

- [x] T1 — config — `node --test test/contest.test.js` (4 config/API tests) pass; `npm test` 189 passed (the admin PATCH answer now carries `contest`, `test/admin.test.js:137` updated).
- [x] T2 — clock, deadlines, scoring — fake-clock tests in `test/contest.test.js` (750/167/0, 500/0, speed 0 → 1000, no countdown 750, reopen t = 8 s and `time-up`, 1 s grace, clamp, D4, overrides, ranking ties, D18, cap); `npm test` 197 passed. New fields in the exact-shape poll test (`test/polls.test.js`).
- [x] T3 — live: names, kept participants, rename — `test/contest-live.test.js`: name-needed, name-taken (online/offline), askNames off keeps names, contest off wipes them; kept offline + same token back with its score; unnamed expires; rename; replaced deck.json applies via `resetDeck`.
- [x] T4 — live: countdowns, auto-close, ranking, commands — same file: real 5 s countdown closes (results secret), room close cancels it (no message in 6.5 s); auto-close; ranking 750/500 with fake clock, `unscored`, score `last` {c, t, T}, top 10 only once shown, late display, `goto` takes it off, restart; `time-up`, `forbidden`, `contest-off`. Queued vote received in time accepted (`test/contest.test.js`). Run twice: 9/9 both times.
- [x] T5 — CSV route — 403 / 404 / BOM + headers en and es / `"'=1+1"` / filename. `npm test` 207 passed.
- [x] T6 — admin and editor — `test/e2e/contest.spec.js`: settings turn contest on, name box ticked+locked with hint, live hint 1,000/500 → 800 at 20 %, saved `{on: true, points: 1000, time: null, speed: 20}` with `askNames` kept; editor shows points 2000 without the "fixed" warning, saves `time: 60`, `contest: false`, wrong-tick cost 1/1; with contest off the fields are disabled and editing the question keeps `points: 2000`. `npm test` (i18n) pass.
- [x] T7 — participant phone and projector — same spec: no anonymous button, empty name refused, taken name keeps the dialog with its error; one tap sends; auto-close; "Right answer → +1,000 of 1,000" / "Wrong answer → +0 of 1,000"; bar "1,000 pts · 1º of 2"; rename asks again; projector countdown, several-answer Send with "Not sent yet", countdown closes answers, "You didn't answer: +0", top 10 overlay with Ana first, poll off the screens, hidden again.
- [x] T8 — presenter — `test/e2e/contest.spec.js`: chip "Contest · 1,000 pts · 5 s", countdown, closed by itself, "Show results" in sight with "Time's up"; launching over an unscored question asks first (`#poll-confirm`); everyone answered → closed; Ranking tab banner lists the question, its "Show results" scores it, rows Ana 1,000 then Bea; "Show ranking" from the card puts it on the projector, strip "Ranking on the screens" with "Take off"; CSV download starts with BOM + `"Position";"Name"`; restart asks, then empties; phone presenter opens the Ranking from More. `poll.spec.js` updated for D12 (16 pass). Screenshots checked by eye (Spanish UI): presenter countdown, closed secret, results, Ranking light/dark, phone presenter More and Ranking dialog, projector countdown and ranking light/dark, phones (Pixel 7, iPhone SE) joining, countdown, sent, wrong, partial, multi, admin settings (desktop, phone), editor fieldset.
- [x] T9 — docs — `docs/deck-format.md` (Contest mode section, `contest` row, 750/167/0 example; AI prompt untouched), `README.md`, `docs/security.md`, `CHANGELOG.md`, `CLAUDE.md`. `npm test` 207 passed (docs test included).

Verification (2026-11-18): `npm run check` clean; `npm test` 207 passed;
`PW_DISABLE_TS_ESM=1 npx playwright test` 111 passed, twice in a row; the
contest presenter test 8/8 and `poll.spec.js` 4×16 with other specs running
alongside (load).

Code review (2026-11-18), two independent reviewers (server; browser and docs), every finding fixed with a test:
- Server: a participant asked for another name lost its points if its phone went offline before choosing (now kept, `renameAsked` repeated on every join until it picks one); every rejoin recomputed the whole ranking (now through the throttle, which also marks it online for presenters); after reopening, the first changed answer closed the poll for everyone (auto-close now only on a first answer); a CSV test for a deck with no live state.
- Browser: the presenter's countdown wound back on unrelated renders (now counted from the polls message's arrival); the projector cut the 10th row (rows sized for ten; e2e at 1920×1080, 1366×768, 1280×720); a second tap while the first was on its way stayed unsent with no Send (sent after the ack; Send shows when a choice is stuck; arrow keys send once they settle); after **Show ranking** in the Poll tab nothing said so (now a line with **Take off**, which takes the focus); a participant left without a name got no dialog after a reload, and a rename prefilled the old name; the Ranking tab was rebuilt on every vote (now only on change, focus kept); focus could land on the "Time's up" text; the editor dropped out-of-range values silently (now marked, the last valid value stays); presenter chips used the settings from page load (the ranking message carries them); Spanish plural.
- `npm run check` clean; `npm test` 210 passed; e2e 112 passed twice; `contest.spec.js` 3×7 and `poll.spec.js`/`room.spec.js` 2× under load, all passed.

Deviations:
- T1, T2: the API tests live in `test/contest.test.js` rather than `test/routes.test.js` / `test/decks.test.js`, next to the rest of contest mode. Tests were written together with the code, not seen failing first.
- T4/T7: the server also sends `speed` in a poll's contest view (the phone says "faster earns more" only when it is above 0); the join rules line carries no numbers (participants do not get the deck's settings).
- T8: the ranking rows also carry **Remove** (kick), as D26 lists; the launch confirmation shows inside the Poll panel too (`#poll-confirm`), since the strip is hidden while the Poll tab is open; which questions are unscored is computed from the polls message (it arrives with the closing) rather than the throttled ranking message — found as a race under load.
- T8: the client `pollOf` (`public/poll.js`) keeps the contest fields too, for the presenter's chips.
- Flaky test found and fixed: `poll.spec.js` "keyboard…" focused the More button before the card showed (Playwright's `focus()` does not wait); it now waits for "Taking answers". Pre-existing, seen under load.
- Not fixed (pre-existing, outside this plan): on a 320 px phone (iPhone SE emulation) the results bars' "Correct" / "Yours" badges squeeze the answer text into a vertical column.
- T2: in contest mode the per-poll grades (right / partly / wrong counts) of graded polls also follow D5's correctness, so the bars, the verdict and the points agree.

## Results

All goals delivered:

- Contest mode set per deck in the admin settings (`contest` in deck.json) and per poll in the editor (points, countdown, out of the contest) — T1, T6.
- Names required and unique in contest mode; **Ask for another name** keeps points — T3, T7, review fixes.
- Answer times stamped by the server on a monotonic clock; open clock across close/reopen; 1 s grace — T2, T4.
- Optional countdown on projector, phones and presenter; auto-close on countdown end or when everyone answered — T4, T7, T8.
- Points per D5–D6, counted only once results are shown; phones explain them — T2, T7.
- Presenter Ranking tab (phone: from More), top 10 on the screens, CSV (es/en), restart — T5, T8.
- Participants see their points, place and last question's points — T4, T7.

Evidence: `npm run check` clean; `npm test` 210 passed (`test/contest.test.js`, `test/contest-live.test.js`); `PW_DISABLE_TS_ESM=1 npx playwright test` 112 passed twice in a row (`test/e2e/contest.spec.js` 7 tests). Screenshots checked by eye in the Spanish UI on desktop, Pixel 7 and iPhone SE emulation, light and dark. Not tried on real phones or a real projector.

Not delivered / found outside the scope: on a 320 px phone the results bars' "Correct" / "Yours" badges squeeze the answer text (pre-existing, 0007/0008).

## Closure

2026-11-18 — done. Follow-ups: the 320 px results-bar layout above; try a contest in class on real phones (Android, iPhone) and the classroom projector; betting credits (CLAUDE.md idea) builds on `pointsFor`.
