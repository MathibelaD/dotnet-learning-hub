---
title: "Checkpoint: TaskFlow on PostgreSQL"
summary: Stage 4 complete — the API runs on a real relational database with migrations, relationships and measured performance.
minutes: 90
stage: Stage 4
---

## What are we learning?

Nothing new. **Stage 4** of the project, complete.

::: stop
Your API must behave identically to Stage 3 from the outside. That is the test: the storage changed, the contract did not.
:::

## The deliverable

### Schema
- `users`, `projects`, `tasks`, `comments`, `labels`, `task_labels`, `outbox_messages`
- snake_case naming throughout
- Enums stored as strings
- `text[]` for anything array-shaped that PostgreSQL handles natively
- Deliberate `ON DELETE` behaviour on every foreign key
- Indexes justified by `EXPLAIN` output
- `xmin` as the concurrency token
- Soft delete via a global query filter, documented

### Migrations
- An initial migration plus at least three incremental ones
- Every migration read before committing
- Reference data seeded with `HasData` and stable Guids
- Development sample data seeded separately, idempotently
- An idempotent script generated in CI and committed
- No auto-migration in Production

### Queries
- `NoTracking` by default
- Every read endpoint a projection, no `Include` + map
- Filters as `Expression<Func<T, bool>>`
- Search fully translated to SQL, verified with `ToQueryString()`
- Two queries per page (count + page), three with facets
- Query budgets asserted in tests

### Writes
- One `SaveChanges` per operation
- Domain methods still enforce every rule — `ExecuteUpdate` used only for genuine bulk maintenance
- Outbox rows written in the same transaction as the data
- `ETag`/`If-Match` concurrency on updates

## Checkpoint

::: checkpoint
- [ ] `docker compose up -d db && dotnet ef database update` produces a working schema from nothing
- [ ] Every endpoint from the Stage 3 `.http` file returns the same shape as before
- [ ] No endpoint issues more than three queries — asserted by a test
- [ ] Search over 100,000 tasks returns in under 100ms
- [ ] Two concurrent edits to the same field produce a 409, not a lost update
- [ ] The domain project still references nothing
- [ ] No domain rule can be bypassed through the database layer
- [ ] I read every migration before committing it
- [ ] Every index has recorded `EXPLAIN` justification
:::

::: project Finish Stage 4
```bash
cd ~/taskflow
docker compose up -d db
./scripts/migrate.sh
dotnet run --project src/TaskFlow.Api
```

Then the acceptance test — from a completely clean state:

```bash
docker compose down -v          # destroys the volume
docker compose up -d db
./scripts/migrate.sh
dotnet run --project src/TaskFlow.Api &
sleep 3
# run your whole .http file
```

If that sequence works from nothing, your persistence layer is real.

```bash
git commit -am "Stage 4 complete: TaskFlow on PostgreSQL with EF Core"
git tag stage-4
```
:::

::: solution What "done" looks like, and the traps that remain
**The in-memory store still exists and still passes.** Do not delete it. It is your fast test double in Phase 10, and keeping both working is continuous proof that no EF Core concern leaked into your application layer.

**Ordering is now load-bearing.** In-memory `Dictionary.Values` appeared stable; SQL without `ORDER BY` is genuinely not. Every list endpoint needs an explicit, unique ordering. If a test passes in-memory and fails on PostgreSQL intermittently, this is the first thing to check.

**String comparison changed meaning.** `StringComparer.OrdinalIgnoreCase` in memory became `ILIKE` or a `citext` column in SQL — and PostgreSQL's collation rules are not identical to .NET's ordinal rules for non-ASCII text. For ASCII labels this never matters; for user-supplied text in other scripts it can.

**`DateTime` versus `DateTimeOffset`.** Npgsql maps `DateTime` with `Kind.Utc` to `timestamptz` and `Kind.Unspecified` to `timestamp`, and mixing them throws at runtime with a message that is clear once you have seen it and baffling the first time. Use `DateTimeOffset` throughout, or be strict about always using UTC `DateTime`. Decide once and enforce it in the model configuration.

**Guid generation moved conceptually but not actually.** Your entities still generate their own ids in the constructor. That is deliberate: you have the id before saving, which makes the outbox and `CreatedAtAction` simple. Using `Guid.CreateVersion7()` keeps them index-friendly.
:::

::: interview Tell me about the persistence layer
> "It is EF Core against PostgreSQL. The domain project has no EF Core reference at all — mapping lives in configuration classes in a separate infrastructure project, which is enforced by an MSBuild target that fails the build if the domain gains a dependency.
>
> Read paths project straight into DTOs rather than loading entities, so there is no N+1 and only the needed columns cross the wire. Write paths load tracked entities so the domain methods run and `SaveChanges` generates minimal updates inside one transaction. Concurrency uses PostgreSQL's `xmin` as the token, surfaced over HTTP as `ETag`/`If-Match` with a 409 carrying the current server state.
>
> Migrations are reviewed as code and applied as an idempotent script in a separate deployment step, not at startup. And there is an integration test asserting a query budget per endpoint, which is what actually stops N+1 from creeping back in."

If you can say that about your own code and answer follow-ups, you are ahead of most candidates for a mid-level .NET role.
:::

::: checkpoint Phase 7 complete
- [ ] Stage 4 is committed and tagged
- [ ] A clean-slate rebuild works
- [ ] I can explain every schema decision
- [ ] I have measured numbers for every performance claim
- [ ] I am ready to add authentication
:::
