---
id: "0004"
title: "Download and update decks"
type: plan
created: 2026-10-25
---

# 0004 — Download and update decks

## Justification

Today the only way to get a deck's notes out of slidecast is to copy
`deck.json` from the server's disk, and the only way to change a deck is to
upload over its name. That keeps **every** note, including notes for slides
the new version no longer has: they stay hidden in `deck.json` forever, and
nobody is told which notes no longer belong to a slide. If the new zip has its
own `deck.json`, it silently replaces the current one.

Presenters want to (1) take a deck home with its notes and (2) update a deck
in the admin panel, keeping the notes whose slide still exists, seeing what
will be lost before it happens, and choosing between the current notes and
the ones in the zip when both exist.

### Goals

- An admin can download any deck as one `.zip` (`index.html`, its assets and
  `deck.json`) from the admin panel, and uploading that zip again gives back
  the same deck and notes.
- An admin can update a deck in two phases: upload the new version to a
  staging area, see a summary computed from the new deck's real slide list
  (notes kept, notes that will be deleted, warnings), then confirm or cancel.
- On confirm, notes are kept by slide id; notes for slides or steps the new
  version does not have are deleted (the old version stays in `trash/`).
- If the zip has a `deck.json` that differs from the current one, the admin
  chooses which one to use, as a whole; settings (title, aspect, viewer mode,
  cover) come from the same choice. If both are the same, nothing is asked.
- The upload form, given the name of an existing deck, opens the update flow
  instead of replacing silently.

### Non-goals

- Choosing notes slide by slide, or merging the two `deck.json` files.
- Moving the live position to the same slide id after an update (the live
  index stays as is, clamped, like a re-upload today). Captured as a
  follow-up ticket in T9.
