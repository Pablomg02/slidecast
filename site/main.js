// slidecast website: the scroll-driven story, the use cases, the setup guide,
// reveals, copy buttons and the video.
(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

  // ------------------------------------------------------------ The deck
  // Steps of the mini deck, as in a real slidecast deck: [slide, step].
  const STEPS = [[0, 0], [1, 0], [1, 1], [1, 2], [2, 0], [3, 0], [3, 1], [4, 0]];
  const SLIDE_IDS = ['intro', 'why', 'try', 'quiz', 'end'];
  const NOTES = [
    'Ask first: <b>how long is a year on Neptune?</b> Let them guess.',
    'Two reasons stack up: a weaker pull and a longer path.',
    'Everyone moves the slider <b>on their own phone</b>. Find Neptune!',
    'Give them ten seconds, then reveal: <b>Neptune</b>, 165 years.',
    'Homework: find the year of three planets.',
  ];

  const ADMIN_NOTE = 'Ask first: how long is a year on Neptune? Let them guess.';
  const ACCENTS = ['#818cf8', '#f472b6', '#34d399', '#fbbf24'];

  // ----------------------------------------------------------- A stage
  // Devices drawn in CSS that show the mini deck. scenes maps a name to
  // { layout: { device: [x, y, width, 'dim'?] }, wires: [device], source,
  // viewers, labels: { device: text } }, in stage units (the stage is 100 × 100).
  // set(name, target) moves to a scene and shows target = { live, black,
  // behind: { device: step }, slider: { device: 0..1 }, mode, hint, chat }.
  function createStage(root, scenes) {
    root.append(document.getElementById('stage-tpl').content.cloneNode(true));
    const deckTpl = document.getElementById('deck-tpl');
    for (const screen of root.querySelectorAll('.screen')) screen.append(deckTpl.content.cloneNode(true));
    const dev = {};
    for (const el of root.querySelectorAll('.dev')) {
      dev[el.dataset.dev] = el;
      el.dataset.labelDefault = el.dataset.label;
    }
    const q = (sel) => root.querySelector(sel);
    const state = { live: 0, black: false, behind: {}, slider: {} };

    function showStep(screen, index) {
      const [slide, sub] = STEPS[clamp(index, 0, STEPS.length - 1)];
      const deck = screen.firstElementChild;
      for (const sl of deck.children) sl.classList.toggle('on', Number(sl.dataset.slide) === slide);
      for (const el of deck.querySelectorAll('[data-sub]')) el.classList.toggle('shown', Number(el.dataset.sub) <= sub);
      deck.classList.toggle('answered', slide === 3 && sub >= 1);
    }

    // Draws one device from the current state.
    function render(el) {
      const own = state.behind[el.dataset.dev];
      const away = own != null && own !== state.live;
      el.classList.toggle('behind', away);
      for (const pill of el.querySelectorAll('.pill')) {
        pill.textContent = !away ? '● Live' : own < state.live ? '◀ Looking back' : 'Looking ahead ▶';
      }
      for (const screen of el.querySelectorAll('.screen')) {
        const role = screen.dataset.deck;
        showStep(screen, role === 'next' ? state.live + 1 : role === 'edit' ? 0 : away ? own : state.live);
        screen.classList.toggle('black', role === 'view' && state.black);
        const v = state.slider[el.dataset.dev] ?? 0.02;
        screen.style.setProperty('--v', v);
        const years = screen.querySelector('.years');
        if (years) years.textContent = Math.pow(0.4 + v * 29.6, 1.5).toFixed(1);
      }
      const [slide, sub] = STEPS[state.live];
      for (const n of el.querySelectorAll('.notes-text')) n.innerHTML = NOTES[slide];
      for (const n of el.querySelectorAll('.notes-slide')) n.textContent = `${SLIDE_IDS[slide]} · step ${sub}`;
      for (const n of el.querySelectorAll('.count')) n.textContent = `${state.live + 1} / ${STEPS.length}`;
    }
    const renderAll = () => Object.values(dev).forEach(render);

    let scene = null;
    let sceneAt = 0;
    // Bumped on every scene change: pulses still flying belong to the old one.
    let gen = 0;
    function enterScene(name) {
      if (scene === name) return;
      scene = name;
      sceneAt = performance.now();
      gen += 1;
      root.querySelectorAll('.pulse').forEach((dot) => dot.remove());
      const s = scenes[name];
      root.dataset.scene = name;
      for (const [id, el] of Object.entries(dev)) {
        const spot = s.layout[id];
        el.classList.toggle('on', !!spot);
        el.classList.toggle('dim', spot?.[3] === 'dim');
        el.dataset.label = s.labels?.[id] ?? el.dataset.labelDefault;
        if (spot) {
          el.style.setProperty('--x', `${spot[0]}%`);
          el.style.setProperty('--y', `${spot[1]}%`);
          el.style.setProperty('--w', `${spot[2]}%`);
        }
      }
      for (const n of root.querySelectorAll('.viewers')) {
        const v = s.viewers ?? 0;
        n.textContent = `${v} viewer${v === 1 ? '' : 's'}`;
      }
      followWires(1100);
    }

    // Wires from slidecast to every device of the scene.
    const wires = q('.wires');
    const center = (el) => {
      const r = el.querySelector('.body').getBoundingClientRect();
      const s = root.getBoundingClientRect();
      return { x: r.left - s.left + r.width / 2, y: r.top - s.top + r.height / 2 };
    };
    const curve = (a, b) => {
      const f = (n) => n.toFixed(1);
      const my = (a.y + b.y) / 2;
      return `M${f(a.x)} ${f(a.y)} C${f(a.x)} ${f(my)} ${f(b.x)} ${f(my)} ${f(b.x)} ${f(b.y)}`;
    };
    function drawWires() {
      const list = scenes[scene]?.wires ?? [];
      const hub = center(dev.hub);
      wires.innerHTML = list.map((id) => `<path d="${curve(hub, center(dev[id]))}"/>`).join('');
    }
    let wiresUntil = 0;
    function followWires(ms) {
      const running = performance.now() < wiresUntil;
      wiresUntil = Math.max(wiresUntil, performance.now() + ms);
      if (running) return;
      (function loop() {
        drawWires();
        if (performance.now() < wiresUntil) requestAnimationFrame(loop);
      })();
    }

    // A change goes from the source to slidecast, then out to every screen.
    function travel(from, to, ms) {
      const dot = document.createElement('i');
      dot.className = 'pulse';
      dot.style.offsetPath = `path("${curve(from, to)}")`;
      root.append(dot);
      const anim = dot.animate([{ offsetDistance: '0%', opacity: 0.4 }, { offsetDistance: '100%', opacity: 1 }], { duration: ms, easing: 'cubic-bezier(.5,0,.5,1)' });
      return anim.finished.then(() => dot.remove(), () => dot.remove());
    }
    function ping(el) {
      el.classList.remove('ping');
      void el.offsetWidth;
      el.classList.add('ping');
    }
    function broadcast() {
      const s = scenes[scene];
      const source = dev[s.source ?? 'laptop'];
      render(source);
      const shown = (el) => el.classList.contains('on') && el.querySelector('.screen');
      const targets = (s.wires ?? []).map((id) => dev[id]).filter((el) => el !== source && shown(el));
      if (s.source === 'remote' && !targets.includes(dev.laptop) && shown(dev.laptop)) targets.push(dev.laptop);
      // While devices are still moving to a new scene, just show the result.
      const settling = performance.now() - sceneAt < 1100;
      if (reduced || settling || !shown(source) || !targets.length) { renderAll(); return; }
      const g = gen;
      travel(center(source), center(dev.hub), 380).then(() => {
        if (g !== gen) return renderAll();
        ping(dev.hub);
        const hub = center(dev.hub);
        for (const t of targets) {
          travel(hub, center(t), 420).then(() => { render(t); if (g === gen) ping(t); });
        }
      });
      // Devices off stage just catch up.
      for (const el of Object.values(dev)) if (!el.classList.contains('on')) render(el);
    }

    const keycap = q('.keycap');
    let keyTimer;
    function press(label) {
      const s = scenes[scene];
      if (s.source === 'remote') {
        const tap = q('.ph-btns .go');
        tap.classList.remove('tap');
        void tap.offsetWidth;
        tap.classList.add('tap');
        return;
      }
      if (!dev.laptop.classList.contains('on')) return;
      keycap.textContent = label;
      keycap.classList.add('on');
      clearTimeout(keyTimer);
      keyTimer = setTimeout(() => keycap.classList.remove('on'), 650);
    }

    function set(name, t) {
      enterScene(name);
      const chat = t.chat ?? 1;
      dev.browser.classList.toggle('c1', chat > 0.05);
      dev.browser.classList.toggle('c2', chat > 0.3);
      dev.browser.classList.toggle('c3', chat > 0.75);

      const live = t.live ?? 0;
      const black = t.black ?? false;
      if (live !== state.live || black !== state.black) {
        press(live > state.live ? '→' : live < state.live ? '←' : 'B');
        state.live = live;
        state.black = black;
        root.classList.toggle('black', black);
        broadcast();
      }

      const behind = t.behind ?? {};
      for (const id of new Set([...Object.keys(state.behind), ...Object.keys(behind)])) {
        if (behind[id] === state.behind[id]) continue;
        const el = dev[id];
        const btn = el.querySelector('.back-live');
        const back = behind[id] == null && el.classList.contains('behind') && btn;
        if (back) {
          // Show the tap on "Back to live" before the device jumps.
          btn.classList.add('tap');
          const g = gen;
          setTimeout(() => {
            btn.classList.remove('tap');
            if (g === gen && state.behind[id] == null) { render(el); ping(el); }
          }, 450);
        }
      }
      const changed = JSON.stringify(behind) !== JSON.stringify(state.behind);
      state.behind = behind;
      if (changed) for (const el of Object.values(dev)) if (!el.querySelector('.back-live.tap')) render(el);

      const slider = t.slider ?? {};
      if (JSON.stringify(slider) !== JSON.stringify(state.slider)) {
        state.slider = slider;
        renderAll();
      }

      root.classList.toggle('show-modes', !!t.mode);
      for (const m of root.querySelectorAll('[data-mode]')) m.classList.toggle('on', m.dataset.mode === t.mode);
      root.classList.toggle('show-hint', !!t.hint);
      if (t.hint) q('.hint').textContent = t.hint;

      // The admin page: which tab is open and what has been filled in.
      const ad = t.admin ?? { tab: 'notes', typed: 0 };
      const page = dev.admin;
      page.dataset.tab = ad.tab;
      page.querySelector('.typed-notes').textContent = ADMIN_NOTE.slice(0, Math.round(ADMIN_NOTE.length * (ad.typed ?? 1)));
      for (const row of page.querySelectorAll('[data-toggle]')) row.classList.toggle('on', !!ad[row.dataset.toggle]);
      page.style.setProperty('--pick', ACCENTS[ad.accent ?? 0]);
      for (const sw of page.querySelectorAll('[data-c]')) sw.classList.toggle('on', Number(sw.dataset.c) === (ad.accent ?? 0));
      for (const n of page.querySelectorAll('.site-name')) n.textContent = ad.name ?? 'slidecast';
    }

    renderAll();
    return { set, redraw: () => followWires(50) };
  }

  // ----------------------------------------------------- The story stage
  // The presenter's side sits at the top, slidecast in the middle and the
  // viewers at the bottom.
  const AUDIENCE = {
    laptop: [8, 2, 36], remote: [56, 2, 11], hub: [44, 38, 12],
    projector: [1, 66, 30], aud2: [34, 66, 24], aud1: [62, 62, 9], aud3: [75, 62, 9], aud4: [88, 62, 9],
  };
  const ALL_AUD = ['laptop', 'projector', 'remote', 'aud1', 'aud2', 'aud3', 'aud4'];
  const SCENES = {
    deck: { layout: { browser: [10, 22, 80] } },
    enter: {
      layout: { browser: [3, 12, 32], hub: [56, 10, 22], place1: [8, 54, 34], place2: [58, 54, 34] },
      wires: ['browser', 'place1', 'place2'],
    },
    admin: { layout: { admin: [5, 6, 90], hub: [44, 80, 12] }, wires: ['admin'] },
    presenter: { layout: { laptop: [6, 4, 64], hub: [44, 64, 12] }, wires: ['laptop'] },
    projector: { layout: { laptop: [4, 2, 52], hub: [44, 46, 12], projector: [48, 68, 46] }, wires: ['laptop', 'projector'], viewers: 1 },
    sync: { same: 'projector' },
    remote: {
      layout: { laptop: [4, 2, 44], remote: [62, 2, 13], hub: [44, 44, 12], projector: [30, 68, 40] },
      wires: ['laptop', 'projector', 'remote'], source: 'remote', viewers: 1,
    },
    audience: { layout: AUDIENCE, wires: ALL_AUD, viewers: 5 },
    interactive: {
      layout: { hub: [44, 4, 12], aud1: [4, 34, 20], aud2: [28, 40, 44], aud3: [76, 34, 20] },
      wires: ['aud1', 'aud2', 'aud3'], viewers: 5,
    },
    pace: { layout: { laptop: [4, 12, 40], hub: [62, 18, 12], aud2: [20, 52, 60] }, wires: ['laptop', 'aud2'], viewers: 5 },
    blackout: { layout: AUDIENCE, wires: ALL_AUD, viewers: 5 },
    anywhere: {
      layout: { hub: [40, 6, 20], place1: [2, 50, 30], place2: [35, 50, 30], place3: [68, 50, 30] },
      wires: ['place1', 'place2', 'place3'], viewers: 5,
    },
  };
  for (const s of Object.values(SCENES)) if (s.same) Object.assign(s, { ...SCENES[s.same], ...s });

  // What each scene shows for a scroll progress p (0..1).
  const TARGETS = {
    deck: (p) => ({ chat: p }),
    // Notes being typed, then passwords switched on, then a new look.
    admin: (p) => ({
      admin: p < 0.36 ? { tab: 'notes', typed: clamp(p / 0.3) }
        : p < 0.7 ? { tab: 'access', presenter: p > 0.45, viewer: p > 0.57 }
          : { tab: 'look', accent: p > 0.8 ? 1 : 0, name: p > 0.88 ? 'Physics · Year 9' : 'slidecast' },
    }),
    sync: (p) => ({ live: Math.min(3, Math.floor(p * 4.5)) }),
    remote: (p) => ({ live: p < 0.45 ? 3 : 4 }),
    audience: () => ({ live: 4 }),
    interactive: (p) => ({ live: 4, slider: { aud1: p, aud2: clamp(p * 1.7 - 0.3), aud3: 0.1 + 0.3 * p } }),
    // Leo follows, steps back through the deck, sees "Back to live", returns.
    pace: (p) => ({
      live: 6,
      mode: 'back',
      behind: p < 0.2 || p >= 0.78 ? {} : { aud2: p < 0.55 ? 5 - Math.min(4, Math.floor(((p - 0.2) / 0.3) * 5)) : 1 },
      hint: p < 0.2 ? 'Leo follows you, slide by slide'
        : p < 0.55 ? 'Leo goes back to re-read a slide…'
          : p < 0.78 ? '…while you carry on presenting'
            : 'One tap on “Back to live” and Leo is with you again',
    }),
    blackout: (p) => ({ live: 6, black: p > 0.2 && p < 0.8 }),
    anywhere: () => ({ live: 7 }),
  };

  const stageEl = document.getElementById('stage');
  const story = stageEl && createStage(stageEl, SCENES);

  // ------------------------------------------------------------ Scroll
  const steps = [...document.querySelectorAll('.step')];
  const wrap = document.querySelector('.stage-wrap');
  const bar = document.getElementById('progress');
  const mobile = matchMedia('(max-width: 860px)');
  let ticking = false;

  function onScroll() {
    ticking = false;
    const vh = innerHeight;
    if (story) {
      // The reading line: mid-screen, or mid-way below the pinned stage on phones.
      const line = mobile.matches ? (() => { const b = wrap.getBoundingClientRect().bottom; return b + (vh - b) * 0.45; })() : vh * 0.55;
      let active = steps[0];
      let p = 0;
      for (const step of steps) {
        const r = step.getBoundingClientRect();
        if (r.top <= line) {
          active = step;
          // On phones the cards are spaced out: count the gap after them too.
          const span = mobile.matches ? (step.nextElementSibling?.getBoundingClientRect().top ?? r.bottom + vh * 0.3) - r.top : r.height;
          p = clamp((line - r.top) / span);
        }
      }
      for (const step of steps) step.classList.toggle('active', step === active);
      const name = active.dataset.scene;
      story.set(name, (TARGETS[name] ?? (() => ({})))(p));
    }
    const max = document.documentElement.scrollHeight - vh;
    bar.style.transform = `scaleX(${max > 0 ? scrollY / max : 0})`;
  }
  const schedule = () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } };
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', () => { story?.redraw(); cases?.redraw(); schedule(); });
  onScroll();

  // --------------------------------------------------------- Use cases
  // Each case plays a loop of frames, one every BEAT ms.
  const BEAT = 1700;
  const run = (...lives) => lives.map((live) => ({ live }));
  const CASES = {
    classroom: {
      scene: {
        layout: { laptop: [4, 2, 46], hub: [44, 42, 12], projector: [2, 64, 40], aud1: [48, 62, 9], aud3: [60, 62, 9], aud2: [73, 64, 25] },
        wires: ['laptop', 'projector', 'aud1', 'aud2', 'aud3'], viewers: 4,
        labels: { projector: 'The projector', aud2: 'Leo' },
      },
      frames: [
        ...run(0, 1, 2, 3, 4),
        { live: 4, slider: { aud1: 0.35, aud2: 0.7, aud3: 0.15 } },
        { live: 4, slider: { aud1: 0.9, aud2: 0.45, aud3: 0.6 } },
        ...run(5, 6),
        { live: 6, black: true },
        { live: 6, black: true },
        ...run(7),
      ],
    },
    talk: {
      scene: {
        layout: { remote: [43, 0, 14], hub: [44, 40, 12], projector: [2, 64, 46], aud1: [55, 62, 9], aud3: [68, 62, 9], aud4: [81, 62, 9] },
        wires: ['remote', 'projector', 'aud1', 'aud3', 'aud4'], source: 'remote', viewers: 4,
        labels: { remote: 'You, on stage', projector: 'The big screen', aud1: 'Row 12', aud3: 'Row 20', aud4: 'Row 31' },
      },
      frames: run(0, 1, 2, 3, 4, 5, 6, 7),
    },
    workshop: {
      scene: {
        layout: { laptop: [4, 10, 44], hub: [62, 18, 12], aud1: [6, 56, 14], aud2: [30, 60, 38], aud3: [78, 56, 14] },
        wires: ['laptop', 'aud1', 'aud2', 'aud3'], viewers: 3,
      },
      frames: [
        { live: 1, mode: 'free' },
        { live: 2, mode: 'free', behind: { aud1: 1 } },
        { live: 3, mode: 'free', behind: { aud1: 1, aud3: 5 } },
        { live: 3, mode: 'free', behind: { aud1: 2, aud3: 6 } },
        { live: 4, mode: 'free', behind: { aud3: 6 }, slider: { aud1: 0.5, aud2: 0.2 } },
        { live: 4, mode: 'free', behind: { aud3: 6 }, slider: { aud1: 0.85, aud2: 0.6 } },
        { live: 4, mode: 'follow', slider: { aud1: 0.85, aud2: 0.6 } },
        { live: 5, mode: 'follow' },
        { live: 6, mode: 'follow' },
      ],
    },
    online: {
      scene: {
        layout: { laptop: [4, 2, 40], hub: [44, 40, 12], place3: [60, 4, 22], projector: [2, 64, 34], aud2: [40, 66, 26], aud1: [74, 62, 11] },
        wires: ['laptop', 'place3', 'projector', 'aud2', 'aud1'], viewers: 3,
        labels: { hub: 'slidecast, on a server', projector: 'In the room', aud2: 'At home', aud1: 'On the go' },
      },
      frames: run(0, 1, 2, 3, 4, 5, 6, 7),
    },
  };

  const caseEl = document.getElementById('case-stage');
  const cases = caseEl && createStage(caseEl, Object.fromEntries(Object.entries(CASES).map(([k, c]) => [k, c.scene])));
  if (cases) {
    const tabs = [...document.querySelectorAll('.tabs [data-case]')];
    const panels = [...document.querySelectorAll('.case-panel')];
    let current = 'classroom';
    let frame = 0;
    let timer = null;
    let visible = false;
    let touched = false;

    function show(name) {
      current = name;
      frame = 0;
      for (const t of tabs) {
        const on = t.dataset.case === name;
        t.setAttribute('aria-selected', on);
        t.classList.toggle('on', on);
        t.style.setProperty('--cycle', `${CASES[name].frames.length * BEAT}ms`);
        t.classList.remove('playing');
      }
      for (const p of panels) p.hidden = p.dataset.case !== name;
      cases.set(name, CASES[name].frames[0]);
      restart();
    }
    function tick() {
      const c = CASES[current];
      frame += 1;
      if (frame >= c.frames.length) {
        // Until someone picks a tab, move on to the next case.
        if (!touched) return show(tabs[(tabs.findIndex((t) => t.dataset.case === current) + 1) % tabs.length].dataset.case);
        frame = 0;
      }
      cases.set(current, c.frames[frame]);
    }
    function restart() {
      clearInterval(timer);
      timer = null;
      const tab = tabs.find((t) => t.dataset.case === current);
      if (!visible || reduced) return;
      void tab.offsetWidth;
      tab.classList.toggle('playing', !touched);
      timer = setInterval(tick, BEAT);
    }
    tabs.forEach((t, i) => {
      t.addEventListener('click', () => { touched = true; show(t.dataset.case); });
      t.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        const next = tabs[(i + d + tabs.length) % tabs.length];
        next.focus();
        next.click();
      });
    });
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; restart(); }, { threshold: 0.35 }).observe(caseEl);
    show(current);
  }

  // The presenter's timer.
  const started = Date.now();
  setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    const text = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    document.querySelectorAll('.timer').forEach((t) => { t.textContent = text; });
  }, 1000);

  // ------------------------------------------------------ Setup guide
  const setup = document.querySelector('.setup');
  if (setup) {
    const platform = navigator.userAgentData?.platform || navigator.platform || '';
    const choice = {
      os: /win/i.test(platform) ? 'win' : /mac|iphone|ipad/i.test(platform) ? 'mac' : 'linux',
      where: 'local',
    };
    function apply() {
      for (const seg of setup.querySelectorAll('.seg')) {
        for (const b of seg.querySelectorAll('button')) {
          const on = b.dataset.value === choice[seg.dataset.group];
          b.classList.toggle('on', on);
          b.setAttribute('aria-checked', on);
        }
      }
      for (const el of setup.querySelectorAll('[data-os], [data-where]')) {
        const os = !el.dataset.os || el.dataset.os.split(' ').includes(choice.os);
        const where = !el.dataset.where || el.dataset.where === choice.where;
        el.hidden = !(os && where);
      }
    }
    setup.addEventListener('click', (e) => {
      const b = e.target.closest('.seg button');
      if (!b) return;
      choice[b.closest('.seg').dataset.group] = b.dataset.value;
      apply();
    });
    apply();
  }

  // -------------------------------------------------------- Page extras
  // The new promise in the title writes itself letter by letter, each one
  // tinted along the brand gradient (violet, indigo, sky).
  const promise = document.querySelector('.hero .now');
  if (promise && !reduced) {
    const stops = [[167, 139, 250], [129, 140, 248], [56, 189, 248]];
    const tint = (t) => {
      const k = Math.min(1, Math.floor(t * 2));
      const f = t * 2 - k;
      return `rgb(${stops[k].map((c, i) => Math.round(c + (stops[k + 1][i] - c) * f)).join(',')})`;
    };
    const text = promise.textContent;
    promise.setAttribute('aria-label', text);
    promise.textContent = '';
    // Words stay whole so lines break between them, never inside one.
    let n = 0;
    for (const word of text.split(/(?<= )/)) {
      const w = document.createElement('span');
      w.setAttribute('aria-hidden', 'true');
      w.className = 'w';
      for (const ch of word) {
        const span = document.createElement('span');
        span.textContent = ch;
        span.style.color = tint(n / (text.length - 1));
        span.style.animationDelay = `${2150 + n * 32}ms`;
        w.append(span);
        n += 1;
      }
      promise.append(w);
    }
    promise.classList.add('typed');
  }

  document.querySelectorAll('.hero .reveal').forEach((el, i) => el.style.setProperty('--i', i));
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px' });
  document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

  for (const card of document.querySelectorAll('.card')) {
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--my', `${e.clientY - r.top}px`);
    });
  }

  for (const btn of document.querySelectorAll('[data-copy]')) {
    const label = btn.textContent;
    btn.addEventListener('click', async () => {
      try {
        const source = btn.dataset.copy ? document.querySelector(btn.dataset.copy) : btn.previousElementSibling;
        await navigator.clipboard.writeText(source.textContent);
        btn.textContent = 'Copied';
      } catch {
        btn.textContent = 'Select it';
      }
      setTimeout(() => { btn.textContent = label; }, 1600);
    });
  }

  // The AI section: one step at a time, picked on the left.
  const aiSteps = [...document.querySelectorAll('.ai-step')];
  const aiPanels = [...document.querySelectorAll('.ai-panel')];
  const upload = document.querySelector('.up-scene');
  function showAiStep(n) {
    for (const b of aiSteps) {
      const on = b.dataset.step === n;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on);
    }
    for (const p of aiPanels) p.hidden = p.dataset.step !== n;
    // The upload animation starts from the beginning each time it is shown.
    upload?.classList.remove('play');
    if (n === '3' && !reduced) { void upload.offsetWidth; upload.classList.add('play'); }
  }
  aiSteps.forEach((b) => b.addEventListener('click', () => showAiStep(b.dataset.step)));
  document.querySelectorAll('.ai-next[data-goto]').forEach((b) => b.addEventListener('click', () => {
    showAiStep(b.dataset.goto);
    if (mobile.matches) document.querySelector('.ai-steps').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }));
  if (aiSteps.length) showAiStep('1');

  // The AI prompt shows its first lines until someone asks for all of it.
  const promptToggle = document.querySelector('.prompt-toggle');
  promptToggle?.addEventListener('click', () => {
    const open = document.getElementById('prompt-text').classList.toggle('open');
    promptToggle.setAttribute('aria-expanded', open);
    promptToggle.textContent = open ? 'Show less' : 'Read the full prompt';
  });

  // The demo video plays muted while on screen.
  const video = document.getElementById('demo-video');
  if (video && !reduced) {
    new IntersectionObserver(([e]) => {
      if (e.isIntersecting) video.play().catch(() => {});
      else video.pause();
    }, { threshold: 0.5 }).observe(video);
  }
})();
