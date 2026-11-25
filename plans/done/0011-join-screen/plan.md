---
id: "0011"
title: "Join screen: QR, address and viewer password on the screens"
type: plan
created: 2026-11-25
---

# 0011 — Join screen: QR, address and viewer password on the screens

Recorded after the fact: asked for and agreed in conversation on
2026-11-25, then implemented in the same session. This plan keeps its
decisions where code comments can point to them.

## Justification

The author teaches with slidecast. At the start of a class the audience has
to reach the room: today the presenter dictates or writes the address and,
for a protected deck, the viewer password. The author wants the presenter to
put, as with the ranking, a screen with a QR code, the address and the
viewer password on the classroom screens (viewer pages with presenter
rights), and the admin to choose per deck whether the password shows.

### Goals

- A presenter, from a computer or a phone, shows and takes off a join screen
  on every screen of the room.
- It shows a QR code that opens the deck, the address to type, and the
  viewer password when the admin allows it for that deck.
- Right in every setup: Cloudflare tunnel, local network, a projector page
  opened at `localhost`, several screens, reconnections.
- No new way for the audience, or anyone without presenter rights, to learn
  the password.

### Non-goals

- Logging in by QR code (the password inside the link): it would end up in
  browser histories and logs.
- Showing the join screen on the audience's own devices.

## Plan

### Context

Live hub `src/live.js` (the ranking on the screens is the model: D20, D27 of
0009), auth and password hashes `src/auth.js`, room settings `src/rooms.js`,
admin routes `src/routes/admin.js`, pages `public/viewer.js`,
`public/presenter.js`, `public/admin.js`. Tests: `npm test`,
`npm run test:e2e`, `npm run check`.

### Approach

A per-room flag `shareShown` in memory, like `rankingShown`, set by a
presenter command and sent as a `share` message to presenter windows and
screens only. Each screen gets the address worked out for itself. The QR
code is drawn in the page by a small encoder with no dependency
(`public/qr.js`), checked against an independent decoder (`jsqr`, a dev
dependency) for every length it accepts.

Passwords are stored only as scrypt hashes, so showing one needs a copy in
clear. Discarded: asking the presenter to type it on each show (a presenter
may not know it) and encrypting it with the config secret (the secret is in
the same file: no real protection, more code). Chosen: an opt-in copy, kept
only while the room shows it and only beside the hash it belongs to.

### Decisions

| # | Decision | Rationale | Source |
| --- | --- | --- | --- |
| D1 | `{t:'share', on}` from presenter windows (rights re-checked, like every room command). In memory only: off after a restart or when the room closes. | Same model as the ranking. | author |
| D2 | The QR code opens `/<slug>/view` (straight in; the login page first when the deck has a viewer password); the text shows `<host>/<slug>`, without the scheme, shorter to type. | Fewer taps for the QR, less to type by hand. | agreed |
| D3 | Address: the admin's **Address for the audience**; else the screen's own origin (its WebSocket `Origin`, checked against `Host`) unless it is a loopback name; else this computer's private IPv4 when the server listens on all interfaces (bridges, VPNs and link-local left out); else none, and the screen says how to set it. Worked out per screen. | A projector at `localhost` is the usual laptop setup; a tunnel needs its public name. A crafted `Origin` only changes its own window. | agreed |
| D4 | **Address for the audience** is a general setting: an http or https origin typed with its scheme, no path, no credentials, at most 100 characters (the QR code holds 213 bytes). | slidecast serves at the root; one server, one public address. | agreed |
| D5 | Per room `showPassword` (default off), in the deck's **Settings**, saved at once like the passwords there. Off: the screen says a password is needed when the deck has one. | Per deck, as viewer passwords are. | author |
| D6 | The clear copy (`decks[slug].viewerClear` in `config.json`) exists only while `showPassword` is on and the hash it belongs to is the current one: turning it on asks for the current password (checked against the hash) unless a new one is set while it is on; any hash change drops it (admin, CLI, also while the server runs) unless the new password was set for a room that shows it; unticking or deleting the deck drops it; a copy the CLI wrote for a room that stopped showing it meanwhile is written out by the server. Never sent to the admin panel or logged. | Minimum exposure for a password meant for the room anyway. | agreed |
| D7 | The `share` message goes only to presenter windows and screens with live presenter rights (otherwise closed with 4401), and carries the password only while shown. Participants never get it. | No new reader of the password. | agreed |
| D8 | Moving the slides, showing a poll, closing it with its results, revealing results or showing the ranking take it off; blanking hides it on the screens without taking it off. It covers a poll or the ranking, which come back when it goes. | The presenter moving on means the room is in; matches the ranking (D20 of 0009). | agreed |
| D9 | Presenter button: an icon beside the tabs on a computer (the toolbar had no room at 1440 px), with its label under **More** on a phone; a strip above the notes says it is on, why something is missing (password not typed yet, room closed, no new people admitted) and takes it off. | Space; one place to see and undo it. | agreed |