- Detecting that a slide's *content* changed while its id stayed the same.
- Downloading from the CLI, or a zip64 writer for decks over 4 GB.
- Changing `POST /api/admin/decks` (the raw API keeps "replace and keep all
  notes", so scripts that use it do not break).
- Cleaning up `trash/`.

## Plan

### Context

- **Deck store**: `src/decks.js`, `createDeckStore()`. `upload(slug, buffer,
  kind)` unpacks into `<dataDir>/.upload-<hex>`, then under
  `withLock('deck:<slug>')` copies the old `deck.json` if the zip has none,
  moves the old folder to `<stateDir>/trash/<slug>-<timestamp>` (`move()`) and
  renames the staging folder into place. `modifyMeta()` does
  read-modify-write of `deck.json` under `withLock('meta:<path>')`;
  `normalizeMeta()` fills defaults. `slugs()` skips folders starting with `.`.
  `dirSize()` walks a folder. `DeckError(code)` carries error codes.
- **Notes format** (`docs/deck-format.md`, table near line 44):
  `slides: { "<slide id>": { notes: "…", steps: { "<step n>": "…" } } }`,
  unknown fields kept. Step numbers are those the deck reports
  (`{slide, step}` with `step` from 0).
- **Zip reader**: `src/unzip.js` (`readZip`, `ZIP_LIMITS`: 5 000 entries,
  300 MB, no zip64). There is no zip writer. Node ≥ 20 (`package.json`
  `engines`), so `zlib.crc32` (Node 20.15+/22.2+) cannot be relied on.
- **Deck files route**: `src/deckfiles.js`, `registerDeckFiles()` serves
  `/_deck/:slug/:token/*` with `verifyDeckToken(secret, slug, token)`
  (`src/tokens.js`; the "slug" is just the HMAC subject string), refuses
  hidden paths and `deck.json` (`isNotesFile`), sends `DECK_CSP`, injects the
  bridge into `index.html`. The token is in the URL because the deck iframe
  is sandboxed (opaque origin): cookies are not sent from it.
- **Admin API**: `src/routes/admin.js`. Every `/api/admin/*` route is behind
  `auth.canAdmin`; raw `application/zip` / `text/html` bodies up to
  `UPLOAD_LIMIT` (100 MB) are parsed in that scope; `sendError()` maps
  `DeckError` codes via `ERRORS`. After an upload it calls
  `live.resetDeck(slug)`; after a notes change, `live.notifyNotes(slug,
  meta.slides)`. `/api/*` responses get `Cache-Control: no-store`
  (`src/routes/api.js`).
- **Admin UI**: `public/admin.js` (table of decks with actions, `uploadForm()`,
  dialogs built with `el()` and `dialog.showModal()`; the 5 s poll skips while
  a dialog is open). `createDeckFrame(container, deckUrl, { mode: 'preview' })`
  in `public/shell.js` loads a deck in a sandboxed iframe; `frame.onReady(cb)`
  gives `m.steps` (`[{slide, step}]`), `frame.onError(cb)` gives
  `'no-deck-api'` when the deck exposes no API (the bridge gives up ~3 s after
  `load`). `api(url, { method, body | raw, type })` returns `{ status, ok,
  data }`. Strings live in `public/i18n.js` (`en` and `es`, same keys and
  placeholders, checked by `test/i18n.test.js`).
- **Live state**: `src/live.js`. `counts(slug)` gives `{ viewers, presenters,
  raised }` (already in each admin deck row as `d.room`).
- **Tests**: `npm test` (node:test, `test/*.test.js`; helpers in
  `test/helpers.js`: `tempDirs`, `makeDeck`, `onCleanup`; `fflate` is a dev
  dependency for building/reading zips), `npm run check` (syntax),
  `npm run test:e2e` (Playwright, `test/e2e/*.spec.js`, server from
  `test/e2e/server.js`). **On this machine run e2e as
  `PW_DISABLE_TS_ESM=1 npm run test:e2e`.**
- **Demo deck** for e2e: `examples/demo/` (`index.html` with
  `<section class="slide" id="…" data-steps="n">`, `deck.json` with notes for
  `intro`, `how` (steps 1, 2), `roles`, `keys`, `end`).

### Approach

**Download.** A small streaming zip writer (`src/zipwrite.js`, deflate for
text files, store for already-compressed media, CRC32 computed in JS) and an
admin-only route that walks the deck folder (skipping hidden paths and
anything that is not a regular file) and streams `<slug>.zip` with the files
at the zip root, so it uploads back as is. Only the admin route can produce
`deck.json`; `/_deck/` keeps refusing it.

**Update, two phases.** Only the browser can learn the new deck's slide list
(the bridge runs the deck's code), so:

1. `POST /api/admin/decks/:slug/stage` unpacks the upload into
   `<dataDir>/.stage-<id>` (hidden, so never listed as a deck), remembers the
   current deck's version, and returns a signed URL
   `/_stage/<id>/<token>/` served exactly like a deck.
2. The admin page loads that URL in an off-screen preview frame, gets the
   steps, and asks the server for a summary for each notes source
   (`POST /api/admin/stages/:id/diff`). The dialog shows it and, when the zip
   brings a different `deck.json`, a choice between both.
3. `POST /api/admin/stages/:id/commit { notes, steps }` re-reads the current
   `deck.json` at that moment under its lock (edits made in the editor
   meanwhile are kept), checks the deck was not replaced since phase 1,
   prunes notes with the same function the summary used, writes the result
   into the staging folder, and swaps folders like `upload()` does.

The pruning logic lives only on the server (`src/notes.js`), used by both
the summary and the commit, so what is shown is what happens.

Discarded:
- *Commit first, report orphans after*: the audience would already see the
  new version before the admin could choose the notes source or cancel.
- *Parsing the HTML on the server to find slides*: decks are arbitrary
  HTML/JS; only the deck API knows its slide ids.
- *Two loose downloads (html + json)*: loses assets, browsers block
  multi-file downloads, and it would not upload back.
- *`zlib.crc32`*: missing on early Node 20.

### Decisions

| # | Decision | Rationale | Source |
| --- | --- | --- | --- |
| D1 | Download is one `.zip` with every deck file at the root plus `deck.json`. | Decks have assets; a root `index.html` is what upload accepts. | user (download html + json), refined here |
| D2 | Notes whose slide id, or step number, is missing from the new deck are deleted on update. | Keeps `deck.json` clean; the old version is in `trash/`. | user |
| D3 | When the zip has a `deck.json` that differs from the current one, the admin picks one, whole. No merge, no per-slide choice. | Simple and predictable. | user |
| D4 | Settings (`title`, `aspect`, `viewerNav`, `cover`, unknown top-level fields) follow the notes choice: the chosen `deck.json` is used whole, then pruned. | One file, one choice. | user |
| D5 | One plan for download and update. | User preference. | user |
| D6 | "Same" means `canonicalJson(normalizeMeta(a)) === canonicalJson(normalizeMeta(b))` (keys sorted recursively). If same, no choice is shown and `notes: 'current'` is sent. | A download re-uploaded unchanged must not ask anything. | plan |
| D7 | A zip `deck.json` that is not valid JSON counts as absent (`incomingInvalid: true`, shown as a notice); only the current notes are offered. | Same as `readMeta()` falling back to defaults. | plan |
| D8 | If the new deck exposes no API (`no-deck-api`, or no `ready` within 15 s), the commit sends `steps: null`: nothing is pruned, and the dialog says the notes could not be checked. | Without a slide list, deleting would be guessing. | plan |
| D9 | Positional-id warning: shown when the new deck has ≥ 3 distinct slide ids that all match `/^(.*?)(\d+)$/` with the same prefix, and at least one slide note is kept. | Ids like `s1, s2…` shift when a slide is inserted; this cannot be detected for sure, so warn. | plan |
| D10 | A stage lives 30 minutes (`stageTtlMs`, injectable with `now` for tests); one stage per deck (a new one discards the previous); stages are in memory and `.stage-*` / `.upload-*` folders left in `dataDir` are removed when the store is created. | Bounded disk use; a restart forgets stages anyway. | plan |
| D11 | Deck version for the conflict check: `` `${st.ino}-${st.mtimeMs}` `` of the deck's `index.html`. A commit with a different version answers 409 `deck-changed`. | Every upload/commit creates a new folder, so the inode changes. | plan |
| D12 | Stage files are served at `/_stage/:id/:token/*` with token `issueDeckToken(secret, 'stage:' + id)` (D23) and the same checks, headers and bridge injection as `/_deck/`. | Same sandbox as any deck; the token is needed because the iframe sends no cookies. | plan |
| D13 | Zip writer: method 8 (deflate) for `.html .htm .css .js .mjs .json .txt .md .svg .xml .csv`, method 0 (store) otherwise; UTF-8 flag (bit 11) on every entry; DOS time from the file's mtime, dates before 1980 clamped to 1980-01-01; version made by `0x0314`, version needed `20`, external attributes `(0o100644 << 16) >>> 0` (otherwise Info-ZIP `unzip` extracts with mode 000); no data descriptors. Each file is read whole, compressed, then written; the zip is a `Readable` streamed to the reply. | One file in memory at a time; no zip64. | plan |
| D14 | The download route answers 413 `too-big` before sending anything when the deck has more than 65 535 files or more than 4 000 000 000 bytes. | The writer has no zip64. | plan |
| D15 | Downloads skip any path part starting with `.` and anything that is not a regular file (symlinks included). `deck.json` is included as stored on disk; if missing, `normalizeMeta({})` is written. | Same rule as `/_deck/`; the user's file is not rewritten. | plan |
| D16 | The upload form, given the slug of an existing deck, opens the update dialog with that file instead of posting. `POST /api/admin/decks` itself is unchanged. | One behaviour in the UI; the raw API stays compatible. | plan |
| D17 | Before confirming, if the stage response's `live.presenters + live.viewers > 0` (fresh `live.counts(slug)`, not the possibly old table row) the dialog warns that everyone connected will reload. The live index is not remapped. | Remapping needs the old deck's steps too; deferred (non-goal). | plan |
| D18 | Single-deck mode: download is offered; update (button, routes) is not (`ERR_SINGLE_DECK`, 409). | Upload is already refused there. | plan |
| D21 | Every change to the stage map and every stage-folder removal (`stage()` replacing a stage, expiry sweeps, `discardStage`, `commitStage`) runs under `withLock('deck:<slug>')`; `commitStage` takes the stage out of the map first; `ERR_CONFLICT` also discards the stage. | A DELETE or a second tab must not remove a folder a commit is moving. | review |
| D22 | `parseSteps` skips items with an invalid `slide` or `step` instead of failing. | A deck with one unnamed slide must still be updatable; such ids can never carry notes (`updateSlide()` refuses them). | review |
| D23 | Stage token subject is `'stage:' + id` (a `:` can never be in a slug) and stage ids must match `/^[0-9a-f]{12}$/`. | Deck and stage token namespaces cannot overlap. | review |
| D24 | The probe frame is a small **visible** preview in the dialog (320×180, `pointer-events: none`), not off-screen. | Chromium throttles off-screen cross-origin frames; a visible preview also shows the admin they picked the right file. | review |
| D19 | Before confirming, the dialog spells out what will happen ("If you update:" list) for the notes source selected, right above the confirm button, and redraws it when the source changes. The confirm button is disabled until the summary is loaded. | The admin must see the consequence of the click, not infer it from counts. | user |
| D20 | A small info button (ⓘ) next to "Update" opens a native `popover` explaining how updating works and what to be careful with (ids, steps, positional ids). One shared popover element, positioned under the button that opened it. | Help where the action is, without cluttering the table. Native `popover` gives light dismiss and Escape for free. | user |

### Tasks

#### T1 — Streaming zip writer

- **Objective:** `src/zipwrite.js` produces valid zips that `src/unzip.js`
  and `fflate` both read back byte for byte.
- **Files:** `src/zipwrite.js` (new), `test/zipwrite.test.js` (new).
- **Depends on:** —
- **Interface:**
  - `export function crc32(buf) → number` (unsigned 32-bit, table-based).
  - `export function zipStream(entries) → Readable`, where `entries` is an
    array of `{ path, mtime, file }` (absolute path read with `readFile`) or
    `{ path, mtime, data }` (Buffer). `path` uses `/`. Rules of D13.
- **Acceptance criteria:**
  - [ ] `crc32(Buffer.from('123456789')) === 0xCBF43926`.
  - [ ] A zip of `index.html`, `img/a.png` (random bytes), `deck.json` and a
        file named `ñandú.txt` is read by `readZip` and by `fflate.unzipSync`
        with identical content and names.
  - [ ] The `.png` entry has method 0 and the `.html` entry method 8
        (assert on the central directory or `readZip` output).
  - [ ] An empty file and an empty `entries` array both produce valid zips.
  - [ ] Central directory entries have version made by `0x0314` and
        external attributes `0x81A40000`; a file with mtime in 1970 gets the
        DOS date 1980-01-01.
  - [ ] `node --test test/zipwrite.test.js` passes.

#### T2 — Deck files listing and download route

- **Objective:** an admin gets `GET /api/admin/decks/:slug/download` as a zip
  that uploads back to the same deck.
- **Files:** `src/decks.js` (add `files(slug)`), `src/routes/admin.js`,
  `test/decks.test.js`, `test/admin.test.js`.
- **Depends on:** T1
- **Interface:**
  - `decks.files(slug) → [{ path, file, size, mtime }]`, sorted by `path`,
    rules of D15 (hidden parts and non-regular files skipped; walk with
    `readdir(..., { withFileTypes: true })` and `Dirent.isFile()`).
    `ERR_NOT_FOUND` if the deck does not exist. Works in single-deck mode.
  - Route: 404 `not-found` for an unknown deck; 413 `too-big` per D14;
    otherwise 200, `Content-Type: application/zip`,
    `Content-Disposition: attachment; filename="<slug>.zip"`, body
    `zipStream(...)`. When `deck.json` is not in `files()`, add
    `{ path: 'deck.json', data: JSON of normalizeMeta({}) }`.
- **Acceptance criteria:**
  - [ ] Test: a deck with `index.html`, `img/a.png`, `.git/config`, `.env`, a
        symlink and `deck.json` → the zip has `deck.json`, `img/a.png`,
        `index.html` only.
  - [ ] Test: downloading, deleting the deck and uploading the zip through
        `POST /api/admin/decks?slug=…` gives the same files and the same
        `deck.json` bytes.
  - [ ] Test: a deck without `deck.json` downloads one with
        `{"slidecast":1,…}` defaults.
  - [ ] `['GET', '/api/admin/decks/talk/download']` added to `ROUTES` in
        `test/admin.test.js` (403 without admin).
  - [ ] Test: `GET /_deck/<slug>/<token>/deck.json` still answers 404.
  - [ ] `npm test` passes.

#### T3 — Notes pruning and summaries

- **Objective:** one pure module decides which notes a slide list keeps.
- **Files:** `src/notes.js` (new), `test/notes.test.js` (new).
- **Depends on:** —
- **Interface:**
  - `export function parseSteps(input) → [{ slide, step }] | null` — `null`
    stays `null`; a non-array or more than 10 000 items throws
    `DeckError('ERR_BAD_INPUT')` (import from `./decks.js`). Items whose
    `slide` is not a string of 1–200 chars without control characters, or
    whose `step` is not an integer 0–9999, are skipped silently (D22).
  - `export function pruneSlides(slides, steps) → { slides, removedSlides,
    removedSteps }`. With `steps === null`, returns `slides` unchanged and
    empty lists. Otherwise: entries whose id is not a `slide` in `steps` are
    dropped (`removedSlides` lists the ids of those that had a non-empty
    `notes` or any step note); in kept entries, step keys not among that
    slide's `step` numbers are dropped (`removedSteps: [{ slide, step }]`,
    step as a number), and an emptied `steps` object is deleted. Unknown
    fields of kept entries stay. Input is not mutated.
  - `export function summarize(slides, steps) → { kept, removedSlides,
    removedSteps, positional, checked }` — `kept`: number of kept entries
    with a non-empty `notes` or any step note; `positional`: D9;
    `checked: steps !== null`.
- **Acceptance criteria:**
  - [ ] Tests cover: slide removed, step removed (including emptying
        `steps`), unknown field kept, `null` steps, input not mutated,
        `parseSteps` throwing on a non-array and on 10 001 items, and
        skipping (not throwing) an item with `slide: ''`, one with a
        201-char id and one with `step: 1.5`, keeping the valid items.
  - [ ] Tests for `positional`: `s1,s2,s3` with notes → true; `intro,how,end`
        → false; `s1,s2` (two ids) → false; `s1,s2,s3` with no kept note →
        false.
  - [ ] `node --test test/notes.test.js` passes.

#### T4 — Stage and commit in the deck store

- **Objective:** `createDeckStore()` can stage a new version of a deck and
  commit it with the chosen, pruned notes, safely against concurrent edits.
- **Files:** `src/decks.js`, `test/decks.test.js`.
- **Depends on:** T3
- **Interface** (all added to the object `createDeckStore()` returns):
  - New options `stageTtlMs = 30 * 60 * 1000`, `now = Date.now`.
  - Refactor: the "write `files` into a staging folder" loop of `upload()`
    becomes `async function writeStaging(files, prefix) → dir`, used by
    `upload()` (prefix `.upload-`) and `stage()` (prefix `.stage-`). The id is
    `randomBytes(6).toString('hex')`.
  - `canonicalJson(value)` (module-level, exported): JSON with object keys
    sorted recursively.
  - `async version(slug) → string` per D11.
  - `async stage(slug, buffer, kind) → { id, slug, hasIncoming,
    incomingInvalid, same }`. Errors: `ERR_SINGLE_DECK`, `ERR_BAD_SLUG`,
    `ERR_NOT_FOUND` (deck must exist), zip errors as in `upload()`. Reads the
    staged `deck.json` if present (D7) and the current one with
    `readMeta()`; `same` per D6 (`false` when no incoming). Drops any earlier
    stage of the same slug and expired stages (removing their folders).
    Keeps in a `Map`: `{ id, slug, dir, base, incoming, createdAt }`.
  - `stageDir(id) → string | null` (null when unknown or expired).
  - `async stageSummary(id, steps) → { current, incoming }` — `current =
    summarize(readMeta(slug).slides, steps)`; `incoming` the same on the
    staged meta, or `null`. `ERR_STAGE_GONE` when unknown/expired.
  - `async commitStage(id, { notes, steps }) → { slug, meta, removedSlides,
    removedSteps }`. `id` must match `/^[0-9a-f]{12}$/` (else
    `ERR_STAGE_GONE`), as in `stageDir(id)`. `notes` must be `'current'` or `'incoming'`
    (`'incoming'` without a valid incoming → `ERR_BAD_INPUT`). Under
    `withLock('deck:<slug>')`, then `withLock('meta:<live deck.json path>')`:
    `ERR_STAGE_GONE` if gone; `ERR_CONFLICT` if `version(slug) !== base`;
    for `'current'` read the live `deck.json` (invalid JSON →
    `ERR_BAD_META`, same as `modifyMeta`); `pruneSlides()` on the chosen
    meta's `slides`; `writeJsonAtomic(<stage>/deck.json, meta)`; move the old
    folder to trash and rename the stage into place (same steps as
    `upload()`); forget the stage.
  - `async discardStage(id)` removes it (no error if gone).
  - On creation, start `const ready = cleanup()` that removes folders in
    `dataDir` named `.stage-*` or `.upload-*` (ignore `ENOENT`); `upload()`
    and `stage()` begin with `await ready`; `ready` is part of the returned
    object so tests can await it.
  - Locking (D21): `stage()` drops the earlier stage of the slug and
    expired stages of that slug under `withLock('deck:<slug>')`;
    `discardStage(id)` looks up the slug and removes under the same lock;
    `commitStage` deletes the map entry as its first step inside the lock;
    on `ERR_CONFLICT` it also removes the stage folder before throwing.
- **Acceptance criteria:**
  - [ ] Test: stage a version without slide `b`; `commitStage(id, { notes:
        'current', steps: [a:0, a:1] })` → `deck.json` keeps `a`, loses `b`
        and `a.steps["2"]`; old folder in `trash/`; `removedSlides` is
        `['b']`.
  - [ ] Test: zip with its own `deck.json` (different title and notes) →
        `hasIncoming: true, same: false`; commit `'incoming'` writes that
        title and those notes, pruned.
  - [ ] Test: zip whose `deck.json` equals the current one with keys in a
        different order → `same: true`.
  - [ ] Test: invalid incoming `deck.json` → `incomingInvalid: true`;
        commit `'incoming'` → `ERR_BAD_INPUT`.
  - [ ] Test: `updateSlide()` between `stage()` and `commitStage('current')`
        → the new note is in the result.
  - [ ] Test: `upload()` of the same slug between stage and commit →
        `ERR_CONFLICT`, deck untouched.
  - [ ] Test: with `now` advanced past `stageTtlMs`, `commitStage` →
        `ERR_STAGE_GONE` and the stage folder is gone after the next
        `stage()`.
  - [ ] Test: a second `stage()` of the same slug makes the first id gone.
  - [ ] Test: single-deck mode → `ERR_SINGLE_DECK`; unknown deck →
        `ERR_NOT_FOUND`.
  - [ ] Test: `.stage-x` and `.upload-y` folders in `dataDir` are gone after
        `await store.ready` and never appear in `list()`.
  - [ ] Test: `discardStage(id)` while `commitStage(id, …)` is pending (start
        both without awaiting the first) → the commit succeeds and the deck
        is in place; after a conflict the stage folder is gone.
  - [ ] Existing `upload()` tests still pass; `npm test` passes.

#### T5 — Stage routes and stage file serving

- **Objective:** the admin API exposes the update flow and the staged deck
  can be loaded in a sandboxed frame.
- **Files:** `src/routes/admin.js`, `src/deckfiles.js`, `src/server.js`
  (only if needed to pass options), `test/admin.test.js`,
  `test/deckfiles.test.js`.
- **Depends on:** T4
- **Interface:**
  - `ERRORS` gains `ERR_CONFLICT: [409, 'deck-changed']`,
    `ERR_STAGE_GONE: [404, 'stage-gone']`.
  - `POST /api/admin/decks/:slug/stage` (raw body, same content types and
    `empty-body` check as the upload route) → 201 `{ id, deckUrl,
    hasIncoming, incomingInvalid, same, live }`, `deckUrl =
    /_stage/<id>/<issueDeckToken(secret, 'stage:' + id)>/`, `live =
    live.counts(slug)`.
  - `POST /api/admin/stages/:id/diff` body `{ steps }` → 200 `{ current,
    incoming }` (`parseSteps` on `steps`).
  - `POST /api/admin/stages/:id/commit` body `{ notes, steps }` → 200 `{
    slug, removedSlides, removedSteps }`, then `live.resetDeck(slug)`,
    `live.setViewerNav(slug, meta.viewerNav)` and `live.notifyNotes(slug,
    meta.slides)`.
  - `DELETE /api/admin/stages/:id` → 204.
  - `src/deckfiles.js`: move the body of the `/_deck/` handler after the
    token/existence checks into `async function serveFrom(req, reply,
    deckDir, rel)`; `/_deck/` keeps its checks and calls it; new
    `app.get('/_stage/:id/:token/*')` verifies the token with subject
    `'stage:' + id`, gets `ctx.decks.stageDir(id)` (404 when null) and calls
    `serveFrom`.
- **Acceptance criteria:**
  - [ ] The four new admin routes are in `ROUTES` (403 without admin).
  - [ ] Test: stage → diff → commit over HTTP updates `deck.json` as in T4
        and answers the documented bodies; a second commit → 404
        `stage-gone`.
  - [ ] Test: commit after an upload of the same slug → 409 `deck-changed`.
  - [ ] Test: commit with `notes: 'incoming'` whose `deck.json` has
        `viewerNav: 'free'` → `app.slidecast.live.getState(slug).viewerNav`
        is `'free'` (after a viewer connected, so the room state exists).
  - [ ] Test: a deck token issued for slug `stage-<id>` does not open
        `/_stage/<id>/…` (403).
  - [ ] Test: `GET <deckUrl>` returns `index.html` with the bridge and
        `DECK_CSP`; `<deckUrl>deck.json` → 404; a wrong token → 403; after
        `DELETE` → 404.
  - [ ] Test: in single-deck mode the stage route → 409 `single-deck`.
  - [ ] `npm test` passes.

#### T6 — Admin UI: download and update dialog

- **Objective:** the admin panel offers "Download" and "Update" per deck and
  walks the admin through the update with a clear summary.
- **Files:** `public/admin.js`, `public/i18n.js`, `public/style.css`,
  `public/shell.js` (one icon).
- **Depends on:** T2, T5
- **Behaviour:**
  - Actions cell: `el('a.download-link', { href:
    '/api/admin/decks/<slug>/download', download: '<slug>.zip' },
    t('download'))` for every deck; `el('button.small.update-btn', …,
    t('update'))` unless `single`, followed by
    `el('button.small.icon-btn.update-info-btn', { type: 'button',
    ariaLabel: t('updateInfoLabel'), title: t('updateInfoLabel') },
    icon('info'))`.
  - Info popover (D20): created once at module level (not in `render()`,
    which empties `#app`) and appended to `document.body`:
    `el('div.card.info-pop#update-info')` with
    `setAttribute('popover', 'auto')`, holding
    `el('h3', {}, t('updateInfoTitle'))` and a `ul` with one `li` per key
    `updateInfo1` … `updateInfo5`. On the button's `pointerdown`, record
    `wasOpen = pop.matches(':popover-open') && current === button` (light
    dismiss closes it before `click`); on `click`, if `!wasOpen` set
    `current = button` and call `showPopover()`, then set the popover's `style.top`/`style.left` from the
    button's `getBoundingClientRect()` (below it, right edges aligned,
    clamped to 16 px from the viewport edges). CSS: `.info-pop { margin: 0;
    max-width: min(360px, calc(100vw - 32px)); position: fixed; }`.
  - `shell.js` `ICONS` gains `info: '<circle cx="12" cy="12" r="9"/><path
    d="M12 11v6M12 7.5v.01"/>'`.
  - `openUpdate(d, file = null)` opens `dialog.card.update-dialog`:
    1. Heading `t('updateTitle', { slug })`, `p.hint.muted.update-intro` with
       `t('updateIntro')`, file input `#update-file`
       (`.zip,.html,.htm`) and a button `#update-check` (`t('updateCheck')`).
       When `file` is given, keep it in a variable, hide the input, show the
       file name instead, and start the check at once.
    2. On check: POST the stage route (`raw`, type as in `uploadForm()`).
       Show `t('updateChecking')`. Create a visible preview box
       `div.stage-probe` in the dialog (D24; CSS: `width: 320px; max-width:
       100%; aspect-ratio: 16 / 9; pointer-events: none;` with the
       `.deck-frame` filling it), `createDeckFrame(box, deckUrl, { mode:
       'preview' })`; wait for `onReady` (steps =
       `m.steps.map(({slide, step}) => ({ slide, step }))`), `onError` or 15 s
       (steps = `null`). Keep the preview shown until the dialog closes, then
       `frame.destroy()`.
    3. Keep `live` from the stage response for D17. POST diff with
       `{ steps }`. Render a summary `div.update-summary` for
       the source in use: `t('updateKept', { n })`, the list of
       `removedSlides` (`t('updateRemovedSlides', { list })`) and
       `removedSteps` as `id·step` (`t('updateRemovedSteps', { list })`),
       `t('updateUnchecked')` when `checked` is false, `t('updatePositional')`
       when `positional`, `t('updateLive', { v: live.viewers, p: live.presenters })` when D17
       applies, and
       `t('updateIncomingInvalid')` when `incomingInvalid`.
    4. If `hasIncoming && !same && !incomingInvalid`: two radios
       `name="notes-source"`, values `current` (`t('notesCurrent')`) and
       `incoming` (`t('notesIncoming')`), default `current`, with the hint
       `t('notesSourceHint')` (settings follow the choice); switching
       redraws the summary from the matching half of the diff response.
    5. Outcome (D19): `div.update-outcome` right above the buttons, with
       `el('strong', {}, t('updateOutcome'))` and a `ul`, rebuilt from the
       selected source's summary:
       - always `t('outcomeReplace')`;
       - `checked`: `t('outcomeKeep', { n: kept })`, then
         `t('outcomeDelete', { list })` with slide ids and `id·step` items
         joined by `, ` when any, else `t('outcomeDeleteNone')`;
         not `checked`: `t('outcomeKeepAll')`;
       - source `incoming`: `t('outcomeSettingsIncoming')`; source `current`
         with `hasIncoming && !same`: `t('outcomeSettingsCurrent')`;
       - D17 applies: `t('outcomeReload')`;
       - always `t('outcomeTrash')`.
       `#update-confirm` is disabled until this block has been drawn.
    6. `#update-confirm` (`button.primary`, `t('updateConfirm')`) POSTs
       commit; on 200 close, `load()`, and show `t('updated')` in the upload
       form status. On 404 `stage-gone` show `t('updateExpired')`; on 409
       `deck-changed` show `t('updateConflict')`; other errors via
       `errorText()`.
    7. Closing the dialog without confirming sends `DELETE` for the stage
       (fire and forget); if it closes before the stage POST answered, send
       the DELETE when that answer arrives. While the commit request is in
       flight, disable the close button and `preventDefault()` the dialog's
       `cancel` event (Escape).
  - `uploadForm()`: on submit, if `slug.value` is the slug of a deck in the
    last loaded list, call `openUpdate(thatDeck, f)` instead of posting.
    Keep the last loaded `decks` in a module variable set by `render()`.
  - i18n keys (en / es): `download` "Download" / "Descargar"; `update`
    "Update" / "Actualizar"; `updateTitle` "Update {slug}" / "Actualizar
    {slug}"; `updateCheck` "Check" / "Comprobar"; `updateChecking` "Checking
    the new version…" / "Comprobando la nueva versión…"; `updateKept` "{n}
    slides keep their notes." / "{n} diapositivas conservan sus notas.";
    `updateRemovedSlides` "Notes deleted (slide no longer exists): {list}" /
    "Notas que se borrarán (la diapositiva ya no existe): {list}";
    `updateRemovedSteps` "Step notes deleted (step no longer exists):
    {list}" / "Notas de pasos que se borrarán (el paso ya no existe):
    {list}"; `updateUnchecked` "This deck does not report its slides, so the
    notes could not be checked: all are kept." / "Este deck no informa de
    sus diapositivas, así que no se han podido comprobar las notas: se
    conservan todas."; `updatePositional` "Slide ids look numbered by
    position: if you inserted or removed slides, notes may end up on the
    wrong slide. Check them in the editor." / "Los ids de las diapositivas
    parecen numerados por posición: si has añadido o quitado diapositivas,
    las notas pueden quedar en la diapositiva equivocada. Revísalas en el
    editor."; `updateLive` "{p} presenters and {v} viewers are connected:
    their screens will reload." / "Hay {p} presentadores y {v} espectadores
    conectados: sus pantallas se recargarán."; `updateIncomingInvalid` "The
    deck.json in the zip is not valid JSON; the current notes will be used."
    / "El deck.json del zip no es JSON válido; se usarán las notas
    actuales."; `notesCurrent` "Keep the current notes" / "Conservar las
    notas actuales"; `notesIncoming` "Use the deck.json in the zip" / "Usar
    el deck.json del zip"; `notesSourceHint` "The title, aspect and viewer
    mode come from the same choice." / "El título, el aspecto y el modo del
    público salen de la misma elección."; `updateConfirm` "Update" /
    "Actualizar"; `updated` "Updated." / "Actualizada.";
    `updateExpired` "This check expired. Start again." / "La comprobación ha
    caducado. Vuelve a empezar."; `updateConflict` "The deck changed in the
    meantime. Start again." / "El deck ha cambiado mientras tanto. Vuelve a
    empezar."; `updateIntro` "Upload the new version. Before anything
    changes you will see which notes are kept and which are deleted." /
    "Sube la nueva versión. Antes de cambiar nada verás qué notas se
    conservan y cuáles se borran."; `updateOutcome` "If you update:" / "Si
    actualizas:"; `outcomeReplace` "The presentation is replaced by the new
    version." / "La presentación se sustituye por la nueva versión.";
    `outcomeKeep` "{n} slides keep their notes." / "{n} diapositivas
    conservan sus notas."; `outcomeDelete` "These notes are deleted: {list}."
    / "Se borran estas notas: {list}."; `outcomeDeleteNone` "No note is
    deleted." / "No se borra ninguna nota."; `outcomeKeepAll` "All notes are
    kept, unchecked." / "Se conservan todas las notas, sin comprobar.";
    `outcomeSettingsIncoming` "Notes, title, aspect and viewer mode come from
    the zip's deck.json." / "Las notas, el título, el aspecto y el modo del
    público salen del deck.json del zip."; `outcomeSettingsCurrent` "The
    zip's deck.json is ignored." / "El deck.json del zip se ignora.";
    `outcomeReload` "Everyone connected reloads; the current position may
    move to a nearby slide." / "Todos los conectados se recargan; la
    posición actual puede pasar a una diapositiva cercana.";
    `outcomeTrash` "The previous version stays in the server's trash." / "La
    versión anterior queda en la papelera del servidor.";
    `updateInfoLabel` "How updating works" / "Cómo funciona actualizar";
    `updateInfoTitle` "How updating works" / "Cómo funciona actualizar";
    `updateInfo1` "Notes belong to a slide's id, not to its position or its
    content: you can change text, images and order freely." / "Las notas van
    con el id de cada diapositiva, no con su posición ni su contenido:
    puedes cambiar textos, imágenes y orden sin problema.";
    `updateInfo2` "Renaming a slide id, or removing the slide, deletes its
    notes. New slides start without notes." / "Si renombras el id de una
    diapositiva o la quitas, sus notas se borran. Las diapositivas nuevas
    empiezan sin notas."; `updateInfo3` "Step notes go by step number: add
    steps at the end. Inserting a step in the middle shifts the notes after
    it." / "Las notas de pasos van por número: añade pasos al final. Si
    insertas uno en medio, las notas de detrás se desplazan.";
    `updateInfo4` "Ids like s1, s2, s3 change when you insert a slide. Use
    names (intro, results…), and ask an AI to keep the same ids." / "Ids
    como s1, s2, s3 cambian al insertar una diapositiva. Usa nombres (intro,
    resultados…) y pide a la IA que conserve los mismos ids.";
    `updateInfo5` "If the zip has its own deck.json, you choose which notes
    to use. Download the deck first to keep a copy." / "Si el zip trae su
    propio deck.json, eliges qué notas usar. Descarga antes el deck para
    guardar una copia.". Change `uploadHint` to: "A .zip with index.html (and assets),
    or a single .html file. Using the name of an existing deck updates it." /
    "Un .zip con index.html (y sus recursos) o un único .html. Si usas el
    nombre de un deck que ya existe, se actualiza."
