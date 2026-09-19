/* Lesson renderer: markdown + the ::: block syntax the curriculum is written in. */
(function (global) {
  'use strict';

  // kind -> { label, collapsible }.  Collapsible blocks stay shut until the
  // learner opens them, which is the whole point of "don't give the answer away".
  var KINDS = {
    exercise:   { label: 'Your turn',    collapsible: false },
    challenge:  { label: 'Challenge',    collapsible: false },
    project:    { label: 'Apply it to the project', collapsible: false },
    checkpoint: { label: 'Checkpoint',   collapsible: false },
    stop:       { label: 'Stop',         collapsible: false },
    mistake:    { label: 'Common mistakes', collapsible: false },
    debug:      { label: 'Debug this',   collapsible: false },
    predict:    { label: 'Predict the output', collapsible: false },
    refactor:   { label: 'Refactor',     collapsible: false },
    design:     { label: 'Design decision', collapsible: false },
    why:        { label: 'Why it matters', collapsible: false },
    note:       { label: 'Note',         collapsible: false },
    warn:       { label: 'Watch out',    collapsible: false },
    recap:      { label: 'Recap',        collapsible: false },
    hint:       { label: 'Hint',         collapsible: true },
    solution:   { label: 'Solution',     collapsible: true },
    interview:  { label: 'Interview question', collapsible: true }
  };

  var OPEN = /^:::[ \t]*([a-z][a-z-]*)[ \t]*(.*)$/;
  var CLOSE = /^:::[ \t]*$/;
  var FENCE = /^(```|~~~)/;

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function slugify(s) {
    return String(s).toLowerCase().replace(/<[^>]+>/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  /* --- marked configuration ------------------------------------------- */
  var renderer = new marked.Renderer();

  renderer.code = function (code, infostring) {
    if (code && typeof code === 'object') { infostring = code.lang; code = code.text; }
    var lang = (infostring || '').trim().split(/\s+/)[0].toLowerCase();
    var alias = { cs: 'csharp', 'c#': 'csharp', sh: 'bash', shell: 'bash', console: 'bash', text: 'plaintext', csproj: 'xml' };
    lang = alias[lang] || lang;
    var body;
    if (lang && hljs.getLanguage(lang)) {
      body = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } else {
      body = esc(code);
    }
    return '<figure class="code">' +
      '<figcaption><span class="code-lang">' + esc(lang || 'text') + '</span>' +
      '<button class="copy-btn" type="button" data-copy>Copy</button></figcaption>' +
      '<pre><code class="hljs">' + body + '</code></pre></figure>';
  };

  renderer.heading = function (text, level) {
    if (text && typeof text === 'object') { level = text.depth; text = this.parser.parseInline(text.tokens); }
    var id = slugify(text);
    return '<h' + level + ' id="' + id + '"><a class="anchor" href="#' + id + '" aria-hidden="true">#</a>' +
      text + '</h' + level + '>';
  };

  marked.setOptions({ renderer: renderer, gfm: true, breaks: false, headerIds: false, mangle: false });

  function md(text) {
    return marked.parse(text.trim() ? text : '');
  }

  /* --- ::: block parser ------------------------------------------------ */
  function parse(source) {
    var lines = source.split('\n');
    var nodes = [];
    var buf = [];
    var current = null;      // { kind, title, lines }
    var fence = null;

    function flushMarkdown() {
      if (buf.join('').trim()) nodes.push({ type: 'md', text: buf.join('\n') });
      buf = [];
    }
    function closeBlock() {
      if (current) { nodes.push(current); current = null; }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var f = line.match(FENCE);

      if (fence) {                                  // inside a code fence: copy verbatim
        (current ? current.lines : buf).push(line);
        if (f && line.trim().indexOf(fence) === 0) fence = null;
        continue;
      }
      if (f) {
        fence = f[1];
        (current ? current.lines : buf).push(line);
        continue;
      }
      if (CLOSE.test(line)) {
        if (current) closeBlock(); 
        continue;
      }
      var m = line.match(OPEN);
      if (m && KINDS[m[1]]) {
        if (current) closeBlock();                  // blocks are flat, never nested
        else flushMarkdown();
        current = { type: 'block', kind: m[1], title: m[2].trim(), lines: [] };
        continue;
      }
      (current ? current.lines : buf).push(line);
    }
    closeBlock();
    flushMarkdown();
    return nodes;
  }

  function renderBlock(node) {
    var meta = KINDS[node.kind];
    var body = '<div class="cx-body">' + md(node.lines.join('\n')) + '</div>';
    var title = node.title ? '<span class="cx-title">' + esc(node.title) + '</span>' : '';

    if (meta.collapsible) {
      return '<details class="cx cx-' + node.kind + '">' +
        '<summary><span class="cx-kind">' + meta.label + '</span>' + title +
        '<span class="cx-toggle">show</span></summary>' + body + '</details>';
    }
    return '<section class="cx cx-' + node.kind + '">' +
      '<header class="cx-head"><span class="cx-kind">' + meta.label + '</span>' + title + '</header>' +
      body + '</section>';
  }

  function render(source) {
    return parse(source).map(function (n) {
      return n.type === 'md' ? md(n.text) : renderBlock(n);
    }).join('\n');
  }

  global.LessonRender = { render: render, slugify: slugify, escape: esc, KINDS: KINDS };
})(window);
