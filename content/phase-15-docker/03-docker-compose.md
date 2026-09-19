---
title: Docker Compose
summary: Running the whole stack with one command — and making the pieces start in the right order.
minutes: 35
stage: Stage 8
---

## What are we learning?

Compose for local development and small deployments: service dependencies, health conditions, profiles and overrides.

## The full stack

```yaml
name: taskflow

services:
  api:
    build:
      context: .
      dockerfile: src/TaskFlow.Api/Dockerfile
      args:
        VERSION: ${VERSION:-1.0.0}
    image: taskflow-api:${VERSION:-latest}
    restart: unless-stopped
    ports:
      - "5080:8080"
    environment:
      ASPNETCORE_ENVIRONMENT: ${ENVIRONMENT:-Development}
      ASPNETCORE_URLS: http://+:8080
      ConnectionStrings__Default: Host=db;Port=5432;Database=taskflow;Username=taskflow;Password=${DB_PASSWORD:?DB_PASSWORD is required}
      Redis__Configuration: cache:6379
      Jwt__SigningKey: ${JWT_SIGNING_KEY:?JWT_SIGNING_KEY is required}
      OTEL_EXPORTER_OTLP_ENDPOINT: http://otel:4317
    depends_on:
      db:    { condition: service_healthy }
      cache: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8080/health/live"]
      interval: 30s
      timeout: 3s
      start_period: 15s
      retries: 3
    deploy:
      resources:
        limits: { memory: 512M, cpus: "1.0" }

  db:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: taskflow
      POSTGRES_PASSWORD: ${DB_PASSWORD:?DB_PASSWORD is required}
      POSTGRES_DB: taskflow
    ports:
      - "127.0.0.1:5432:5432"        # host loopback only
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U taskflow -d taskflow"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 10s

  cache:
    image: redis:7-alpine
    restart: unless-stopped
    command: redis-server --save 60 1 --loglevel warning
    volumes:
      - cache-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      retries: 5

  migrate:
    build:
      context: .
      dockerfile: src/TaskFlow.Api/Dockerfile
      target: build
    command: ["dotnet", "ef", "database", "update", "-p", "src/TaskFlow.Infrastructure", "-s", "src/TaskFlow.Api"]
    environment:
      ConnectionStrings__Default: Host=db;Port=5432;Database=taskflow;Username=taskflow;Password=${DB_PASSWORD}
    depends_on:
      db: { condition: service_healthy }
    restart: "no"
    profiles: [tools]

volumes:
  db-data:
  cache-data:
```

## Start order

::: warn `depends_on` alone does not wait for readiness
```yaml
depends_on:
  - db                       # ❌ waits only for the CONTAINER to start
```
PostgreSQL's container starts in about 100ms and accepts connections a few seconds later. Your API starts, tries to connect, fails, and — with `restart: unless-stopped` — restarts in a loop until the database happens to be ready. It usually works, sometimes does not, and on a slow CI machine it fails consistently.

```yaml
depends_on:
  db: { condition: service_healthy }     # ✅ waits for the HEALTHCHECK to pass
```

That requires the dependency to declare a `healthcheck`. `pg_isready` for PostgreSQL, `redis-cli ping` for Redis.

And even then, your application should still retry its first connection — Compose start order does not help in Kubernetes, where there is no such guarantee at all. `EnableRetryOnFailure` from Phase 7 covers this.
:::

## Required variables

```yaml
DB_PASSWORD: ${DB_PASSWORD:?DB_PASSWORD is required}
ENVIRONMENT: ${ENVIRONMENT:-Development}
```

`:?message` fails fast with a clear error if the variable is missing. `:-default` supplies a fallback. Using `:?` for every secret means a missing one is a startup error, not an application that runs with an empty password and fails mysteriously.

`.env` beside `docker-compose.yml` is read automatically:

```bash
# .env — GITIGNORED
DB_PASSWORD=devpassword
JWT_SIGNING_KEY=a-development-key-at-least-32-characters-long
```