### Tasks

#### T1 — QR encoder

- **Files:** `public/qr.js`, `test/qr.test.js`, `package.json` (`jsqr` dev).
- **Acceptance criteria:**
  - [x] Every length 1–213 decodes back with `jsqr`, versions 1–10; longer gives null.

#### T2 — Server: address, password copy, live messages

- **Files:** `src/share.js`, `src/auth.js`, `src/cli.js`, `src/config.js`, `src/rooms.js`, `src/live.js`, `src/server.js`, `src/routes/admin.js`, `test/share.test.js`.
- **Acceptance criteria:**
  - [x] Address rules of D3/D4 unit-tested; screens and presenters get `share`, participants never; only presenters may send it.
  - [x] Password only with `showPassword` and a copy, only while shown; wrong password refused; changes, clearing, unticking, deck deletion and the CLI handled (D6).
  - [x] Slides, poll show/close-with-results/reveal and room closing take it off (D8); a screen without rights is closed, not told (D7).

#### T3 — Pages

- **Files:** `public/share-screen.js`, `public/viewer.js`, `public/presenter.js`, `public/admin.js`, `public/shell.js`, `public/i18n.js`, `public/style.css`, `test/e2e/share.spec.js`.
- **Acceptance criteria:**
  - [x] e2e: admin ticks and confirms the password; presenter on a computer and on a phone shows it; two screens show address, password and a QR code that decodes to the link; the audience page has no join screen; blank hides, next slide takes off.

#### T4 — Docs

- **Files:** `README.md`, `docs/security.md`, `CHANGELOG.md`.

### Execution

Mode: single agent

### Verification

`npm test`, `npm run check`, `npm run test:e2e` all pass; screenshots of the
projector (landscape and portrait) and the presenter (computer and phone)
looked at.

### Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Wrong LAN address guessed (several networks) | QR leads nowhere | Virtual interfaces skipped, private ranges first; the address is visible on the screen; the admin setting overrides it. |
| Viewer password readable in `config.json` | someone with the file reads it | Opt-in per deck, dropped when off; `config.json` already holds the link-signing secret and is out of scope (docs/security.md). |
| A presenter learns the viewer password | — | Intended: they can put it on the projector. Documented. |

### Open questions

## Implementation

Baseline (2026-11-25): `npm test` 230 passed (2 of them then updated for the
new settings fields).

- [x] T1 — `public/qr.js`; `test/qr.test.js` (2 tests, all 213 lengths decode).
- [x] T2 — `src/share.js`, `shareFor`/`sendShare`/`shareOff` in `src/live.js`, `shownPassword`/`setShownPassword` in `src/auth.js`, `PUT /api/admin/rooms/:slug/shown-password`, `audienceUrl` setting; `test/share.test.js` (11 tests).
- [x] T3 — join screen, presenter button and strip, admin controls; `test/e2e/share.spec.js` (2 tests).
- [x] T4 — README, docs/security.md, CHANGELOG.

Deviations:
- D9: the button first went in the toolbar with its label; it made the
  toolbar wrap to two rows at 1440–1536 px, so on a computer it moved beside
  the tabs as an icon.
- An admin e2e test forbids " / " in the admin page; the address hint was
  reworded without `http://`.

## Results

All goals delivered. `npm test` 243 passed; `npm run check` clean;
`npm run test:e2e` 144 passed (Chromium).

## Closure

2026-11-25 — done, uncommitted for the author to review. Not yet tried in a
real classroom with phones scanning the projector.
