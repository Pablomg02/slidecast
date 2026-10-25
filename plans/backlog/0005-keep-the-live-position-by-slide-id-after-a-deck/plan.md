---
id: "0005"
title: "Keep the live position by slide id after a deck update"
type: ticket
created: 2026-10-25
---

# 0005 — Keep the live position by slide id after a deck update

## Justification

When a deck is updated from the admin panel (0004) while people are
connected, everyone reloads and the live position stays at the same step
*index*, clamped to the new length (as after a plain re-upload). If slides were
inserted or removed before the current one, the audience lands on a different
slide. 0004 only warns about it (D17, "the current position may move to a
nearby slide").

It should land on the same slide id (and step, when it still exists), or the
nearest following slide when that id is gone.

## Plan

The remap needs the old deck's steps (the live state knows them only as a
count, `total`, in `src/live.js`) and the new deck's steps (the update dialog
already gets them from the preview, `public/admin.js` `openUpdate`). A likely
shape: the presenter's `ready` report keeps the steps list in the live state;
the commit route receives the new steps and maps the current `{slide, step}`
to the new index before `live.resetDeck()`.

### Acceptance criteria

- [ ] After an update that inserts a slide before the current one, the live
      index points to the same slide id and step.
- [ ] When the current slide id is gone, the live index points to the next
      surviving slide (or the last one).

## Implementation

## Results

## Closure
