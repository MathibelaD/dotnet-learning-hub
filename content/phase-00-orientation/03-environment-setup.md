---
title: Your environment, from the terminal
summary: SDK, CLI, editor, PostgreSQL and Docker — configured once, used for the whole course.
minutes: 30
stage: Stage 1
---

## What are we learning?

Getting a working .NET development environment and, more importantly, getting comfortable driving it from the **terminal** rather than from an IDE's menus.

::: why
Every .NET tutorial that starts with "right-click the project and select Add → New Item" leaves you helpless the moment you are on a build server, in a container, or in an editor that is not Visual Studio. The `dotnet` CLI is the real interface. IDEs are wrappers around it.

You will also be running `dotnet ef migrations add`, `dotnet test` and `docker compose up` hundreds of times. Learn them now.
:::

## The pieces

| Piece | What it is | Check |
|---|---|---|
| .NET SDK 10 | Compiler + CLI + runtime | `dotnet --version` |
| An editor | VS Code + C# Dev Kit, Rider, or Visual Studio | — |
| Docker | Runs PostgreSQL, and later your app | `docker --version` |
| Git | Version control, used from Phase 1 onward | `git --version` |
| psql (optional) | Talk to PostgreSQL directly | `psql --version` |

## Example — the CLI commands you will use every day

```bash
dotnet new list                  # every available template
dotnet new console -o MyApp      # create a project in ./MyApp
dotnet new sln -n MySolution     # create a solution file
dotnet sln add src/MyApp         # add a project to the solution

dotnet restore                   # download NuGet packages
dotnet build                     # compile
dotnet run                       # build + run
dotnet watch                     # rebuild and rerun on every file save
dotnet test                      # run the test suite
dotnet publish -c Release        # produce deployable output

dotnet add package Serilog       # add a NuGet dependency
dotnet list package              # show what this project depends on
```

`dotnet watch` is the one people discover too late. Use it constantly.

::: exercise Level 1 — Guided · Verify and explore
Run each of these and read the output rather than skimming it.

```bash
dotnet --version
dotnet --list-sdks
dotnet --list-runtimes
docker --version
git --version
```

Now explore the templates:

```bash
dotnet new list | head -30
```

You will recognise `console`, `classlib`, `webapi`, `xunit` and `gitignore`. Those five cover almost everything you will create in this course.

Finally, try the feedback loop you will use most:

```bash
cd ~/dotnet-scratch/hello
dotnet watch
```

Leave it running. Edit `Program.cs`, save, and watch the terminal rerun automatically. Press `Ctrl+C` to stop.
:::

## Editor setup

Whatever you choose, make sure you have these three things working, because you will lean on them constantly:

1. **Go to definition** (`F12`) — jump into a type to read its real signature
2. **Inline error squiggles with error codes** — the codes are searchable
3. **A terminal inside the editor** — so you are never alt-tabbing

For VS Code: install the **C# Dev Kit** extension. For a full IDE: **Rider** or **Visual Studio**.

::: note On AI autocomplete
Turn inline AI completion **off** for at least the first four phases. It will write the code for you before you have formed the muscle memory, and you will reach Phase 6 unable to write a class from a blank file. Turn it back on once you can.
:::

## PostgreSQL with Docker

From Phase 7 you need a database. You do not need to install PostgreSQL on your machine — run it in a container, which is closer to how it will run in production anyway.

```bash
docker run --name taskflow-db \
  -e POSTGRES_PASSWORD=devpassword \
  -e POSTGRES_USER=taskflow \
  -e POSTGRES_DB=taskflow \
  -p 5432:5432 \
  -d postgres:17
```

Verify:

```bash
docker ps                          # is it running?
docker logs taskflow-db | tail -5  # did it start cleanly?
psql -h localhost -U taskflow -d taskflow -c '\dt'   # connect (password: devpassword)
```

Stop and start it later with `docker stop taskflow-db` and `docker start taskflow-db`. The data survives restarts because the container keeps its filesystem; it disappears if you `docker rm` the container. We fix that properly with volumes in Phase 15.