- **Acceptance criteria:**
  - [ ] `npm run check` and `node --test test/i18n.test.js` pass.
  - [ ] T7's e2e tests pass.

#### T7 — End-to-end tests

- **Objective:** the real browser flow is proven with the demo deck.
- **Files:** `test/e2e/admin.spec.js`.
- **Depends on:** T6
- **Setup rule:** every new test creates its own deck by copying
  `examples/demo` to `join(srv.dataDir, '<slug>')` (slugs `dl1`, `upd1`,
  `upd2`, `upd3`, `info1`), reloads `/admin`, and selects only inside
  `tr[data-slug=<slug>]`; it reads `join(srv.dataDir, '<slug>',
  'deck.json')`. No test depends on another.
- **Acceptance criteria:**
  - [ ] Test "download" (`dl1`): click
        `tr[data-slug=dl1] .download-link`, `page.waitForEvent('download')`;
        the file unzips (`fflate.unzipSync`) to the demo files plus
        `deck.json` equal to `examples/demo/deck.json`.
  - [ ] Test "update keeps notes by id" (`upd1`): build a zip from `examples/demo`
        without `deck.json` and with `index.html` changed (`id="keys"` →
        `id="keys2"`, `data-steps="3"` → `data-steps="2"`); click
        `tr[data-slug=upd1] .update-btn`, set `#update-file`, click `#update-check`; the summary
        names `keys` and `how·2`; click `#update-confirm`; the deck's
        `deck.json` on disk has no `keys`, `how.steps` has only `"1"`, and
        `intro` notes are unchanged.
  - [ ] Test "zip with its own notes" (`upd2`): a demo zip whose `deck.json` has a
        different title → the radios appear; choose `incoming`, confirm;
        the row's title is the new one. Re-uploading the downloaded zip of
        an unchanged deck shows no radios.
  - [ ] Test "upload form over an existing name" (`upd3`) opens `.update-dialog`.
  - [ ] In the "update keeps notes by id" test, before confirming,
        `.update-outcome` contains `keys` and `how·2`, and `#update-confirm`
        is enabled only once it is shown.
  - [ ] Test "info" (`info1`): clicking `tr[data-slug=info1]
        .update-info-btn` shows `#update-info` (visible, contains the
        `updateInfo1` text); clicking it again hides it; Escape hides it;
        after opening and closing the Settings dialog (which reloads the
        table) the button still opens it.
  - [ ] `PW_DISABLE_TS_ESM=1 npm run test:e2e` passes.