```bash
# .env.example — COMMITTED
DB_PASSWORD=
JWT_SIGNING_KEY=
```

Commit the example, ignore the real one. It is the cheapest onboarding documentation there is.

## Overrides

```yaml
# docker-compose.override.yml — applied automatically, development only
services:
  api:
    build:
      target: build                     # the SDK stage, so dotnet watch is available
    command: ["dotnet", "watch", "run", "--project", "src/TaskFlow.Api", "--urls", "http://+:8080"]
    volumes:
      - ./src:/src/src:cached           # live source
      - ~/.nuget/packages:/root/.nuget/packages:ro
    environment:
      ASPNETCORE_ENVIRONMENT: Development
      DOTNET_USE_POLLING_FILE_WATCHER: "true"     # needed for bind mounts on macOS/Windows
```

```bash
docker compose up                                        # base + override (dev)
docker compose -f docker-compose.yml up                  # base only (production-like)
docker compose -f docker-compose.yml -f docker-compose.prod.yml up   # explicit production
```

`docker-compose.override.yml` is applied automatically, which is exactly what you want for development and exactly what you must avoid in production — hence the explicit `-f` for production.

## Profiles

```yaml
services:
  seq:
    image: datalust/seq
    profiles: [observability]
  otel:
    image: otel/opentelemetry-collector-contrib
    profiles: [observability]
  migrate:
    profiles: [tools]
```

```bash
docker compose up                                    # core services only
docker compose --profile observability up            # plus logging and tracing
docker compose --profile tools run --rm migrate      # one-off
```

Profiles keep the default `up` fast while making the full stack one flag away.

## The commands

```bash
docker compose up -d
docker compose up --build              # rebuild changed images
docker compose ps
docker compose logs -f api
docker compose logs --tail=100 api db
docker compose exec api /bin/sh
docker compose exec db psql -U taskflow
docker compose restart api
docker compose down                    # stop and remove containers
docker compose down -v                 # ...and DELETE VOLUMES
docker compose config                  # the fully resolved configuration
docker compose watch                   # sync files and rebuild on change (Compose v2.22+)
```

`docker compose config` is the debugging tool: it prints the merged, variable-substituted result of every file, which answers "why is it using that value".

::: exercise Level 1 — Guided · The whole stack
1. Write the compose file above with your own service names.
2. Create `.env` and `.env.example`; gitignore the first.
3. `docker compose up -d`, then `docker compose ps` — every service healthy.
4. Run migrations with the tools profile.
5. Exercise your `.http` file against `localhost:5080`.
6. `docker compose down` then `up` — confirm data survived.
7. Remove the `service_healthy` conditions and start from scratch several times. Observe the intermittent failures.
8. Put them back. Add the override file and confirm `dotnet watch` reloads on a source change.
:::

::: challenge Level 3 · One command, from nothing
Requirements:

1. `git clone && cp .env.example .env && docker compose up` produces a fully working, seeded TaskFlow with no other steps.
2. Migrations run automatically on first start, and are safe to run again.
3. Development seed data is loaded only if the database is empty.
4. The API waits for the database and for migrations, and never crash-loops.
5. `--profile observability` adds Seq, Prometheus and Grafana with a working dashboard.
6. `docker compose down && docker compose up` preserves data.
7. A `docker compose --profile test run --rm tests` target running the whole suite against the real stack.
8. A README section a new developer can follow in under five minutes.

Requirement 4 is the interesting one, because you cannot express "wait for migrations" with `depends_on` alone.
:::

::: solution
Requirement 4 uses `service_completed_successfully`, which is the condition people do not know exists:

```yaml
services:
  migrate:
    build: { context: ., dockerfile: src/TaskFlow.Api/Dockerfile, target: build }
    command: ["/bin/sh", "-c", "dotnet ef database update -p src/TaskFlow.Infrastructure -s src/TaskFlow.Api"]
    depends_on:
      db: { condition: service_healthy }
    restart: "no"

  api:
    depends_on:
      db:      { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
```