::: exercise Level 2 — Independent · Make the database yours
Requirements, not instructions:

1. Start a PostgreSQL 17 container named `taskflow-db` with user `taskflow`, password `devpassword`, database `taskflow`, on port 5432.
2. Connect to it and create a table called `ping` with a single `text` column.
3. Insert a row, select it back, then drop the table.
4. Stop the container. Start it again. Confirm it still runs.

You may look up `psql` syntax — knowing where to find syntax is a real skill. You may not look up the docker command if you just read it above.
:::

::: solution
```bash
docker run --name taskflow-db -e POSTGRES_PASSWORD=devpassword \
  -e POSTGRES_USER=taskflow -e POSTGRES_DB=taskflow -p 5432:5432 -d postgres:17

PGPASSWORD=devpassword psql -h localhost -U taskflow -d taskflow <<'SQL'
CREATE TABLE ping (note text);
INSERT INTO ping VALUES ('it works');
SELECT * FROM ping;
DROP TABLE ping;
SQL

docker stop taskflow-db && docker start taskflow-db && docker ps
```

If `psql` is not installed locally, go through the container instead:

```bash
docker exec -it taskflow-db psql -U taskflow -d taskflow
```

That second form is worth remembering — it works on any machine with Docker, no local client needed.
:::

::: challenge Port already in use
Try starting a *second* PostgreSQL container on port 5432 while the first is running. Read the error carefully.

Then start it successfully on a different host port, and connect to that one. What exactly does `-p 5433:5432` mean, and which number goes where?
:::

::: solution
```bash
docker run --name taskflow-db-2 -e POSTGRES_PASSWORD=x -p 5433:5432 -d postgres:17
PGPASSWORD=x psql -h localhost -p 5433 -U postgres -c 'select version();'
```

`-p HOST:CONTAINER`. The left number is the port on your machine; the right is the port inside the container, which PostgreSQL always listens on as 5432. Two containers can both listen on 5432 internally because each has its own network namespace — they only collide when mapped to the same host port.

Clean up: `docker rm -f taskflow-db-2`.
:::

::: project Add a compose file to TaskFlow
You will not run raw `docker run` commands for the rest of the course. Put the database in a compose file now.

Create `~/taskflow/docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:17
    container_name: taskflow-db
    environment:
      POSTGRES_USER: taskflow
      POSTGRES_PASSWORD: devpassword
      POSTGRES_DB: taskflow
    ports:
      - "5432:5432"
    volumes:
      - taskflow-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U taskflow"]
      interval: 5s
      retries: 5

volumes:
  taskflow-data:
```

Then:

```bash
cd ~/taskflow
docker rm -f taskflow-db 2>/dev/null   # remove the hand-started one
docker compose up -d
docker compose ps
git add docker-compose.yml && git commit -m "Stage 1: postgres via docker compose"
```

The `volumes:` entry is the difference between "my data vanished" and "my data is still there". We come back to it in Phase 15.
:::

::: checkpoint
- [ ] `dotnet --version` reports 10.x
- [ ] I have used `dotnet watch` and seen it reload
- [ ] Docker is running and `docker compose ps` shows my database as healthy
- [ ] I connected to PostgreSQL and ran a query
- [ ] AI inline autocomplete is off for now
- [ ] `docker-compose.yml` is committed to the TaskFlow repo
:::

## Common mistakes

::: mistake
**Installing only the ASP.NET Core runtime.** `dotnet --list-sdks` prints nothing, and every `dotnet new` fails with "command not found" or "no SDKs were found". Install the SDK.

**Forgetting Docker Desktop is not running.** Every docker command hangs or reports `Cannot connect to the Docker daemon`. Start Docker Desktop first.

**Using `localhost` inside a container to reach another container.** Inside a container, `localhost` is that container. Containers reach each other by service name on the compose network — `db`, not `localhost`. This will bite you in Phase 15, and it bites everyone once.

**Committing `bin/` and `obj/`.** Run `dotnet new gitignore` in every new repository, first thing.
:::
