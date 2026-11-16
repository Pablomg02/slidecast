// Polls in the presenter view (D9 of 0006). A strip above the notes announces
// the slide's poll and the one on the screens; the panel (the Poll tab on a
// computer, a pop-up on a phone) shows them with their results and controls.
// Every presenter sees the same; commands go to the server, which takes the
// text from deck.json and sends everyone the new state.
import { t, el, icon, confirmButton } from './shell.js';
import { createResults, pollOf, samePoll, letter, answers, gradesText } from './poll.js';

export function createPresenterPoll({ send, onSee, onLaunch }) {
  let polls = { shown: null, runs: [] };
  let slide = null; // the current slide's id
  let notes = {};
  let viewers = 0;
  let error = null;
  let errorTimer = null;
  const armed = { key: null, until: 0 };

  const runOf = (id) => polls.runs.find((r) => r.slide === id) ?? null;
  const shownRun = () => runOf(polls.shown);
  const defOf = (id) => (id && Object.hasOwn(notes, id) ? pollOf(notes[id]) : null);

  const act = (action, id) => send(action === 'hide' ? { t: 'poll', action } : { t: 'poll', action, slide: id });
  function launch(id) {
    act('show', id);
    onLaunch?.();
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
    const toggleLabel = el('span');
    const buttons = {
      launch: el('button.small.primary', { type: 'button', dataset: { action: 'launch' }, onclick: () => launch(target) }, icon('play'), el('span', {}, t('pollLaunch'))),
      toggle: el('button.small', { type: 'button', onclick: (e) => act(e.currentTarget.dataset.action, target) }, toggleLabel),
      hide: el('button.small', { type: 'button', dataset: { action: 'hide' }, onclick: () => act('hide') }, el('span', {}, t('pollHide'))),
      show: el('button.small.primary', { type: 'button', dataset: { action: 'show' }, onclick: () => launch(target) }, icon('play'), el('span', {}, t('pollShowAgain'))),
      reset: confirmButton(t('pollReset'), t('pollConfirmReset'), `reset:${name}`, () => act('reset', target), armed),
    };
    buttons.reset.dataset.action = 'reset';
    const actions = el('div.p-poll-actions', {}, Object.values(buttons));
    const root = el(`section.p-poll-card.p-poll-${name}`, { hidden: true }, chips, question, preview, results.element, total, gradesLine, edited, actions);
    const chip = (text, cls = '') => el(`span.p-poll-chip${cls}`, {}, text);
    const only = (...names) => {
      for (const [k, b] of Object.entries(buttons)) b.hidden = !names.includes(k);
    };
    let previewKey = null;

    return {
      root,
      // A run (launched) or only the slide's poll (`def`), or neither.
      fill(run, def) {
        root.hidden = !run && !def;
        if (root.hidden) return;
        const p = run ?? def;
        setText(question, p.question);
        const where = p === run && run.slide !== slide ? chip(t('pollFromSlide', { id: run.slide }), '.p-poll-chip-quiet') : null;
        const kind = chip(p.multiple ? t('pollMultiple') : t('pollSingle'), '.p-poll-chip-quiet');
        // The presenter always sees the right answers (0007); the audience
        // only once answers close.
        const keyed = p.correct?.length ? chip(t('pollHasKey'), '.p-poll-chip-quiet') : null;
        if (!run) {
          target = slide;
          chips.replaceChildren(...[chip(t('pollNotLaunched')), kind, keyed].filter(Boolean));
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
          kind, keyed, where].filter(Boolean));
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
          buttons.toggle.dataset.action = run.open ? 'close' : 'open';
          setText(toggleLabel, run.open ? t('pollCloseAnswers') : t('pollReopenAnswers'));
          only('toggle', 'hide', 'reset');
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
  const panel = el('div.p-panel.p-poll', { id: 'poll-panel', hidden: true }, errorBox, shownCard.root, slideCard.root, empty);

  // ---- strip -------------------------------------------------------------------------
  const stripText = el('span.p-poll-strip-text');
  const stripLaunchLabel = el('span');
  const stripLaunch = el('button.small.primary', { type: 'button', id: 'poll-launch', onclick: () => launch(slide) }, stripLaunchLabel);
  const stripSee = el('button.small', { type: 'button', id: 'poll-see', onclick: () => onSee() }, t('pollSee'));
  const strip = el('div.p-poll-strip', { id: 'poll-strip', hidden: true },
    icon('poll'), stripText, el('span.p-poll-strip-actions', {}, stripLaunch, stripSee));

  function render() {
    const shown = shownRun();
    const current = runOf(slide);
    const def = defOf(slide);
    shownCard.fill(shown, null);
    slideCard.fill(current === shown ? null : current, current ? null : def);
    empty.hidden = !shownCard.root.hidden || !slideCard.root.hidden;
    errorBox.hidden = !error;
    setText(errorBox, error ? t('pollError', { code: error }) : '');

    strip.hidden = !shown && !current && !def;
    strip.classList.toggle('p-poll-strip-live', Boolean(shown));
    let text = '';
    let own = null; // what the launch button does for this slide's poll
    if (shown) {
      text = [t('pollOnScreens'), answers(shown.voters), shown.open ? null : t('pollClosedState')].filter(Boolean).join(' · ');
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
    setText(stripText, error ? t('pollError', { code: error }) : text);
    stripLaunch.hidden = !own;
    if (own) setText(stripLaunchLabel, own);
  }

  return {
    panel,
    strip,
    update(msg) {
      polls = { shown: msg.shown ?? null, runs: Array.isArray(msg.runs) ? msg.runs : [] };
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
