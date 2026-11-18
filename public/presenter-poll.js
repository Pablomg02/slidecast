// Polls in the presenter view (D9 of 0006). A strip above the notes announces
// the slide's poll and the one on the screens; the panel (the Poll tab on a
// computer, a pop-up on a phone) shows them with their results and controls.
// Every presenter sees the same; commands go to the server, which takes the
// text from deck.json and sends everyone the new state. Presenters always see
// the results; the audience and the projector only once they are made public.
import { t, el, icon, confirmButton } from './shell.js';
import { createResults, pollOf, samePoll, letter, answers, gradesText } from './poll.js';

export function createPresenterPoll({ send, onSee, onLaunch, contestConfig = () => null }) {
  let polls = { shown: null, runs: [] };
  let receivedAt = 0; // when the last polls message came: `left` counts from then
  // Contest mode (0009): whether the ranking is on the screens, and graded
  // polls closed with their results never shown (they do not count yet).
  let rankingShown = false;
  let confirmLaunch = null; // slide id waiting for a second tap (D26)
  let slide = null; // the current slide's id
  let notes = {};
  let viewers = 0;
  let error = null;
  let errorTimer = null;
  const armed = { key: null, until: 0 };

  const runOf = (id) => polls.runs.find((r) => r.slide === id) ?? null;
  const shownRun = () => runOf(polls.shown);
  const defOf = (id) => (id && Object.hasOwn(notes, id) ? pollOf(notes[id]) : null);

  const act = (action, id, extra = {}) => send(action === 'hide' ? { t: 'poll', action } : { t: 'poll', action, slide: id, ...extra });
  function launch(id) {
    // Another question that has not scored yet would be left behind: ask once.
    // Known from the polls message itself, which comes with the closing.
    const behind = polls.runs.filter((r) => r.contest?.counts && !r.open && !r.scored && r.slide !== id);
    if (behind.length && confirmLaunch !== id) {
      confirmLaunch = id;
      setTimeout(() => { if (confirmLaunch === id) { confirmLaunch = null; render(); } }, 4000);
      render();
      return;
    }
    confirmLaunch = null;
    act('show', id);
    onLaunch?.();
  }

  // The contest chip of a poll: what it gives, or that it does not count.
  function contestChip(p, run) {
    const c = run ? run.contest : (() => {
      const cfg = contestConfig();
      if (!cfg?.on) return null;
      if (!p.correct?.length || p.contest === false) return { counts: false };
      const time = Object.hasOwn(p, 'time') ? p.time : cfg.time;
      return { counts: true, points: p.points ?? cfg.points, limit: time === null ? null : time * 1000 };
    })();
    if (!c) return null;
    if (!c.counts) return t('pollChipNoCount');
    const points = Number(c.points).toLocaleString();
    return c.limit ? t('pollChipContest', { points, s: Math.round(c.limit / 1000) }) : t('pollChipContestNoTime', { points });
  }

  // Text changed only when it differs: nodes under the pointer or the focus
  // stay, so a click or an Enter is never lost to an update.
  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

  // ---- a card: one poll, launched or not ----------------------------------------
  // Built once and updated in place, buttons included: answers arrive several
  // times a second, and the bars grow smoothly.
  function createCard(name) {
    let target = null; // the slide whose poll the card shows
    const chips = el('div.p-poll-chips');
    const question = el('h3.p-poll-question');
    const preview = el('ol.p-poll-preview');
    const results = createResults();
    const total = el('p.p-poll-total.muted');
    const gradesLine = el('p.p-poll-grades', { hidden: true });
    const edited = el('p.p-poll-edited', { hidden: true }, t('pollEdited'));
    const resultsLabel = el('span');
    // The countdown of an open run, ticking here between messages.
    const countdown = el('span.p-poll-countdown', { hidden: true, role: 'timer' });
    let deadline = null;
    const reset = (key) => {
      const b = confirmButton(t('pollReset'), t('pollConfirmReset'), `${key}:${name}`, () => {
        setMenu(false);
        act('reset', target);
      }, armed);
      b.dataset.action = 'reset';
      return b;
    };
    // On the screens, the usual two in sight (close showing the results, take
    // it off the screens) and the rest folded behind "More options", which
    // opens inside the card: nothing to cut off in the phone's pop-up.
    const menuId = `poll-menu-${name}`;
    const buttons = {
      launch: el('button.small.primary', { type: 'button', dataset: { action: 'launch' }, onclick: () => launch(target) }, icon('play'), el('span', {}, t('pollLaunch'))),
      closeShow: el('button.small.p-poll-go', { type: 'button', dataset: { action: 'close-results' }, onclick: () => act('close', target, { results: true }) },
        icon('check'), el('span', {}, t('pollCloseShow'))),
      // Closed with results secret: showing them is the next step (D12 of 0009).
      reveal: el('button.small.p-poll-go', { type: 'button', dataset: { action: 'reveal' }, onclick: () => act('reveal', target) },
        icon('check'), el('span', {}, t('pollShowResults'))),
      reopen: el('button.small', { type: 'button', dataset: { action: 'open' }, onclick: () => act('open', target) }, el('span', {}, t('pollReopenAnswers'))),
      timeUp: el('span.p-poll-timeup', { dataset: { action: 'time-up' } }, t('pollTimeUp')),
      ranking: el('button.small.primary', { type: 'button', dataset: { action: 'show-ranking' }, onclick: () => {
        // The card goes away with the poll: "Take off" in the panel takes the focus.
        // Until the ranking message comes (the polls message may come first).
        focusTakeOff = true;
        setTimeout(() => { focusTakeOff = false; }, 3000);
        send({ t: 'contest', action: 'show-ranking' });
      } }, el('span', {}, t('rankingShow'))),
      hide: el('button.small.p-poll-off', { type: 'button', dataset: { action: 'hide' }, onclick: () => act('hide') }, el('span', {}, t('pollHide'))),
      more: el('button.small.p-poll-more', {
        type: 'button', dataset: { action: 'more' }, 'aria-expanded': 'false', 'aria-controls': menuId, onclick: () => setMenu(!menuOpen),
      }, el('span', {}, t('pollMore')), icon('chevron')),
      show: el('button.small.primary', { type: 'button', dataset: { action: 'show' }, onclick: () => launch(target) }, icon('play'), el('span', {}, t('pollShowAgain'))),
      reset: reset('reset'),
    };
    const items = {
      closeQuiet: el('button.small', { type: 'button', dataset: { action: 'close' }, onclick: () => {
        setMenu(false);
        act('close', target, { results: false });
      } }, el('span', {}, t('pollCloseQuiet'))),
      results: el('button.small', { type: 'button', onclick: (e) => {
        setMenu(false);
        act(e.currentTarget.dataset.action, target);
      } }, resultsLabel),
      reset: reset('reset-menu'),
    };
    const actions = el('div.p-poll-actions', {}, Object.values(buttons));
    const menu = el('div.p-poll-menu', { id: menuId, hidden: true }, Object.values(items));
    const root = el(`section.p-poll-card.p-poll-${name}`, { hidden: true }, el('div.row.p-poll-top', {}, chips, countdown), question, preview, results.element, total, gradesLine, edited, actions, menu);
    const chip = (text, cls = '') => el(`span.p-poll-chip${cls}`, {}, text);
    let menuOpen = false;
    // A focused button that goes away leaves the focus on the page, where the
    // next Enter would move the slide: its stand-in takes the focus instead.
    function setMenu(on) {
      if (on === menuOpen) return;
      menuOpen = on;
      if (!on && menu.contains(document.activeElement)) buttons.more.focus({ preventScroll: true });
      menu.hidden = !on;
      buttons.more.setAttribute('aria-expanded', String(on));
    }
    // Esc folds it (before the phone's pop-up closes), and so does a tap elsewhere.
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !menuOpen) return;
      e.preventDefault();
      e.stopPropagation();
      setMenu(false);
      buttons.more.focus({ preventScroll: true });
    });
    document.addEventListener('pointerdown', (e) => {
      if (menuOpen && !menu.contains(e.target) && !buttons.more.contains(e.target)) setMenu(false);
    });
    // Stand-ins that can take the focus ("Time's up" is only text).
    const twin = { closeShow: ['reveal', 'ranking', 'reopen'], reopen: ['closeShow'], reveal: ['ranking', 'reopen'] };
    const only = (...names) => {
      const had = Object.keys(buttons).find((k) => buttons[k] === document.activeElement);
      for (const [k, b] of Object.entries(buttons)) b.hidden = !names.includes(k);
      if (!names.includes('more')) setMenu(false);
      if (had && buttons[had].hidden) {
        const next = [...(twin[had] ?? []), 'more', ...names].find((k) => names.includes(k));
        if (next) buttons[next].focus({ preventScroll: true });
      }
    };
    let previewKey = null;

    function tick() {
      const ms = deadline === null ? null : Math.max(0, deadline - performance.now());
      countdown.hidden = ms === null;
      if (ms === null) return;
      const sec = Math.ceil(ms / 1000);
      setText(countdown, sec > 0 ? t('pollSecondsLeft', { s: sec }) : t('pollTimeUp'));
      countdown.classList.toggle('p-poll-countdown-warn', sec <= 5);
    }

    return {
      root,
      tick,
      // A run (launched) or only the slide's poll (`def`), or neither.
      fill(run, def) {
        root.hidden = !run && !def;
        if (root.hidden) {
          setMenu(false);
          return;
        }
        const p = run ?? def;
        setText(question, p.question);
        const where = p === run && run.slide !== slide ? chip(t('pollFromSlide', { id: run.slide }), '.p-poll-chip-quiet') : null;
        const kind = chip(p.multiple ? t('pollMultiple') : t('pollSingle'), '.p-poll-chip-quiet');
        // The presenter always sees the right answers (0007); the audience
        // only once answers close and the results are shown (0008).
        const keyed = p.correct?.length ? chip(t('pollHasKey'), '.p-poll-chip-quiet') : null;
        const contestText = contestChip(p, run);
        const contestTag = contestText ? chip(contestText, '.p-poll-chip-contest') : null;
        deadline = run?.open && Number.isFinite(run.left) ? receivedAt + run.left : null;
        tick();
        if (!run) {
          target = slide;
          chips.replaceChildren(...[chip(t('pollNotLaunched')), kind, keyed, contestTag].filter(Boolean));
          preview.hidden = false;
          const key = JSON.stringify([def.options, def.correct ?? []]);
          if (key !== previewKey) {
            previewKey = key;
            preview.replaceChildren(...def.options.map((o, i) => {
              const right = Boolean(def.correct?.includes(i));
              return el(`li${right ? '.poll-right' : ''}`, {}, el('span.poll-letter', {}, letter(i)), el('span', {}, o),
                right ? el('span.poll-right-mark', {}, icon('check'), el('span', {}, t('pollRight'))) : null);
            }));
          }
          results.element.hidden = true;
          total.hidden = true;
          gradesLine.hidden = true;
          edited.hidden = true;
          only('launch');
          return;
        }
        target = run.slide;
        const onScreens = run.slide === polls.shown;
        chips.replaceChildren(...[
          chip(onScreens ? t('pollOnScreens') : t('pollHiddenState'), onScreens ? '.p-poll-chip-live' : ''),
          chip(run.open ? t('pollAccepting') : t('pollClosedState'), run.open ? '' : '.p-poll-chip-closed'),
          chip(run.revealed ? t('pollResultsPublic') : t('pollResultsSecret'), run.revealed ? '.p-poll-chip-public' : ''),
          kind, keyed, contestTag, where].filter(Boolean));
        preview.hidden = true;
        results.element.hidden = false;
        results.update(run, { correct: run.correct });
        total.hidden = false;
        setText(total, `${answers(run.voters)} · ${t('pollConnected', { m: viewers })}`);
        gradesLine.hidden = !run.grades;
        setText(gradesLine, gradesText(run.grades, run.multiple));
        const now = defOf(run.slide);
        edited.hidden = !(now && run.voters > 0 && !samePoll(now, run));
        if (onScreens) {
          items.closeQuiet.hidden = !run.open;
          items.results.dataset.action = run.revealed ? 'conceal' : 'reveal';
          setText(resultsLabel, run.revealed ? t('pollHideResults') : t('pollShowResults'));
          // Closed and secret: "Show results" in sight, not in the fold.
          items.results.hidden = !run.open && !run.revealed;
          const again = run.timeUp ? 'timeUp' : 'reopen';
          if (run.open) only('closeShow', 'hide', 'more');
          else if (!run.revealed) only('reveal', again, 'hide', 'more');
          else if (run.scored) only('ranking', again, 'hide', 'more');
          else only(again, 'hide', 'more');
        } else {
          only('show', 'reset');
        }
      },
    };
  }

  // The poll on the screens first, then this slide's own if it is another one.
  const shownCard = createCard('shown');
  const slideCard = createCard('slide');
  const errorBox = el('p.p-poll-error', { role: 'status', hidden: true });
  const empty = el('p.p-empty.muted', { hidden: true }, t('pollNone'));
  // While the ranking is on the screens, the Poll tab says so and can take
  // it off: the strip above is hidden while this tab is open (D26 of 0009).
  let focusTakeOff = false;
  const rankingOffPanel = el('button.small.p-poll-off', { type: 'button', id: 'ranking-off-panel',
    onclick: () => send({ t: 'contest', action: 'hide-ranking' }) }, t('rankingTakeOff'));
  const rankingBox = el('div.row.p-poll-ranking-on', { id: 'poll-ranking-on', hidden: true },
    el('span.grow', {}, t('rankingOnScreens')), rankingOffPanel);
  // The second tap launches anyway (D26 of 0009); said where the tap was.
  const confirmBox = el('p.p-poll-confirm', { id: 'poll-confirm', role: 'status', hidden: true }, t('pollLaunchUnscored'));
  const panel = el('div.p-panel.p-poll', { id: 'poll-panel', hidden: true }, errorBox, confirmBox, rankingBox, shownCard.root, slideCard.root, empty);

  // ---- strip -------------------------------------------------------------------------
  const stripText = el('span.p-poll-strip-text');
  const stripLaunchLabel = el('span');
  const stripLaunch = el('button.small.primary', { type: 'button', id: 'poll-launch', onclick: () => launch(confirmLaunch ?? slide) }, stripLaunchLabel);
  const stripSee = el('button.small', { type: 'button', id: 'poll-see', onclick: () => onSee() }, t('pollSee'));
  const stripRanking = el('button.small.p-poll-off', { type: 'button', id: 'ranking-off', hidden: true,
    onclick: () => send({ t: 'contest', action: 'hide-ranking' }) }, t('rankingTakeOff'));
  const strip = el('div.p-poll-strip', { id: 'poll-strip', hidden: true },
    icon('poll'), stripText, el('span.p-poll-strip-actions', {}, stripLaunch, stripRanking, stripSee));
  setInterval(() => { shownCard.tick(); slideCard.tick(); }, 250);

  function render() {
    const shown = shownRun();
    const current = runOf(slide);
    const def = defOf(slide);
    shownCard.fill(shown, null);
    slideCard.fill(current === shown ? null : current, current ? null : def);
    empty.hidden = !shownCard.root.hidden || !slideCard.root.hidden;
    errorBox.hidden = !error;
    setText(errorBox, error ? errorText(error) : '');
    confirmBox.hidden = !confirmLaunch;
    const hadFocus = rankingBox.contains(document.activeElement);
    rankingBox.hidden = !rankingShown || Boolean(shown);
    if (!rankingBox.hidden && focusTakeOff) rankingOffPanel.focus({ preventScroll: true });
    if (rankingBox.hidden && hadFocus) panel.querySelector('button:not([hidden])')?.focus({ preventScroll: true });
    if (!rankingBox.hidden) focusTakeOff = false;

    strip.hidden = !shown && !current && !def;
    strip.classList.toggle('p-poll-strip-live', Boolean(shown));
    let text = '';
    let own = null; // what the launch button does for this slide's poll
    if (shown) {
      text = [t('pollOnScreens'), answers(shown.voters), shown.open ? null : t('pollClosedState'),
        shown.revealed ? t('pollResultsPublic') : null].filter(Boolean).join(' · ');
      // This slide has a poll of its own: one tap puts it in place of the
      // other (a quiz, a poll per slide).
      own = current && current !== shown ? t('pollShowAgain') : !current && def ? t('pollLaunch') : null;
    } else if (current) {
      text = `${t('pollHiddenState')} · ${answers(current.voters)}`;
      own = t('pollShowAgain');
    } else if (def) {
      text = t('pollSlideHas');
      own = t('pollLaunch');
    }
    if (rankingShown && !shown) {
      strip.hidden = false;
      strip.classList.add('p-poll-strip-live');
      text = t('rankingOnScreens');
    }
    if (confirmLaunch) text = t('pollLaunchUnscored');
    setText(stripText, error ? errorText(error) : text);
    stripLaunch.hidden = !own;
    if (own) setText(stripLaunchLabel, own);
    stripRanking.hidden = !rankingShown || Boolean(shown);
    strip.classList.toggle('p-poll-strip-confirm', Boolean(confirmLaunch));
    if (confirmLaunch) {
      // The launch buttons now confirm: a second tap launches anyway.
      stripLaunch.hidden = false;
      setText(stripLaunchLabel, t('pollLaunch'));
    }
  }

  const errorText = (code) => (code === 'time-up' ? t('pollTimeUp') : t('pollError', { code }));

  return {
    panel,
    strip,
    update(msg) {
      polls = { shown: msg.shown ?? null, runs: Array.isArray(msg.runs) ? msg.runs : [] };
      receivedAt = performance.now();
      render();
    },
    setSlide(id) {
      if (id === slide) return;
      slide = id;
      render();
    },
    setNotes(slides) {
      notes = slides ?? {};
      render();
    },
    // The contest's ranking message (0009).
    setRanking({ shown }) {
      rankingShown = Boolean(shown);
      render();
    },
    setViewers(n) {
      if (n === viewers) return;
      viewers = n;
      render();
    },
    onError(code) {
      error = code;
      render();
      clearTimeout(errorTimer);
      errorTimer = setTimeout(() => { error = null; render(); }, 4000);
    },
    // There is something to show: a poll on the screens, or on this slide.
    available: () => Boolean(shownRun() || runOf(slide) || defOf(slide)),
    // Answers to the poll on the screens, or null.
    count: () => shownRun()?.voters ?? null,
  };
}