#### T8 — Documentation

- **Objective:** users and readers of the security notes know about both
  features and the id rule.
- **Files:** `README.md` (section "Admin panel", around line 245),
  `docs/deck-format.md` (after the `deck.json` table, around line 44),
  `docs/security.md` ("Uploads" and "Deck files" paragraphs), `CHANGELOG.md`
  (`[Unreleased]`).
- **Depends on:** T6
- **Acceptance criteria:**
  - [ ] README says decks can be downloaded with their notes and updated,
        notes kept by slide id and notes of removed slides deleted.
  - [ ] `docs/deck-format.md` says slide ids should be stable names (not
        positions) so updates keep notes on the right slide.
  - [ ] `docs/security.md` says the download is admin-only and the only way
        to read `deck.json` over HTTP, that hidden files are not included,
        and that staged versions live in a hidden folder for 30 minutes and
        are served only through a signed URL with the deck sandbox.
  - [ ] `CHANGELOG.md` `[Unreleased]` has one entry for download and one for
        update.
  - [ ] `npm test` (includes `test/docs.test.js`) passes.

#### T9 — Follow-up ticket

- **Objective:** the deferred live-position remap is not lost.
- **Files:** a new ticket folder created with
  `python3 ~/.claude/skills/plans-convention/scripts/plans.py new --type ticket --title
  "Keep the live position by slide id after a deck update"`.
