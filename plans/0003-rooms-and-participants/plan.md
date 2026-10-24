---
id: "0003"
title: "Rooms and participants"
type: plan
created: 2026-10-24
---

# 0003 — Rooms and participants

## Justification

The author wants the audience to take part, and the admin to run sessions
quickly:

- viewers give a name (or join anonymously) that only presenters see;
- presenters and viewers per room are capped;
- presenters can remove people, even though viewers have no account;
- viewers raise a hand, optionally with a short note; presenters queue,
  attend and resolve them;
- the admin opens and closes rooms (decks) with one click, and `/` follows
  the open one.

Agreed with the author in conversation (2026-10-24). Not released yet, so no
backward compatibility is needed.

### Goals

- Name prompt with an anonymous option; presenters see a participant list.
- Per-deck room settings: max presenters (1–20, default 20), max viewers
  (1–1000, default 200), ask names, hands.
- Kick participants (by token); admin kicks presenters; "no more people".
- Raise hand with an optional note, queue / attend / resolve, rate limited.
- Open / close rooms, "open only this one", `/` follows the open room.

### Non-goals

- Waiting room with per-person approval.
- Banning by IP address.
- Keeping participants, names, hands or notes after the room closes or the
  server restarts.

## Plan

### Context

Live hub `src/live.js`, auth `src/auth.js`, config `src/config.js`, routes
`src/routes/*.js`, client `public/{shell,viewer,presenter,admin,list,selector}.js`,
strings `public/i18n.js`, styles `public/style.css`. Tests: `npm test`,
`npm run test:e2e`.

### Decisions

| # | Decision | Rationale | Source |
| --- | --- | --- | --- |
| D1 | A room is a deck. Its settings and open/closed state live in `config.json` under `rooms[slug]` (not in `deck.json`, so an uploaded deck cannot bring its own limits). Decks start closed; in single-deck mode the room is always open. | Server limits belong to the server. | author |
| D2 | "Home page" (`featured`) is removed. `/`: admin session → full list; one open room → redirect to it; several → list of open rooms if `publicListing` (default on), else landing; none → landing. `/api/decks` for non-admins lists only open rooms. | Simpler: `/` follows the open room. | author |
| D3 | Only the admin opens or closes rooms (admin panel, also from the presenter view). "Open only this one" closes the rest. | | author |
| D4 | Closed room: viewers get no deck link and wait on a "room closed" screen; their socket is parked and told to reload when the room opens. Presenters may enter a closed room. Closing wipes participants, hands, kicks and the "no more people" switch; the numbering restarts. Deck links already handed out keep serving files until they expire (as with viewer passwords). | Agile sessions; data is not kept. | author |
| D5 | Every viewer without presenter rights is a participant. Its first message is `join` with a token (random 32 bytes, issued by the server, kept in `localStorage` per deck, sent in the message, never in the URL). Unknown or no token → new participant with the next number. Viewers with presenter rights (projector) are never participants. | Identity survives reloads; cannot be guessed. | agreed |
| D6 | Name: up to 40 characters, NFC, control characters removed, spaces collapsed; empty = anonymous, shown as "Participant 007" in the presenter's language. Presenters always see the number too. Names and notes are never sent to other viewers, never written to disk or logs. | Duplicates and impersonation; data minimisation (GDPR). | agreed |
| D7 | A participant whose sockets are all gone is kept for 2 minutes (hand included), then removed. | Phone screen locks. | agreed |
| D8 | Presenter limit counts devices (a session, or the local computer) with a window that controls (presenter view, or the projector while controlling), not windows; a display that stopped controlling neither counts nor is refused. The owner (`canAdmin`) is never refused. A refused presenter gets close code 4410 and an offer to join as a viewer. Lowering a limit never disconnects anyone. | Laptop + projector + phone is the normal setup. | author |
| D9 | Viewer limit counts participant sockets; full → close code 4409, the page retries. Participants records (online or in grace) are capped at 2 × max viewers + 50. New participants per address: 200 per minute. | Server load; scripted identities. | agreed |
| D10 | Global WebSocket caps: 500 per address, 1 200 in total, plus 100 reserved for presenter connections. | Classroom behind one NAT address; presenters never locked out by a full server. | author |
| D11 | Kick a participant (any presenter): its token is banned in the room until it closes; its sockets close with 4403 and the page shows "removed" without retrying. "No more people" (any presenter): new tokens are parked until it is turned off; known tokens may reconnect. | Volatile users: a reload must not undo a kick. | author |
| D12 | Kick a presenter: admin only, never an owner device. It removes this deck and `*` from that session's presenter grants and closes its sockets with 4401. | A presenter password holder must not remove the teacher. | author |
| D13 | Hands: one per participant, note up to 280 characters (at most 4 line breaks). States: raised → queued → attending; any → resolved (removed, note deleted). Presenter list order: attending, queue, raised (by time). The participant sees its state and queue position, and is notified (message + vibration) when attended. Raising: 2 per 5 s and 4 per 30 s per participant, enforced by the server. Presenters can lower all hands and turn hands off live. | | author |
| D14 | Participant sockets: at most 30 messages per 10 s, else closed (1008). Names: 5 changes per 30 s. | Spam. | agreed |
| D15 | Viewers receive `state` only when it changes; counts and the participant list go to presenters in a `room` message, at most every 300 ms (1 s above 200 participants). | Avoids O(n²) broadcasts with 1 000 viewers. | agreed |
| D16 | Ask names and hands are per-room settings (admin). With names off, no prompt and every participant is anonymous. | Large conferences. | author |