The API starts only after the migration container **exits with code 0**. A failed migration means the API never starts — which is correct: an API against a stale schema is worse than an API that did not start.

Requirement 3, conditional seeding, belongs in the application rather than in compose:

```csharp
if (app.Environment.IsDevelopment() && configuration.GetValue<bool>("SeedData"))
{
    await using var scope = app.Services.CreateAsyncScope();
    var db = scope.ServiceProvider.GetRequiredService<TaskFlowDbContext>();
    if (!await db.Users.AnyAsync())          // idempotent: only seeds an empty database
        await SeedData.ApplyAsync(db, CancellationToken.None);
}
```

The `AnyAsync` guard is what makes it safe to leave enabled — running it again after `down`/`up` does nothing, so there is no "did I already seed?" state to track.

Requirement 7:
```yaml
  tests:
    build: { context: ., dockerfile: tests/Dockerfile }
    depends_on:
      db: { condition: service_healthy }
    environment:
      ConnectionStrings__Default: Host=db;Database=taskflow_test;Username=taskflow;Password=${DB_PASSWORD}
    profiles: [test]
```
```bash
docker compose --profile test run --rm tests
```
Note the separate `taskflow_test` database: running the suite must not truncate your development data, and Phase 10's truncation strategy would do exactly that.

**The README section is the actual deliverable**, and it should be this short:

```markdown
## Running locally

    git clone https://github.com/you/taskflow
    cd taskflow
    cp .env.example .env        # fill in DB_PASSWORD and JWT_SIGNING_KEY
    docker compose up

The API is at http://localhost:5080, OpenAPI at /scalar/v1.
Sample data is seeded automatically in Development.

    docker compose --profile observability up   # + Seq, Prometheus, Grafana
    docker compose --profile test run --rm tests
```

A project a new developer can run in five minutes is a project they will contribute to. One that needs a wiki page of setup steps is one they will avoid, and the difference is almost entirely this file.
:::

::: project TaskFlow in Compose
1. The full stack: api, db, cache, migrate.
2. Health checks and correct `depends_on` conditions everywhere.
3. `.env.example` committed; `.env` ignored; required variables using `:?`.
4. An override file for development with `dotnet watch`.
5. Profiles for observability, tools and tests.
6. Migrations gated with `service_completed_successfully`.
7. Idempotent development seeding.
8. The five-minute README section.
9. Test it from a completely clean clone on a machine with nothing but Docker.

Commit.
:::

::: interview How do you run a multi-service application locally?
Docker Compose. Each service — the API, PostgreSQL, Redis — is a service in the compose file, on a shared network where they resolve each other by service name, with named volumes for anything that must persist.

The detail that matters is start order. `depends_on` by itself only waits for a container to start, not for it to be ready, so the API tries to connect before PostgreSQL is accepting connections and crash-loops. `condition: service_healthy` with a real health check — `pg_isready` — fixes that, and `condition: service_completed_successfully` lets you gate the API on a migration container exiting cleanly.

Beyond that: an `.env.example` committed and `.env` ignored, with `${VAR:?message}` so a missing secret is a clear startup error; an override file for development with `dotnet watch` and a bind-mounted source; and profiles so the default `up` is fast while observability tooling and the test runner are one flag away.

The goal is that a new developer can clone, copy the env file and run one command.
:::

::: checkpoint
- [ ] `docker compose up` gives me a working stack from nothing
- [ ] Migrations run automatically and the API waits for them
- [ ] I saw the intermittent failures caused by omitting health conditions
- [ ] `docker compose down && up` preserves my data
- [ ] `.env` is ignored and `.env.example` is committed
- [ ] The README section takes under five minutes to follow
:::

## Common mistakes

::: mistake
**`depends_on` without a condition.** Intermittent startup failures, worse on slow machines.

**Committing `.env`.** Secrets in git.

**No `.env.example`.** Every new developer has to ask which variables exist.

**`docker-compose.override.yml` reaching production.** Development settings, bind mounts and `dotnet watch` in a live environment.

**Running tests against the development database.** Truncation deletes your data.
:::