- **Depends on:** T5
- **Acceptance criteria:**
  - [ ] The ticket exists in `plans/backlog/`, references 0004 and D17, and
        `plans.py validate` passes.

### Execution

Mode: single agent

The tasks are a chain through the same files (`src/decks.js`,
`src/routes/admin.js`, `public/admin.js`); splitting would make packages
share files.

### Verification

- `npm run check`, `npm test` and `PW_DISABLE_TS_ESM=1 npm run test:e2e`
  pass.
- Manual: in `npm start`, download the demo deck, update it with a zip that
  renames one slide id, read the summary, confirm, and open the editor: the
  renamed slide has no notes, the rest keep theirs; the old version is in
  `<stateDir>/trash/`.
- Manual: open a viewer of the deck, update the deck; the dialog warned
  about it and the viewer reloads onto the new version.

### Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Positional ids shift notes silently. | Notes on the wrong slide. | D9 warning; docs (T8). Accepted beyond that. |
| Step numbers shift when a step is inserted mid-slide. | A step note on the wrong step. | Accepted; documented as a non-goal (content changes are not detected). |
| A deck reports `ready` late or never (heavy deck, no API). | Summary says "could not check", nothing pruned (D8). | Visible preview (D24) avoids off-screen throttling; 15 s timeout; safe fallback. |
| Large files in memory while zipping (one at a time) or staging (as upload today). | RAM spikes on a small Raspberry Pi. | Same bound as upload (300 MB); noted in `docs/security.md` already. |
| A stage left by a crash fills the disk. | Disk use. | D10: TTL, one per deck, startup cleanup. |
| Live index points to a different slide after update. | Audience lands on a neighbouring slide. | D17 warning; follow-up ticket T9. |

