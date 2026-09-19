/* C# & .NET Learning Hub — router, progress tracking, search. No backend. */
(function () {
  'use strict';

  var KEY = { done: 'dnlh.done', checks: 'dnlh.checks', theme: 'dnlh.theme', last: 'dnlh.last', stages: 'dnlh.stages' };
  var index = null, project = null, searchDocs = null, flat = [];
  var main = document.getElementById('main');

  /* ---------- storage (never trusted, always guarded) ------------------ */
  function load(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }
  var done = load(KEY.done, {});
  var checks = load(KEY.checks, {});
  var stages = load(KEY.stages, {});

  function isDone(id) { return !!done[id]; }
  function setDone(id, on) {
    if (on) done[id] = new Date().toISOString(); else delete done[id];
    save(KEY.done, done);
  }

  /* ---------- theme ---------------------------------------------------- */
  var theme = localStorage.getItem(KEY.theme) || 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('theme-btn').addEventListener('click', function () {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(KEY.theme, theme); } catch (e) {}
  });

  /* ---------- helpers -------------------------------------------------- */
  function h(html) { var d = document.createElement('div'); d.innerHTML = html; return d; }
  function esc(s) { return LessonRender.escape(s); }
  function pct(a, b) { return b ? Math.round((a / b) * 100) : 0; }

  function phaseStats(p) {
    var c = p.lessons.filter(function (l) { return isDone(l.id); }).length;
    return { done: c, total: p.lessons.length, pct: pct(c, p.lessons.length) };
  }
  function courseStats() {
    var total = flat.length;
    var c = flat.filter(function (l) { return isDone(l.id); }).length;
    return { done: c, total: total, pct: pct(c, total) };
  }
  function blockChips(l) {
    var b = l.blocks || {}, out = [];
    if (b.exercise) out.push('<span class="chip chip-exercise">' + b.exercise + ' exercise' + (b.exercise > 1 ? 's' : '') + '</span>');
    if (b.challenge) out.push('<span class="chip chip-challenge">' + b.challenge + ' challenge' + (b.challenge > 1 ? 's' : '') + '</span>');
    if (b.project) out.push('<span class="chip chip-project">project work</span>');
    if (b.debug) out.push('<span class="chip chip-debug">debug</span>');
    if (b.interview) out.push('<span class="chip chip-interview">' + b.interview + ' interview Q</span>');
    return out.join('');
  }

  /* ---------- sidebar -------------------------------------------------- */
  function renderSidebar(activeId) {
    var nav = document.getElementById('nav');
    var openPhase = activeId ? activeId.split('/')[0] : null;
    nav.innerHTML = index.phases.map(function (p) {
      var s = phaseStats(p);
      var isOpen = p.id === openPhase || (!openPhase && p.order === 0);
      return '<details class="nav-phase"' + (isOpen ? ' open' : '') + '>' +
        '<summary>' +
          '<span class="nav-num">' + String(p.order).padStart(2, '0') + '</span>' +
          '<span class="nav-title">' + esc(p.title) + '</span>' +
          '<span class="nav-count' + (s.pct === 100 ? ' complete' : '') + '">' + s.done + '/' + s.total + '</span>' +
        '</summary>' +
        '<ul>' + p.lessons.map(function (l) {
          return '<li><a href="#/' + l.id + '" class="' +
            (l.id === activeId ? 'active ' : '') + (isDone(l.id) ? 'done' : '') + '">' +
            '<span class="tick">' + (isDone(l.id) ? '✓' : '') + '</span>' + esc(l.title) + '</a></li>';
        }).join('') + '</ul></details>';
    }).join('');

    var cs = courseStats();
    document.getElementById('sp-pct').textContent = cs.pct + '%';
    document.getElementById('sp-bar').style.width = cs.pct + '%';
    document.getElementById('sp-meta').textContent = cs.done + ' of ' + cs.total + ' lessons complete';
  }

  /* ---------- views ---------------------------------------------------- */
  function viewHome() {
    var t = index.totals, cs = courseStats();
    var last = localStorage.getItem(KEY.last);
    var next = flat.find(function (l) { return !isDone(l.id); }) || flat[0];
    var resume = (last && byId(last)) ? byId(last) : next;

    main.innerHTML =
      '<div class="page home">' +
      '<section class="hero">' +
        '<p class="eyebrow">Intermediate programmer → professional .NET developer</p>' +
        '<h1>Learn C# and .NET by building one real application.</h1>' +
        '<p class="lede">Sixteen phases, one project: <strong>TaskFlow</strong>, a production-style task management API. ' +
        'You start with a console app and finish with a containerised, tested, authenticated ASP.NET Core service backed by PostgreSQL — ' +
        'and you can explain every line of it.</p>' +
        '<div class="hero-actions">' +
          '<a class="btn primary" href="#/' + resume.id + '">' + (cs.done ? 'Continue: ' : 'Start: ') + esc(resume.title) + '</a>' +
          '<a class="btn" href="#/roadmap">See the roadmap</a>' +
        '</div>' +
        '<div class="hero-progress"><div class="bar big"><i style="width:' + cs.pct + '%"></i></div>' +
        '<span>' + cs.done + ' / ' + cs.total + ' lessons</span></div>' +
      '</section>' +

      '<section class="stats">' + [
        [t.lessons, 'lessons'], [t.exercises, 'exercises'], [t.challenges, 'challenges'],
        [t.projectSteps, 'project steps'], [t.snippets, 'code snippets'], [Math.round(t.minutes / 60) + 'h', 'of work']
      ].map(function (s) { return '<div class="stat"><strong>' + s[0] + '</strong><span>' + s[1] + '</span></div>'; }).join('') +
      '</section>' +

      '<section class="loop-card">' +
        '<h2>How every lesson works</h2>' +
        '<ol class="loop">' +
          ['Learn the idea', 'See a small example', 'Code it yourself', 'Complete an exercise',
           'Use it in TaskFlow', 'Solve a challenge', 'Move forward']
          .map(function (s, i) { return '<li><span>' + (i + 1) + '</span>' + s + '</li>'; }).join('') +
        '</ol>' +
        '<p class="loop-note">Roughly 10% explanation, 20% examples, 70% you writing code. ' +
        'Solutions stay collapsed until you open them — attempt first, then check.</p>' +
      '</section>' +

      '<section class="phase-grid">' + index.phases.map(function (p) {
        var s = phaseStats(p);
        return '<a class="phase-card" href="#/' + p.lessons[0].id + '">' +
          '<span class="pc-num">Phase ' + String(p.order).padStart(2, '0') + '</span>' +
          '<h3>' + esc(p.title) + '</h3>' +
          '<p>' + esc(p.blurb) + '</p>' +
          '<div class="bar"><i style="width:' + s.pct + '%"></i></div>' +
          '<span class="pc-meta">' + s.done + '/' + s.total + ' lessons</span></a>';
      }).join('') + '</section>' +
      '</div>';
  }

  function viewRoadmap() {
    main.innerHTML = '<div class="page">' +
      '<h1>Roadmap</h1>' +
      '<p class="lede">Each phase ends with working code in TaskFlow. Do not skip the project steps — they are what turn ' +
      'the reading into something you can defend in an interview.</p>' +
      '<ol class="roadmap">' + index.phases.map(function (p) {
        var s = phaseStats(p);
        return '<li class="' + (s.pct === 100 ? 'complete' : s.done ? 'started' : '') + '">' +
          '<div class="rm-head"><span class="rm-num">' + String(p.order).padStart(2, '0') + '</span>' +
          '<h2>' + esc(p.title) + '</h2><span class="rm-count">' + s.done + '/' + s.total + '</span></div>' +
          (p.goal ? '<p class="rm-goal"><strong>You can do this at the end:</strong> ' + esc(p.goal) + '</p>' : '') +
          '<ul class="rm-lessons">' + p.lessons.map(function (l) {
            return '<li><a href="#/' + l.id + '" class="' + (isDone(l.id) ? 'done' : '') + '">' +
              '<span class="tick">' + (isDone(l.id) ? '✓' : '○') + '</span>' + esc(l.title) +
              '<em>' + l.minutes + ' min</em></a></li>';
          }).join('') + '</ul></li>';
      }).join('') + '</ol></div>';
  }

  function viewProject() {
    var st = project.stages;
    main.innerHTML = '<div class="page">' +
      '<h1>' + esc(project.name) + '</h1>' +
      '<p class="lede">' + esc(project.summary) + '</p>' +
      '<div class="callout-plain"><strong>Where the code lives:</strong> <code>project/</code> in this repo. ' +
      'Every stage builds on the previous one — you are not starting over each time.</div>' +
      '<ol class="stages">' + st.map(function (s, i) {
        var key = 'stage' + (i + 1);
        return '<li class="' + (stages[key] ? 'complete' : '') + '">' +
          '<label class="stage-check"><input type="checkbox" data-stage="' + key + '"' + (stages[key] ? ' checked' : '') + '><span></span></label>' +
          '<div><div class="stage-head"><h2>Stage ' + (i + 1) + ' · ' + esc(s.title) + '</h2>' +
          '<span class="stage-phase">' + esc(s.phases) + '</span></div>' +
          '<p>' + esc(s.goal) + '</p>' +
          '<ul class="stage-list">' + s.deliverables.map(function (d) { return '<li>' + esc(d) + '</li>'; }).join('') + '</ul>' +
          '<p class="stage-run"><code>' + esc(s.run) + '</code></p></div></li>';
      }).join('') + '</ol></div>';

    main.querySelectorAll('[data-stage]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        stages[cb.dataset.stage] = cb.checked;
        save(KEY.stages, stages);
        cb.closest('li').classList.toggle('complete', cb.checked);
      });
    });
  }

  function byId(id) { return flat.find(function (l) { return l.id === id; }); }

  function viewLesson(id) {
    var lesson = byId(id);
    if (!lesson) return view404(id);
    var i = flat.indexOf(lesson), prev = flat[i - 1], next = flat[i + 1];
    var phase = index.phases.find(function (p) { return p.id === lesson.id.split('/')[0]; });

    main.innerHTML = '<div class="page lesson"><p class="loading">Loading…</p></div>';
    fetch(lesson.path + '?v=' + encodeURIComponent(index.generated))
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
      .then(function (raw) {
        var body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
        main.innerHTML =
          '<article class="page lesson">' +
            '<header class="lesson-head">' +
              '<p class="crumb"><a href="#/roadmap">Phase ' + String(phase.order).padStart(2, '0') + '</a> · ' + esc(phase.title) + '</p>' +
              '<h1>' + esc(lesson.title) + '</h1>' +
              (lesson.summary ? '<p class="lede">' + esc(lesson.summary) + '</p>' : '') +
              '<div class="lesson-meta"><span class="chip chip-time">' + lesson.minutes + ' min</span>' +
              (lesson.stage ? '<span class="chip chip-stage">' + esc(lesson.stage) + '</span>' : '') +
              blockChips(lesson) + '</div>' +
            '</header>' +
            '<div class="prose" id="prose">' + LessonRender.render(body) + '</div>' +
            '<footer class="lesson-foot">' +
              '<button class="btn primary complete-btn" id="complete-btn"></button>' +
              '<nav class="pager">' +
                (prev ? '<a class="pg prev" href="#/' + prev.id + '"><span>Previous</span><strong>' + esc(prev.title) + '</strong></a>' : '<span></span>') +
                (next ? '<a class="pg next" href="#/' + next.id + '"><span>Next</span><strong>' + esc(next.title) + '</strong></a>' : '<span></span>') +
              '</nav>' +
            '</footer>' +
          '</article>';
        wireLesson(lesson);
        try { localStorage.setItem(KEY.last, lesson.id); } catch (e) {}
        renderSidebar(lesson.id);
        var target = location.hash.split('#')[2];
        if (target) { var el = document.getElementById(target); if (el) el.scrollIntoView(); }
        else main.scrollTop = 0, window.scrollTo(0, 0);
      })
      .catch(function () {
        main.innerHTML = '<div class="page"><h1>Could not load this lesson</h1>' +
          '<p>Expected <code>' + esc(lesson.path) + '</code>. If you opened <code>index.html</code> directly from disk, ' +
          'the browser blocks local file reads — start the local server instead:</p>' +
          '<pre><code>./serve.sh</code></pre></div>';
      });
  }

  function wireLesson(lesson) {
    // Checkbox persistence for checkpoints and exercise task lists.
    var boxes = main.querySelectorAll('.prose input[type="checkbox"]');
    boxes.forEach(function (box, n) {
      var key = lesson.id + '::' + n;
      box.disabled = false;
      box.checked = !!checks[key];
      box.closest('li') && box.closest('li').classList.toggle('checked', box.checked);
      box.addEventListener('change', function () {
        checks[key] = box.checked;
        if (!box.checked) delete checks[key];
        save(KEY.checks, checks);
        box.closest('li') && box.closest('li').classList.toggle('checked', box.checked);
      });
    });

    main.querySelectorAll('[data-copy]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var code = btn.closest('figure').querySelector('code').innerText;
        navigator.clipboard.writeText(code).then(function () {
          btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1200);
        });
      });
    });

    main.querySelectorAll('details.cx').forEach(function (d) {
      d.addEventListener('toggle', function () {
        var t = d.querySelector('.cx-toggle');
        if (t) t.textContent = d.open ? 'hide' : 'show';
      });
    });

    var btn = document.getElementById('complete-btn');
    function paint() {
      btn.textContent = isDone(lesson.id) ? '✓ Completed — click to undo' : 'Mark lesson complete';
      btn.classList.toggle('is-done', isDone(lesson.id));
    }
    btn.addEventListener('click', function () { setDone(lesson.id, !isDone(lesson.id)); paint(); renderSidebar(lesson.id); });
    paint();
  }

  function view404(id) {
    main.innerHTML = '<div class="page"><h1>Not found</h1><p><code>' + esc(id || '') +
      '</code> is not a lesson in this course.</p><p><a href="#/">Back to the start</a></p></div>';
  }

  /* ---------- search --------------------------------------------------- */
  var modal = document.getElementById('search-modal');
  var input = document.getElementById('search-input');
  var results = document.getElementById('search-results');
  var cursor = 0, hits = [];

  function openSearch() {
    modal.hidden = false; input.value = ''; results.innerHTML = ''; input.focus();
    if (!searchDocs) fetch('content/search.json').then(function (r) { return r.json(); })
      .then(function (d) { searchDocs = d; runSearch(); });
  }
  function closeSearch() { modal.hidden = true; }

  function runSearch() {
    var q = input.value.trim().toLowerCase();
    if (!q || !searchDocs) { results.innerHTML = ''; hits = []; return; }
    var terms = q.split(/\s+/);
    hits = searchDocs.map(function (d) {
      var title = d.t.toLowerCase(), body = d.b.toLowerCase(), heads = d.h.join(' ').toLowerCase();
      var score = 0, snippet = '';
      terms.forEach(function (term) {
        if (title.indexOf(term) > -1) score += 12;
        if (heads.indexOf(term) > -1) score += 5;
        if (d.s.toLowerCase().indexOf(term) > -1) score += 4;
        var at = body.indexOf(term);
        if (at > -1) { score += 1; if (!snippet) snippet = d.b.slice(Math.max(0, at - 60), at + 90); }
      });
      return { d: d, score: score, snippet: snippet };
    }).filter(function (r) { return r.score > 0; })
      .sort(function (a, b) { return b.score - a.score; }).slice(0, 12);

    cursor = 0;
    results.innerHTML = hits.length ? hits.map(function (r, i) {
      return '<a class="sr' + (i === 0 ? ' sel' : '') + '" href="#/' + r.d.id + '">' +
        '<span class="sr-phase">' + esc(r.d.p) + '</span>' +
        '<strong>' + esc(r.d.t) + '</strong>' +
        '<span class="sr-snip">' + esc(r.snippet || r.d.s) + '</span></a>';
    }).join('') : '<p class="sr-empty">No matches for “' + esc(input.value) + '”.</p>';
  }

  function moveCursor(delta) {
    var els = results.querySelectorAll('.sr');
    if (!els.length) return;
    els[cursor] && els[cursor].classList.remove('sel');
    cursor = (cursor + delta + els.length) % els.length;
    els[cursor].classList.add('sel');
    els[cursor].scrollIntoView({ block: 'nearest' });
  }

  input.addEventListener('input', runSearch);
  document.getElementById('search-trigger').addEventListener('click', openSearch);
  modal.addEventListener('click', function (e) { if (e.target === modal) closeSearch(); });
  results.addEventListener('click', function (e) { if (e.target.closest('.sr')) closeSearch(); });

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); return; }
    if (modal.hidden) {
      if (e.key === '/' && !/input|textarea/i.test(document.activeElement.tagName)) { e.preventDefault(); openSearch(); }
      return;
    }
    if (e.key === 'Escape') closeSearch();
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveCursor(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveCursor(-1); }
    else if (e.key === 'Enter') { var el = results.querySelectorAll('.sr')[cursor]; if (el) { location.hash = el.getAttribute('href'); closeSearch(); } }
  });

  /* ---------- mobile nav ----------------------------------------------- */
  var sidebar = document.getElementById('sidebar'), scrim = document.getElementById('scrim');
  function toggleNav(on) {
    sidebar.classList.toggle('open', on);
    scrim.classList.toggle('show', on);
  }
  document.getElementById('menu-btn').addEventListener('click', function () { toggleNav(!sidebar.classList.contains('open')); });
  scrim.addEventListener('click', function () { toggleNav(false); });

  /* ---------- router --------------------------------------------------- */
  function route() {
    var path = location.hash.replace(/^#\/?/, '').split('#')[0];
    toggleNav(false);
    if (!path) { renderSidebar(null); return viewHome(); }
    if (path === 'roadmap') { renderSidebar(null); return viewRoadmap(); }
    if (path === 'project') { renderSidebar(null); return viewProject(); }
    viewLesson(path);
  }

  Promise.all([
    fetch('content/index.json').then(function (r) { return r.json(); }),
    fetch('content/project.json').then(function (r) { return r.json(); })
  ]).then(function (data) {
    index = data[0]; project = data[1];
    index.phases.forEach(function (p) { p.lessons.forEach(function (l) { flat.push(l); }); });
    window.addEventListener('hashchange', route);
    route();
  }).catch(function () {
    main.innerHTML = '<div class="page"><h1>Content index missing</h1>' +
      '<p>Run the build script, then start the server:</p><pre><code>python3 tools/build.py\n./serve.sh</code></pre>' +
      '<p>If you opened this file directly from disk, the browser will not allow it to read local content — use the server.</p></div>';
  });
})();
