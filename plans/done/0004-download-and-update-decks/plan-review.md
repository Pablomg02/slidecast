# 0004 — Plan review

One independent critic (2026-10-25), given only the plan, the user's request
and the repository. Verdict: **ready with fixes**. It confirmed lock order
(deck → meta, never reversed), same-filesystem rename for the stage folder,
`frame-src 'self'` allowing the probe, and the bridge's `{slide, step}`
format. Every issue was checked against the code and applied.

| # | Severity | Issue | Disposition |
| --- | --- | --- | --- |
| 1 | moderate | Async startup cleanup of `.stage-*`/`.upload-*` could delete a fresh stage; `createDeckStore()` is sync. | Applied: `ready` promise awaited by `upload()`/`stage()` and by tests (T4). |
| 2 | moderate | `discardStage`, stage replacement and expiry not locked; could remove a folder mid-commit. | Applied: D21, UI blocks closing during commit, late DELETE (T4, T6). |
| 3 | moderate | `parseSteps` throwing on one unnamed slide would block the whole update. | Applied: D22, invalid items skipped (T3). |
| 4 | moderate | Live `viewerNav` not refreshed when the incoming `deck.json` changes it. | Applied: `live.setViewerNav` after commit, test (T5). |
| 5 | moderate | Popover appended in `render()` vanishes on `load()`; toggle fights light dismiss. | Applied: module-level popover on `document.body`, `pointerdown` guard, e2e (T6, T7). |
| 6 | moderate | D17 used stale row counts (poll pauses while a dialog is open). | Applied: stage response returns `live.counts(slug)` (D17, T5, T6). |
| 7 | moderate | e2e tests did not name their deck and could depend on each other. | Applied: one copied deck per test (T7 setup rule). |
| 8 | suggestion | Stage token subject `stage-<hex>` is a valid slug. | Applied: D23 (`stage:` subject, id regex). |
| 9 | suggestion | Off-screen cross-origin frame may be throttled. | Applied: D24, visible small preview. |
| 10 | suggestion | Zip header fields unspecified (mode 000 with Info-ZIP). | Applied: D13 fields and a T1 criterion. |
| 11 | suggestion | Outcome said "zip's deck.json is ignored" when identical. | Applied: condition `hasIncoming && !same` (T6). |