### Open questions

## Implementation

Baseline (2026-10-25): `npm test` 111 passed, `PW_DISABLE_TS_ESM=1 npm run test:e2e` 58 passed, `npm run check` clean.

- [x] T1 — zip writer — `node --test test/zipwrite.test.js` 4 passed; Info-ZIP `unzip` extracts with mode rw-r--r--
- [x] T2 — files() and download route — `node --test test/decks.test.js test/admin.test.js test/deckfiles.test.js` 38 passed (deck.json 404 on `/_deck/` already covered by "deck.json is never served")
- [x] T3 — notes pruning — `node --test test/notes.test.js` 4 passed
- [x] T4 — stage and commit — `node --test test/decks.test.js` 25 passed; `npm test` 133 passed
- [x] T5 — stage routes and `/_stage/` — `node --test test/admin.test.js test/deckfiles.test.js` 28 passed (5 new tests + 4 routes in `ROUTES`); `npm test` 138 passed
- [x] T6 — admin UI — `npm run check` clean, `node --test test/i18n.test.js` passed; screenshots checked at 1200 px and 390 px (dialog, popover)
- [x] T7 — e2e — `PW_DISABLE_TS_ESM=1 npm run test:e2e` 63 passed (58 + 5 new)
- [x] T8 — docs — README "Admin panel", `docs/deck-format.md` (stable ids), `docs/security.md` (staging, download), CHANGELOG `[Unreleased]` 2 entries; `npm test` (docs.test.js) passed
- [x] T9 — follow-up ticket 0005 — `plans.py validate` ok, 5 folders

