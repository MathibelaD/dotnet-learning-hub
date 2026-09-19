# C# &amp; .NET Developer Learning Hub

A hands-on curriculum that takes an experienced programmer from "I know how to code"
to "I can build, secure, test, operate and explain a production .NET service."

It is **not** a documentation site. Every lesson ends with you writing code, and one
application — **TaskFlow**, a task management API — grows across all sixteen phases
from a console app to a containerised ASP.NET Core service on PostgreSQL.

```
104 lessons · 99 exercises · 89 challenges · 103 project steps · ~1,060 code snippets · ~73 hours
```

## Running it

```bash
./serve.sh
```

Then open <http://localhost:4173>.

`serve.sh` regenerates the content index and starts a static server. It needs **Python 3**
and nothing else — no npm install, no build step, no backend. The Markdown renderer and
syntax highlighter are vendored in `assets/vendor/`, so it works offline.

Use a different port with `./serve.sh 8000`.

> Open `index.html` directly from disk and it will not work: browsers block local file
> reads, so the app cannot load its content. Use the server.

## What you get

- **Sidebar navigation** grouped by phase, with per-phase and overall progress
- **Search** across every lesson, heading and code snippet (`⌘K` or `/`)
- **Progress tracking** — completed lessons, checkpoint checkboxes and project stages,
  saved in your browser's `localStorage`. No account, nothing sent anywhere.
- **Collapsed solutions** that stay shut until you open them, because attempting first
  is the entire point
- **Dark and light themes**, and a layout that works on a phone
- **Previous/next navigation**, copy buttons on every code block

## The curriculum

| Phase | | Project stage |
|---|---|---|
| 00 | Orientation — C#, .NET and the ecosystem | Stage 1 |
| 01 | Modern C# foundations | Stage 1 |
| 02 | C# features you actually use | Stage 1 |
| 03 | LINQ | Stage 1 |
| 04 | Async programming | Stage 1 |
| 05 | .NET fundamentals | Stage 2 |
| 06 | ASP.NET Core | Stage 3 |
| 07 | Entity Framework Core | Stage 4 |
| 08 | Application architecture | — |
| 09 | Authentication &amp; security | Stage 5 |
| 10 | Testing | Stage 7 |
| 11 | SOLID &amp; design principles | Stage 6 |
| 12 | Design patterns | Stage 6 |
| 13 | Advanced C# | — |
| 14 | Production .NET | — |
| 15 | Docker &amp; deployment | Stage 8 |
| 16 | Capstone &amp; interview preparation | — |

Every lesson follows the same shape: what we are learning → why it matters → a small
example → **your turn** → a challenge → **apply it to the project** → common mistakes →
a checkpoint → the solution, collapsed.

## The project

You build TaskFlow yourself at `~/taskflow`. What the repo provides is the tedious
supporting configuration — see [project/README.md](project/README.md):

```bash
mkdir -p ~/taskflow && cd ~/taskflow && git init
cp -r <this repo>/project/starter-kit/. .
cp .env.example .env          # fill in DB_PASSWORD
chmod +x scripts/*.sh
docker compose up -d
```

That gives you nullable reference types, warnings-as-errors, the analysers the lessons
rely on, PostgreSQL and Redis in Docker, and wrapper scripts for build and migrations.
Everything else you write.

## Prerequisites

| | Why |
|---|---|
| .NET 10 SDK | The whole course |
| Docker | PostgreSQL from Phase 0, the app from Phase 15 |
| Git | From Phase 0 — every project step ends in a commit |
| An editor | VS Code + C# Dev Kit, Rider, or Visual Studio |
| Python 3 | Only to serve this hub |

Check with `dotnet --version`, `docker --version`, `git --version`.

## Adding or editing lessons

Content is plain Markdown under `content/<phase>/<NN>-<slug>.md`, with front matter:

```markdown
---
title: Classes, objects and constructors
summary: One line, shown in the sidebar and in search results.
minutes: 40
stage: Stage 1
---

## What are we learning?
…
```

Lessons use a small block syntax on top of Markdown:

```markdown
::: exercise Level 1 — Guided · Build TaskItem four ways
Instructions.
:::

::: solution
Stays collapsed until clicked.
:::
```

Available blocks: `exercise`, `challenge`, `project`, `checkpoint`, `stop`, `mistake`,
`debug`, `predict`, `refactor`, `design`, `why`, `note`, `warn`, `recap`, and the
collapsible `hint`, `solution` and `interview`. Blocks do not nest.

Add a file, run `python3 tools/build.py` (or just `./serve.sh`), and it appears.
Phases are directories containing a `_phase.json`.

## Layout

```
index.html              the shell
assets/
  app.js                router, progress, search
  render.js             Markdown + the ::: block syntax
  styles.css            tokens, layout, both themes
  vendor/               marked + highlight.js, vendored for offline use
content/
  phase-NN-*/           _phase.json + lesson Markdown
  project.json          the eight project stages
  index.json            generated — do not edit
  search.json           generated — do not edit
tools/build.py          scans content/, writes the two generated files
project/starter-kit/    build config, compose file and scripts for TaskFlow
serve.sh                build + serve
```

## The rule this was built around

> Do not optimise for reading. Optimise for doing.

Roughly 10% explanation, 20% examples, 70% you writing code. If you are scrolling and
nodding, you are doing it wrong — open a terminal.
