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
  // Contest mode (0009): the countdown runs from when this page got the
  // poll, and ends 0.5 s early, so a tap at "1" still arrives in time (D9).
  let deadline = null; // performance.now() when the countdown reaches 0
  let ticker = null;
  let sentChoice = null; // the choice of the answer waiting for the server
  let tapTimer = null; // arrow keys: send once the choice settles
  let keyed = false; // the last change came from the keyboard

  // ---- panel --------------------------------------------------------------------
  const kind = el('span.poll-kind');
  const minBtn = el('button.poll-min', {
    type: 'button', id: 'poll-minimize', title: t('pollMinimize'), 'aria-label': t('pollMinimize'),
    'aria-expanded': 'true', onclick: () => setMinimized(true),
  }, icon('minimize'));
  const question = el('h2.poll-question', { id: 'poll-question' });
  const contestLine = el('p.poll-contest-line', { id: 'poll-contest-line', hidden: true });
  const countdown = el('span.poll-countdown', { id: 'poll-countdown', hidden: true, role: 'timer' });
  const timeHint = el('p.poll-time-hint', { id: 'poll-time-hint', hidden: true }, t('pollChangeResets'));
  const scoreLine = el('p.poll-score', { id: 'poll-score', hidden: true });
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
  const resultsBox = el('div.poll-results-box', {}, closedNote, verdict, scoreLine, results.element, total, grades);
  const body = el('div.poll-body', {}, contestLine, question, display ? null : timeHint, display ? null : form, resultsBox);
  const panel = el(`aside.poll-panel${display ? '.poll-display' : ''}`, { id: 'poll-panel', hidden: true, 'aria-labelledby': 'poll-question' },
    el('header.poll-head', {}, el('span.poll-kicker', {}, icon('poll'), t('poll')), kind, countdown, minBtn),
    body);
  const pill = el('button.poll-pill', {
    type: 'button', id: 'poll-pill', hidden: true, 'aria-controls': 'poll-panel', onclick: () => setMinimized(false),
  }, icon('poll'), el('span', {}, t('poll')), el('span.poll-pill-dot', { hidden: true }));
  app.append(panel);
  badges.prepend(pill);

  function submit() {
    if (!poll?.open || !selection.length || pending || timeUp()) return;
    error = null;
    pending = true;
    sentChoice = [...selection];
    send({ t: 'vote', id: poll.id, choice: [...selection].sort((a, b) => a - b) });
    render();
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });

  // ---- contest mode (0009) --------------------------------------------------------
  const counting = () => Boolean(poll?.contest?.counts);
  // One answer to choose in a contest: a tap sends it (D25).
  const tapToSend = () => !display && counting() && !poll.multiple;
  const msLeft = () => (deadline === null ? null : Math.max(0, deadline - performance.now()));
  const timeUp = () => deadline !== null && msLeft() === 0;

  function setCountdown(left) {
    deadline = poll?.open && Number.isFinite(left) ? performance.now() + left - 500 : null;
    clearInterval(ticker);
    ticker = deadline === null ? null : setInterval(tick, 250);
    tick();
  }

  function tick() {
    const ms = msLeft();
    countdown.hidden = ms === null;
    if (ms === null) return;
    const s = Math.ceil(ms / 1000);
    countdown.textContent = s > 0 ? t('pollSecondsLeft', { s }) : t('pollTimeUp');
    countdown.classList.toggle('poll-countdown-warn', s <= 5);
    if (ms === 0) {
      clearInterval(ticker);
      ticker = null;
      if (!display && poll?.open) renderForm(); // locks the answers
    }
  }

  // How the points of a question that counted were made.
  function scoreText(score, r) {
    const max = Number(poll.contest.points).toLocaleString();
    if (!score.answered) return t('scoreNone');
    const parts = [];
    if (poll.multiple) {
      const hits = mine.filter((i) => r.correct.includes(i)).length;
      const misses = mine.length - hits;
      parts.push(misses ? `${t('scoreHits', { hits, right: r.correct.length })} ${t('scoreMisses', { misses })}`
        : t('scoreHits', { hits, right: r.correct.length }));
    } else {
      parts.push(t(score.c >= 1 ? 'scoreRightOne' : 'scoreWrongOne'));
    }
    if (poll.contest.speed > 0 && score.c > 0) {
      const sec = (ms) => (ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 });
      parts.push(t('scoreTime', { t: sec(score.t), total: sec(score.T) }));
    }
    return `${parts.join(' · ')} → ${t('scorePoints', { points: Number(score.points).toLocaleString(), max })}`;
  }

  function renderContest() {
    const c = poll.contest;
    contestLine.hidden = !c;
    if (c) {
      contestLine.textContent = !c.counts ? t('pollNoCount')
        : c.held && poll.open ? t('pollOnHold')
          : t(c.speed > 0 ? 'pollUpTo' : 'pollUpToNoSpeed', { points: Number(c.points).toLocaleString() });
    }
    timeHint.hidden = display || !c?.counts || !poll.open || !(c.speed > 0);
  }

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
        clearTimeout(tapTimer);
        if (tapToSend() && !(mine && sameSet(selection, mine))) {
          // A tap sends at once; arrow keys walk the options, so wait until
          // they stop. Chosen while another answer is on its way: sent when
          // the server has that one (take()).
          if (keyed) tapTimer = setTimeout(() => { if (!pending) submit(); else render(); }, 400);
          else if (!pending) submit();
          else render();
        } else {
          render();
        }
        keyed = false;
      });
      input.addEventListener('keydown', () => { keyed = true; });
      return el('label.poll-option', { htmlFor: `poll-answer-${i}` },
        input, el('span.poll-letter', {}, letter(i)), el('span.poll-text', {}, text));
    }));
  }

  function renderForm() {
    buildOptions();
    const locked = !poll.open || timeUp();
    for (const input of options.querySelectorAll('input')) {
      input.checked = selection.includes(Number(input.value));
      input.disabled = locked;
    }
    const same = mine !== null && sameSet(selection, mine);
    sendBtn.textContent = mine ? t('pollChange') : t('pollSend');
    sendBtn.disabled = locked || !selection.length || same || pending;
    // One tap sends; Send shows only when a choice is stuck unsent (refused,
    // lost with the connection, or chosen while the server had another).
    sendBtn.parentElement.hidden = tapToSend() && (pending || same || !selection.length || locked);
    status.className = 'poll-status';
    if (error) {
      status.textContent = t({ 'poll-closed': 'pollClosedYou', 'slow-down': 'pollSlowDown' }[error] ?? 'pollNotSent');
      status.classList.add('poll-status-error');
    } else if (pending) {
      status.textContent = t('pollSending');
    } else if (same) {
      status.textContent = t('pollSent');
      status.classList.add('poll-status-ok');
    } else if (timeUp()) {
      status.textContent = t('pollTimeUp');
    } else {
      status.textContent = mine ? t('pollChangedNotSent') : selection.length && counting() ? t('pollNotSentYet') : '';
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
    renderContest();
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
      const partial = counting() ? 'pollVerdictPartialContest' : 'pollVerdictPartial';
      verdictText.textContent = t({ right: 'pollVerdictRight', partial, wrong: 'pollVerdictWrong' }[grade]);
    }
    // Contest mode: the points of this question and how they were made.
    const score = poll.contest?.score;
    scoreLine.hidden = !score || !r?.correct;
    if (score && r?.correct) scoreLine.textContent = scoreText(score, r);
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
    setCountdown(next?.left);
    // What is ticked here is settled once the server has it (from this tab
    // or another of the same participant); an answer lost with the connection
    // stays ticked, to send again.
    if (dirty && mine && sameSet(mine, selection)) dirty = false;
    if (ack) pending = false;
    if (!dirty) selection = mine ? [...mine] : [];
    // Tapped again while the last answer was on its way: send the new one.
    const changed = ack && dirty && sentChoice && !sameSet(selection, sentChoice);
    if (ack) sentChoice = null;
    if (changed && tapToSend() && poll?.open) submit();
    else render();
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