### Tasks

#### T1 — Room settings, open/close, `/` (D1–D4)
- **Files:** `src/rooms.js` (new), `src/config.js`, `src/routes/{admin,api,pages}.js`, tests.
- **Acceptance:** redirect matrix {0,1,2 open} × {admin} × {publicListing}; PATCH validates ranges and `only`; closed deck API gives viewers no deck link.

#### T2 — Live hub: participants, limits, hands, kicks (D5–D15)
- **Files:** `src/live.js`, `src/participants.js` (new), `src/auth.js`, `test/live.test.js`, `test/rooms.test.js`.
- **Acceptance:** tests for join/reattach, names, grace, caps (4409/4410, owner bypass), kick and ban, lock, kick presenter, hand flow and rate limit, closing wipes, viewers never see others.

#### T3 — Client (viewer, presenter, admin, shell)
- **Files:** `public/*.js`, `public/style.css`, `public/i18n.js`, e2e specs.
- **Acceptance:** e2e: name prompt → name in presenter list; hand with note → attend → viewer notified → resolve; kick shows removed; admin opens/closes, waiting viewer enters when opened; `/` follows.

#### T4 — Docs
- **Files:** `README.md`, `docs/security.md`, `CHANGELOG.md`.

### Execution

Mode: single agent

### Verification

`npm test`, `npm run check`, `npm run test:e2e` all pass.

### Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Kicked person clears storage and rejoins | spam returns | "No more people" (D11) |
| 1 000 viewers on a Raspberry Pi | slow joins | D15; deck download is the larger cost (documented) |

## Implementation

Baseline (2026-10-24): `npm test` 89 passed; `npm run test:e2e` 48 passed.

- [x] T1 — rooms, open/close, `/` — `src/rooms.js`, `PATCH /api/admin/rooms/:slug`; `test/routes.test.js` redirect matrix, `test/rooms.test.js` "rooms start closed…", "single-deck mode…".
- [x] T2 — live hub — `src/live.js`, `src/participants.js`, `auth.sessionKey` / `auth.dropPresent`; 16 tests in `test/rooms.test.js` (join, token, grace, names, hands flow and limits, kick and ban, lock, viewer and presenter limits, kick presenter, closing wipes, flood, join limit).
- [x] T3 — client — `public/participant.js` (name prompt, hand, notices), `public/presenter-room.js` (Hands and People tabs), `public/viewer.js`, `public/presenter.js`, `public/admin.js` (Room column, room settings, live counts); `test/e2e/room.spec.js` 6 tests; screenshots checked at desktop and phone sizes.
- [x] T4 — docs — `README.md`, `docs/security.md`, `docs/deploy-raspberry.md`, `docs/remote-access.md`, `CHANGELOG.md`, website setup step (en/es).

Deviations:
- D8 refined during implementation: only windows that can drive the deck count as presenter devices; a display (projector with *Stop controlling*) is never refused, so a refused presenter can still watch.
- Room counts in the admin panel are refreshed every 5 s by polling, not pushed.

## Results

- All goals delivered. `npm test` 105 passed; `npm run check` clean; `npm run test:e2e` 54 passed (Chromium, also with `--repeat-each 2`).
