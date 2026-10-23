---
id: "0002"
title: "Hardening and viewer control"
type: plan
created: 2026-10-23
---

# 0002 — Hardening and viewer control

## Justification

After trying v1 (0001) the author asked for small follow-ups, keeping them
simple:

- a viewer window that controls the deck (projector case) cannot stop
  controlling;
- changing a deck's default viewer mode in the admin panel only takes effect
  for new live state, not for viewers already connected;
- login has only a per-minute limit, so a patient attacker gets ~7 000
  guesses a day per address, and failed attempts leave no trace;
- nothing caps how many WebSocket connections one address can open;
- `12345678` is an accepted password;
- the deployment guide does not mention Cloudflare's own protections.

### Goals

- Viewer page can stop and resume controlling, with one click.
- Admin's default viewer mode applies live to connected viewers.
- Failed logins are limited per hour and logged.
- WebSocket connections are capped per address and in total.
- New passwords need a letter and a digit.
- The Raspberry guide explains Cloudflare Access for `/admin` and a managed
  challenge (bot check) on sign-in pages.

### Non-goals

- Turnstile or any CAPTCHA inside syncdeck (done at Cloudflare instead, no
  code).
- Changing the global per-minute login limit.
- Invalidating existing passwords that do not meet the new rule.

## Plan

### Context

Live hub `src/live.js`, login routes and limits `src/auth.js`, admin API
`src/routes/admin.js`, viewer `public/viewer.js`, strings `public/i18n.js`,
docs `docs/security.md`, `docs/deploy-raspberry.md`. Tests: `npm test`,
`npm run test:e2e`.

### Decisions

| # | Decision | Rationale | Source |
| --- | --- | --- | --- |
| D1 | Viewer with present rights shows a "Stop controlling" button next to the *Controlling* badge; when stopped, a "Control" button. The choice is kept per tab in `sessionStorage` and applied by reloading the page. Buttons fade while idle, like the badge. | Simplest: no live role switch on the socket. | user (keep it simple) |
| D2 | `PATCH /api/admin/decks/:slug` with `viewerNav` also sets the live state's mode and broadcasts it. | Same effect as the presenter's live switch. | user |
| D3 | Failed logins per address, scope and deck: 20 per hour; then 429 with `Retry-After` until the hour window ends. Only failures count. | Stops slow guessing without locking out people who sign in often. | user |
| D4 | Every failed login and every hourly lockout is logged at `warn` with address, scope and deck; never the password. | Visible in `journalctl` / `docker logs`; usable by fail2ban. | user |
| D5 | WebSocket connections: at most 100 per address and 1 000 in total; beyond that the socket is closed with code 4429; the client retries with its usual backoff. | 100 leaves room for a classroom behind one NAT address. | user |
| D6 | New passwords (CLI and admin panel): 8+ characters, at least one letter and one digit; error `password-too-weak`. | Asked by the author. | user |
| D7 | Cloudflare Access on `/admin*` and a WAF *Managed Challenge* rule on sign-in pages are documented, not coded. | No code, no secrets in syncdeck. | user |

### Tasks

#### T1 — Stop / resume controlling (D1)
- **Files:** `public/viewer.js`, `public/i18n.js`, `public/style.css`, `test/e2e/viewer.spec.js`.
- **Acceptance:** e2e: a local-direct viewer shows *Controlling* and a stop button; after clicking it, keys no longer move the presenter's deck and a *Control* button brings control back.

#### T2 — Live default mode (D2)
- **Files:** `src/live.js`, `src/routes/admin.js`, `test/live.test.js` or `test/admin.test.js`.
- **Acceptance:** test: a connected viewer receives a state with the new `viewerNav` after the PATCH.

#### T3 — Hourly failure limit and log (D3, D4)
- **Files:** `src/auth.js`, `test/auth.test.js`.
- **Acceptance:** test: after 20 failures in the hour (minute limiter bypassed by spacing or a fake clock) the 21st attempt gets 429 even with the right password; a warn line is logged without the password.

#### T4 — WebSocket caps (D5)
- **Files:** `src/live.js`, `public/shell.js` (nothing to change if backoff already covers it), `test/live.test.js`.
- **Acceptance:** test with small caps: the connection over the limit closes with 4429.

#### T5 — Password rule (D6)
- **Files:** `src/auth.js`, `public/i18n.js`, `public/admin.js`, `src/cli.js` messages, tests.
- **Acceptance:** `abcdefgh` and `12345678` rejected with `password-too-weak`; `abcd1234` accepted.

#### T6 — Docs (D3–D7)
- **Files:** `docs/security.md`, `docs/deploy-raspberry.md`, `README.md` if it mentions the rule.

### Execution

Mode: single agent

### Verification

`npm test`, `npm run check`, `npm run test:e2e` all pass.

### Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Classroom NAT shares one address | students blocked | caps high enough (D5); failure limit is per scope and deck |

### Open questions

## Implementation

Baseline (2026-10-23): `npm test` 70 passed, 0 failed.

- [x] T1 — stop / resume controlling — `public/viewer.js` uses `?control=off` instead of `sessionStorage` (works where storage is blocked; same one-click reload); e2e `a controlling viewer can stop and resume controlling` passes.
- [x] T2 — live default mode — `live.setViewerNav` called from the PATCH; `test/live.test.js` "changing the default viewer mode in the admin panel reaches connected viewers" passes.
- [x] T3 — hourly failure limit and log — `createFailureLimit` in `src/auth.js`; `test/auth.test.js` "20 failed logins in an hour…" passes (21st attempt 429 with Retry-After > 60 even with the right password, other address unaffected, 20 `login failed` lines, one `login locked`, no password in the log).
- [x] T4 — WebSocket caps — `src/live.js`, close code 4429 (client retries with backoff, no change in `shell.js`); `test/live.test.js` "WebSocket connections are capped…" passes.
- [x] T5 — password rule — `checkPasswordInput` returns `password-too-weak`; CLI and admin panel show a readable message; unit, admin and CLI tests pass.
- [x] T6 — docs — `docs/security.md`, `docs/deploy-raspberry.md` (new "Extra protection at Cloudflare" section), `README.md`.

- [x] T7 — install and update scripts (asked by the author during implementation) — `deploy/install.sh`, `deploy/update.sh` (linked as `/usr/local/bin/syncdeck-update`); `bash -n` and `shellcheck` clean; update flow simulated with stubbed `systemctl`/`curl`/`npm` against a local git remote: update, no-op when up to date, and automatic rollback when the new version fails its health check. Not yet run on a real Pi.

Deviations:
- T7 added at the author's request (not in the original task list).
- D1: the opt-out lives in the URL (`?control=off`) rather than `sessionStorage`; same behaviour, no storage edge cases.
- New tests were written before the code but not run against the old code first.

## Results

- All goals delivered. `npm test` 74 passed; `npm run check` clean; `npm run test:e2e` 44 passed (Chromium).

## Closure