Deviations:
- T2/T5: the deck.json-404 check on `/_deck/` was already covered by "deck.json is never served" in `test/deckfiles.test.js`; the `/_stage/` serving tests live in `test/admin.test.js` (they need an admin session to stage).
- T5: `_stage` added to `RESERVED_SLUGS` in `src/decks.js`, next to `_deck` (no behaviour change: slugs cannot start with `_`).
- T6: the popover's CSS also needs `inset: auto` (the UA style for `[popover]` sets `inset: 0`) and `overflow-y: auto` with a `max-height` set from the viewport, so it never runs off a phone screen; it is placed at the left edge before measuring, since its shrink-to-fit width depends on where it is.
- T6: found with a screenshot: `replaceChildren()` prints `null` as text, so the summary filters empty parts out; the e2e test asserts the summary has no "null".
- T7: the new tests are in `test/e2e/update.spec.js` (own server, one API sign-in in `beforeAll`), not in `admin.spec.js`: the admin sign-in is rate limited to 5 per minute per client, and `admin.spec.js` already uses them all. The e2e tests were written after the UI (T6 before T7, as the plan orders), so they were not seen failing first; the no-deck-api path (D8) was checked by hand with a plain HTML upload: summary "could not be checked", notes all kept after confirming.

## Results

- Download: `GET /api/admin/decks/:slug/download` streams a zip from `src/zipwrite.js` (own CRC32, deflate for text, store for media, Unix mode 0644); the round trip download → delete → upload gives the same files and the same `deck.json` bytes (`test/admin.test.js` "download gives a zip that uploads back to the same deck"); "Download" link in the admin table (e2e "download a deck with its notes").
- Update in two phases: `stage` / `stageSummary` / `commitStage` / `discardStage` in `src/decks.js`, pruning in `src/notes.js`, routes in `src/routes/admin.js`, staged files at `/_stage/:id/:token/*` (`src/deckfiles.js`). Notes kept by slide id, orphans deleted, old version in `trash/` (decks test "stage then commit keeps notes by id and prunes the rest"; e2e "update keeps notes by slide id and says what it deletes").
- Choice between current and zip `deck.json`, settings following it, no question when equal (decks tests "a zip with its own deck.json can be chosen whole", "the same deck.json with keys in another order counts as the same"; e2e "a zip with its own notes asks which ones to use"); viewer mode applied live after commit (admin test "choosing the zip deck.json applies its viewer mode live").
- Safety: edits made between stage and commit kept, 409 after a concurrent upload, TTL, one stage per deck, startup cleanup, discard during commit (decks tests).
- Upload form over an existing name opens the update; "If you update:" block before confirming; ⓘ popover (e2e tests).
- Review (generalist, see `review-2026-10-25.md`): 4 findings (2 medium, 2 low), all fixed with tests.
- Final runs: `npm run check` clean; `npm test` 142 passed, 0 failed; `PW_DISABLE_TS_ESM=1 npm run test:e2e` 63 passed.
- Not delivered: the live-position remap by slide id (non-goal), captured as ticket 0005.

## Closure

- Date: 2026-10-25
- Outcome: delivered as planned; review findings fixed.
- Follow-ups: 0005 (keep the live position by slide id after an update).
