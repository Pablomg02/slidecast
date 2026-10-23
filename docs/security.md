# Security

syncdeck is meant to be reachable from the Internet (for example through
Cloudflare Tunnel) by an audience that should only *watch*, while one person
presents and administers. This page lists what it protects, from whom, and how.

## Threat model

| Who | Can | Must not be able to |
| --- | --- | --- |
| Anyone with the URL | watch decks that have no viewer password | present, administer, read speaker notes |
| Viewer with a deck's viewer password | watch that deck | anything else |
| Presenter | drive the decks their password covers, read their notes | administer |
| Admin | everything | — |
| A deck's own code (written by an AI, downloaded…) | run inside its slide | read sessions, call the API, act as the person viewing it |
| Another website the admin visits | — | make the admin's browser change anything in syncdeck |

Out of scope: an attacker with a shell on the server, or with the `config.json`
file (it holds the secret that signs deck links).

## Measures

**Passwords.** Admin, presenter (global or per deck) and per-deck viewer
passwords are hashed with scrypt (N=16384, r=8, p=1, 16-byte random salt,
64-byte key) and compared in constant time. They are set with
`syncdeck passwd` or from the admin panel, must have 8 characters or more, and
are never stored or logged in clear.

**No password, no remote access.** When no password covers a role (admin, or
presenter for a deck), that role is granted only to "local direct" requests:
from a loopback address **and** without any of `X-Forwarded-For`, `Forwarded`,
`X-Real-IP`, `Cf-Connecting-IP`. `cloudflared` connects from localhost too, but
always adds `Cf-Connecting-IP`, so a fresh install exposed through a tunnel
refuses presenters and admins until passwords are set. `serve` warns when it
listens on a non-loopback address without passwords.

**Sessions.** One cookie, `sd_session`: 32 random bytes. The server stores only
its SHA-256, so a leaked `sessions.json` gives no usable cookie. Flags:
`HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` on HTTPS (also behind a proxy
with `--trust-proxy` and `X-Forwarded-Proto: https`). Sessions expire after
7 days idle and 30 days in total. Every login issues a new id (no fixation).
Changing a password removes the scope it protected from every session, at once
(open WebSockets lose control on their next command), also when the change is
made with the CLI while the server runs.

**Cross-site requests.** Every non-GET API request and every WebSocket upgrade
must carry an `Origin` header naming the same host as the request; otherwise
403. JSON APIs accept only `application/json` (no `text/plain`, which a
cross-site form could send) and uploads only `application/zip` / `text/html`
on the admin route.

**Brute force.** `/api/login` allows 5 attempts per minute per client address
and scope, and 50 per minute in total. Behind a proxy (`--trust-proxy`) the
client address comes from `Cf-Connecting-IP` or the first `X-Forwarded-For`
entry; without it these headers are ignored.

**Decks are untrusted code.** Each deck runs in `<iframe sandbox="allow-scripts">`
without `allow-same-origin`, so it gets an opaque origin: it cannot read
syncdeck's cookies, storage or API. Every file under `/_deck/` is also sent with
`Content-Security-Policy: sandbox allow-scripts allow-popups
allow-popups-to-escape-sandbox; frame-ancestors 'self'`, so an HTML or SVG file
inside a deck stays sandboxed even when opened directly. The iframe gets its
files through a path token (HMAC-SHA256 of deck and expiry with a 32-byte
server secret, valid 7 days) issued only to clients allowed to view the deck.
The deck's `deck.json` (speaker notes) is never served on that path. Messages
between the page and the deck carry no secrets.

**Pages.** syncdeck's own pages send `Content-Security-Policy: default-src
'self'; script-src 'self'; style-src 'self'; …` (no inline scripts or styles),
`X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin`; admin
pages also forbid framing (`frame-ancestors 'none'`, `X-Frame-Options: DENY`).
Speaker notes are Markdown rendered with raw HTML disabled.

**Uploads.** Zip files are read entry by entry before anything is written:
absolute paths, `..`, backslashes, NUL bytes, symlinks, encrypted entries,
zip64, more than 5 000 entries or more than 300 MB uncompressed are rejected,
and inflating stops at each entry's declared size (zip bombs cannot lie their
way past it). The request body is limited to 100 MB. Files are written to a
staging folder and only then moved into place; a replaced or deleted deck is
moved to `trash/` in the state folder, never deleted.

**Deck files.** Paths are resolved and checked to stay inside the deck folder,
also after resolving symlinks.

**Secrets on disk.** The state folder is created with mode 0700 and its files
with mode 0600. `decks/` and `.syncdeck/` are git-ignored so personal decks and
secrets do not end up in a repository by accident.

## Reporting a vulnerability

Please report security problems privately through GitHub's *Report a
vulnerability* button on the repository's Security tab, not in a public issue.
Include what you found, how to reproduce it and its impact. You will get an
answer as soon as possible.
