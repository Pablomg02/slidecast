// The poll beside the slide in the viewer (D8 of 0006). A participant answers
// it; a display (the projector: a viewer with presenter rights, controlling
// or not) shows it, with its results once the presenter makes them public. The panel can be minimised to a button, and
// opens again by itself when a new poll comes or one is shown again.
import { t, el, icon } from './shell.js';
import { createResults, letter, answers, gradesText } from './poll.js';

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

export function createViewerPoll(app, { display, badges }) {
  let send = () => {};
  let poll = null; // participant: the shown poll; display: the shown run
  let mine = null; // participant: its answer, as the server has it
  let selection = []; // participant: what is ticked on this page
  let dirty = false; // ticked here, not confirmed by the server yet
  let pending = false; // sent, no answer from the server yet
  let error = null; // the last error about the poll, until the next action
  let minimized = false;
  let blank = false;

  // ---- panel --------------------------------------------------------------------
  const kind = el('span.poll-kind');
  const minBtn = el('button.poll-min', {
    type: 'button', id: 'poll-minimize', title: t('pollMinimize'), 'aria-label': t('pollMinimize'),
    'aria-expanded': 'true', onclick: () => setMinimized(true),
  }, icon('minimize'));
  const question = el('h2.poll-question', { id: 'poll-question' });
  const options = el('div.poll-options');
  const sendBtn = el('button.primary.poll-send', { type: 'submit', id: 'poll-send' }, t('pollSend'));
  const status = el('p.poll-status', { id: 'poll-status', role: 'status' });
  const form = el('form.poll-form', {},
    el('fieldset', { 'aria-labelledby': 'poll-question' }, options),
    el('div.poll-actions', {}, sendBtn),
    status);
  const results = createResults();
  const closedNote = el('p.poll-closed-note', { id: 'poll-closed-note', hidden: true });
  const total = el('p.poll-total', { id: 'poll-total' });
  // Once answers close, with right answers (0007): how one's own answer fared,
  // and how the room did.
  const verdictText = el('span');
  const verdict = el('p.poll-verdict', { id: 'poll-verdict', hidden: true }, el('span.poll-verdict-icon'), verdictText);
  const grades = el('p.poll-grades', { id: 'poll-grades', hidden: true });
  const resultsBox = el('div.poll-results-box', {}, closedNote, verdict, results.element, total, grades);
  const body = el('div.poll-body', {}, question, display ? null : form, resultsBox);
  const panel = el(`aside.poll-panel${display ? '.poll-display' : ''}`, { id: 'poll-panel', hidden: true, 'aria-labelledby': 'poll-question' },
    el('header.poll-head', {}, el('span.poll-kicker', {}, icon('poll'), t('poll')), kind, minBtn),
    body);
  const pill = el('button.poll-pill', {
    type: 'button', id: 'poll-pill', hidden: true, 'aria-controls': 'poll-panel', onclick: () => setMinimized(false),
  }, icon('poll'), el('span', {}, t('poll')), el('span.poll-pill-dot', { hidden: true }));
  app.append(panel);
  badges.prepend(pill);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!poll?.open || !selection.length || pending) return;
    error = null;
    pending = true;
    send({ t: 'vote', id: poll.id, choice: [...selection].sort((a, b) => a - b) });
    render();
  });

  function setMinimized(on) {
    minimized = on;
    render();
    // Keyboard users land where the poll went or came back. On the projector
    // the focus goes back to the page, so a clicker's Space is a step again.
    if (display) document.activeElement?.blur();
    else (on ? pill : minBtn).focus({ preventScroll: true });
  }

  // ---- participant: the answers -------------------------------------------------
  let builtFor = null;
  function buildOptions() {
    const key = `${poll.id}|${poll.multiple}|${JSON.stringify(poll.options)}`;
    if (key === builtFor) return;
    builtFor = key;
    const type = poll.multiple ? 'checkbox' : 'radio';
    options.replaceChildren(...poll.options.map((text, i) => {
      const input = el('input', { type, name: 'poll-answer', value: String(i), id: `poll-answer-${i}` });
      input.addEventListener('change', () => {
        if (poll.multiple) selection = [...options.querySelectorAll('input:checked')].map((x) => Number(x.value));
        else selection = [i];
        dirty = true;
        error = null;
        render();
      });
      return el('label.poll-option', { htmlFor: `poll-answer-${i}` },
        input, el('span.poll-letter', {}, letter(i)), el('span.poll-text', {}, text));
    }));
  }

  function renderForm() {
    buildOptions();
    for (const input of options.querySelectorAll('input')) {
      input.checked = selection.includes(Number(input.value));
      input.disabled = !poll.open;
    }
    const same = mine !== null && sameSet(selection, mine);
    sendBtn.textContent = mine ? t('pollChange') : t('pollSend');
    sendBtn.disabled = !poll.open || !selection.length || same || pending;
    status.className = 'poll-status';
    if (error) {
      status.textContent = t({ 'poll-closed': 'pollClosedYou', 'slow-down': 'pollSlowDown' }[error] ?? 'pollNotSent');
      status.classList.add('poll-status-error');
    } else if (pending) {
      status.textContent = t('pollSending');
    } else if (same) {
      status.textContent = t('pollSent');
      status.classList.add('poll-status-ok');
    } else {
      status.textContent = mine ? t('pollChangedNotSent') : '';
    }
  }

  // The projector: nobody scrolls it, so the text shrinks until the whole
  // poll fits (down to 55 %), and grows back when there is room.
  function fit() {
    if (!display || panel.hidden) return;
    let scale = 1;
    body.style.setProperty('--poll-scale', '1');
    while (body.scrollHeight > body.clientHeight + 1 && scale > 0.55) {
      scale -= 0.05;
      body.style.setProperty('--poll-scale', scale.toFixed(2));
    }
  }
  if (display) window.addEventListener('resize', fit);

  // ---- both ---------------------------------------------------------------------
  function render() {
    const visible = Boolean(poll) && !minimized && !(display && blank);
    panel.hidden = !visible;
    pill.hidden = !poll || !minimized || (display && blank);
    minBtn.setAttribute('aria-expanded', String(visible));
    document.body.classList.toggle('poll-open', visible);
    if (!poll) return;
    question.textContent = poll.question;
    kind.textContent = poll.multiple ? t('pollMultiple') : t('pollSingle');
    pill.querySelector('.poll-pill-dot').hidden = display || !poll.open || mine !== null;
    if (display) {
      // The projector shows the counts only once the presenter makes them
      // public, and the right answers only once answers close too. A display
      // gets none before; a projector tab that controls the slides connects
      // as a presenter and gets them, so it holds them back itself.
      const key = poll.open || !poll.revealed ? null : poll.correct;
      results.update(poll.revealed ? poll : { ...poll, counts: null }, { correct: key });
      total.textContent = `${answers(poll.voters)} · ${poll.open ? t('pollAnswerOnDevice') : t('pollClosedState')}`;
      showGrades(key?.length ? poll.grades : null);
      fit();
      return;
    }
    // A participant answers while answers are open, and sees the results
    // once the presenter makes them public (D1 of 0008): usually on closing answers,
    // possibly while they are still open.
    const r = poll.results;
    form.hidden = !poll.open;
    resultsBox.hidden = poll.open && !r;
    closedNote.hidden = poll.open;
    if (poll.open) renderForm();
    if (resultsBox.hidden) return;
    closedNote.textContent = mine ? t('pollClosedYou') : `${t('pollClosedYou')} ${t('pollNotAnswered')}`;
    // Closed but not public yet: the answers, one's own marked, no counts.
    results.update({ options: poll.options, counts: r?.counts ?? null, voters: r?.voters ?? 0 }, { mine, correct: r?.correct ?? null });
    total.textContent = r ? answers(r.voters) : t('pollResultsNotYet');
    showGrades(r?.correct?.length ? r.grades : null);
    const grade = r?.correct?.length ? r.grade : null;
    verdict.hidden = !grade;
    verdict.className = grade ? `poll-verdict poll-verdict-${grade}` : 'poll-verdict';
    if (grade) {
      verdict.firstChild.replaceChildren(icon({ right: 'check', partial: 'partial', wrong: 'cross' }[grade]));
      verdictText.textContent = t({ right: 'pollVerdictRight', partial: 'pollVerdictPartial', wrong: 'pollVerdictWrong' }[grade]);
    }
  }

  // Public results of a poll still taking answers: the counts as they grow.
  function followCounts({ id, counts, voters }) {
    if (!poll?.results || poll.id !== id || !Array.isArray(counts)) return;
    poll = { ...poll, results: { ...poll.results, counts, voters } };
    render();
  }

  function showGrades(g) {
    grades.hidden = !g;
    grades.textContent = g ? gradesText(g, poll.multiple) : '';
  }

  // The poll as the server has it now: `next` is null when none is shown;
  // `ack` when it answers this participant's own answer.
  function take(next, nextMine = null, ack = false) {
    const fresh = Boolean(next) && next.id !== poll?.id;
    if (fresh || !next) {
      // A new poll, or one shown again: open, nothing ticked but the answer
      // the server keeps (D8).
      if (fresh) minimized = false;
      dirty = false;
      pending = false;
      error = null;
    }
    if (next && poll && next.open !== poll.open) error = null;
    poll = next;
    mine = nextMine;
    // What is ticked here is settled once the server has it (from this tab
    // or another of the same participant); an answer lost with the connection
    // stays ticked, to send again.
    if (dirty && mine && sameSet(mine, selection)) dirty = false;
    if (ack) pending = false;
    if (!dirty) selection = mine ? [...mine] : [];
    render();
  }

  return {
    attach(sender) { send = sender; },
    // `poll` (participant) or `polls` (display) messages.
    onMessage(msg) {
      if (msg.t === 'poll' && !display) take(msg.poll ?? null, Array.isArray(msg.mine) ? msg.mine : null, msg.ack === true);
      else if (msg.t === 'poll-counts' && !display) followCounts(msg);
      else if (msg.t === 'polls' && display) take(msg.runs?.find((r) => r.slide === msg.shown) ?? null);
    },
    onError(msg) {
      pending = false;
      error = msg.code;
      render();
    },
    // A new connection: an answer sent on the old one may never have arrived.
    connection(status) {
      if (status !== 'open' || !pending) return;
      pending = false;
      error = 'lost';
      render();
    },
    setBlank(on) {
      if (blank === on) return;
      blank = on;
      render();
    },
    // The room closed, or this participant was removed.
    clear() { take(null); },
  };
}
