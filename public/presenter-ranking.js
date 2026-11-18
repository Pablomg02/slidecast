// The contest's ranking in the presenter view (0009, D26): the Ranking tab
// on a computer, a pop-up from "More" on a phone. Presenters see every
// participant live; the screens get the top 10 only when one shows it.
import { t, lang, el, confirmButton, participantLabel, participantNumber } from './shell.js';

export function createPresenterRanking({ send, slug, onReveal }) {
  let ranking = { on: false, shown: false, counted: 0, unscored: [], rows: [], config: null };
  let questions = new Map(); // slide id → question, for the "not scored yet" list
  const armed = { key: null, until: 0 };

  const showBtn = el('button.small.primary', { type: 'button', id: 'ranking-show', onclick: () => toggleShown() });
  const csv = el('a.button.small', { id: 'ranking-csv', download: '' }, t('rankingCsv'));
  const csvHref = () => `/api/decks/${encodeURIComponent(slug)}/contest.csv?lang=${lang}`;
  // Restarting erases every point: it asks first, offering the CSV before.
  const restartBox = el('div.p-ranking-restart', { hidden: true },
    el('p', {}, t('rankingRestartText')),
    el('div.row', {},
      el('a.button.small', { id: 'ranking-csv-first', download: '', href: csvHref(), onclick: () => { restartBox.hidden = false; } }, t('rankingCsvFirst')),
      el('button.small.danger', { type: 'button', id: 'ranking-restart-go', onclick: () => {
        restartBox.hidden = true;
        send({ t: 'contest', action: 'restart' });
      } }, t('rankingRestartGo')),
      el('button.small', { type: 'button', onclick: () => { restartBox.hidden = true; } }, t('cancel'))));
  const restart = el('button.small.danger', { type: 'button', id: 'ranking-restart', onclick: () => { restartBox.hidden = !restartBox.hidden; } },
    t('rankingRestart'));
  const counted = el('span.muted.p-ranking-counted', { id: 'ranking-counted' });
  const unscoredBox = el('div.p-ranking-unscored', { id: 'ranking-unscored', hidden: true });
  const list = el('ol.p-ranking-list', { id: 'ranking-rows' });
  const panel = el('div.p-panel.p-ranking', { id: 'ranking-panel', hidden: true },
    el('div.p-panel-head.p-ranking-head', {}, showBtn, csv, el('span.grow'), restart),
    restartBox,
    unscoredBox,
    counted,
    list);

  const setLabel = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  const tag = (b, action) => {
    b.dataset.action = action;
    return b;
  };
  // A confirm button without the red of a destructive action.
  const quiet = (b) => {
    b.classList.remove('danger');
    return b;
  };

  function toggleShown() {
    send({ t: 'contest', action: ranking.shown ? 'hide-ranking' : 'show-ranking' });
  }

  // Rebuilt only when what they show changed, and a focused button gets the
  // focus back: polls messages come several times a second during a poll.
  let bannerKey = null;
  let rowsKey = null;

  function keepFocus(box, rebuild) {
    const f = box.contains(document.activeElement) ? document.activeElement : null;
    const key = f && (f.closest('[data-id]')?.dataset.id ?? f.dataset.slide ?? '');
    const action = f?.dataset.action;
    rebuild();
    if (!f) return;
    const row = key ? box.querySelector(`[data-id="${CSS.escape(key)}"], [data-slide="${CSS.escape(key)}"]`) : null;
    const again = row && (action ? (row.matches(`[data-action="${action}"]`) ? row : row.querySelector(`[data-action="${action}"]`)) : row);
    (again ?? showBtn).focus({ preventScroll: true });
  }

  function render() {
    setLabel(showBtn, ranking.shown ? t('rankingHide') : t('rankingShow'));
    showBtn.classList.toggle('primary', !ranking.shown);
    showBtn.classList.toggle('p-poll-off', ranking.shown);
    if (csv.getAttribute('href') !== csvHref()) csv.href = csvHref();
    setLabel(counted, t('rankingCounted', { n: ranking.counted }));
    // Closed polls whose results were never shown do not count yet.
    const banner = JSON.stringify(ranking.unscored.map((id) => [id, questions.get(id) ?? id]));
    if (banner !== bannerKey) {
      bannerKey = banner;
      unscoredBox.hidden = !ranking.unscored.length;
      keepFocus(unscoredBox, () => unscoredBox.replaceChildren(el('p', {}, t('rankingUnscored')),
        ...ranking.unscored.map((id) => el('div.row.p-ranking-unscored-row', {},
          el('span.grow', {}, questions.get(id) ?? id),
          el('button.small.p-poll-go', { type: 'button', dataset: { slide: id, action: 'reveal' }, onclick: () => onReveal(id) }, t('pollShowResults'))))));
    }
    const rowsNow = JSON.stringify(ranking.rows);
    if (rowsNow === rowsKey) return;
    rowsKey = rowsNow;
    keepFocus(list, () => {
      if (!ranking.rows.length) {
        list.replaceChildren(el('li.p-empty.muted', {}, t('rankingEmpty')));
        return;
      }
      list.replaceChildren(...ranking.rows.map((r) => el(`li.p-ranking-row${r.online ? '' : '.p-ranking-offline'}`, { dataset: { id: r.id } },
        el('span.p-ranking-pos', {}, String(r.pos)),
        el('span.p-ranking-who', {},
          el('strong', {}, participantLabel(r)),
          r.name ? el('span.muted', {}, ` #${participantNumber(r.n)}`) : null,
          r.online ? null : el('span.muted', {}, ` · ${t('rankingOffline')}`),
          el('span.muted.p-ranking-right', {}, t('rankingRight', { right: r.right, answered: r.answered }))),
        el('span.p-ranking-points', {}, t('rankingPts', { points: Number(r.points).toLocaleString() })),
        el('span.p-ranking-actions', {},
          r.name ? tag(quiet(confirmButton(t('rankingRename'), t('rankingRenameConfirm'), `rename:${r.id}`,
            () => send({ t: 'contest', action: 'rename', id: r.id }), armed)), 'rename') : null,
          // Removing a participant drops its points too, and frees its name.
          tag(confirmButton(t('kick'), t('confirmKick'), `kick:${r.id}`, () => send({ t: 'kick', id: r.id }), armed), 'kick')))));
    });
  }

  return {
    panel,
    get on() { return ranking.on; },
    // The deck's contest settings as the server has them now.
    get config() { return ranking.config; },
    get shown() { return ranking.shown; },
    get unscored() { return ranking.unscored; },
    update(msg) {
      ranking = {
        on: Boolean(msg.on), shown: Boolean(msg.shown), counted: msg.counted ?? 0,
        unscored: Array.isArray(msg.unscored) ? msg.unscored : [], rows: Array.isArray(msg.rows) ? msg.rows : [],
        config: msg.config ?? null,
      };
      render();
    },
    // The questions of the runs, from the polls message.
    setRuns(runs) {
      const next = new Map(runs.map((r) => [r.slide, r.question]));
      const changed = ranking.unscored.some((id) => next.get(id) !== questions.get(id));
      questions = next;
      if (changed) render();
    },
  };
}
