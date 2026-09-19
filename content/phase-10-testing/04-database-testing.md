---
title: Database testing with Testcontainers
summary: Testing against a real PostgreSQL, automatically, in CI — and why the in-memory provider is a trap.
minutes: 35
---

## What are we learning?

Running a real database in tests, and why the alternatives produce tests that pass while production breaks.

## The three options

| | In-memory provider | SQLite in-memory | Real PostgreSQL |
|---|---|---|---|
| Speed | Fastest | Fast | Fast enough |
| Setup | None | None | Docker |
| Actual SQL | **None** | SQLite dialect | **Yours** |
| Constraints and FKs | **Ignored** | Partial | Enforced |
| Concurrency tokens | **No** | No | Yes |
| `text[]`, `jsonb`, `ILIKE` | **No** | No | Yes |
| Raw SQL | **Fails** | Different dialect | Works |
| Case sensitivity | .NET semantics | SQLite semantics | PostgreSQL semantics |

::: warn The in-memory provider is not a database
`Microsoft.EntityFrameworkCore.InMemory` is a LINQ-to-Objects store wearing a `DbContext`. It:
- ignores unique constraints, foreign keys and check constraints
- cannot execute raw SQL
- does not support transactions meaningfully
- has no concurrency tokens
- uses .NET string comparison rules, not PostgreSQL's
- silently succeeds on queries PostgreSQL could never translate

So a test can pass while the production query throws "could not be translated", or while a duplicate email is inserted that the real unique index would reject.

**Microsoft's own documentation now recommends against it for testing.** It exists for prototyping. If you find it in a codebase, the database tests are not testing the database.
:::

## Testcontainers

```bash
dotnet add tests/TaskFlow.Integration.Tests package Testcontainers.PostgreSql
```

```csharp
public sealed class PostgresFixture : IAsyncLifetime
{
    private readonly PostgreSqlContainer _container = new PostgreSqlBuilder()
        .WithImage("postgres:17-alpine")
        .WithDatabase("taskflow_test")
        .WithUsername("test")
        .WithPassword("test")
        .WithCleanUp(true)
        .Build();

    public string ConnectionString => _container.GetConnectionString();

    public async ValueTask InitializeAsync()
    {
        await _container.StartAsync();

        var options = new DbContextOptionsBuilder<TaskFlowDbContext>()
            .UseNpgsql(ConnectionString).Options;
        await using var db = new TaskFlowDbContext(options);
        await db.Database.MigrateAsync();          // your REAL migrations
    }

    public ValueTask DisposeAsync() => _container.DisposeAsync();
}
```

The container starts when the test run begins and is destroyed at the end. No manual setup, nothing left behind, and it works identically on a laptop and in CI.

Running your **real migrations** against it is a bonus test: if a migration is broken, the test run fails before any test does.

## Sharing the container

Starting a container per test class costs 2–3 seconds each. Share one across the whole assembly:

```csharp
[CollectionDefinition("Database")]
public sealed class DatabaseCollection : ICollectionFixture<PostgresFixture>;

[Collection("Database")]
public sealed class TaskRepositoryTests(PostgresFixture fixture) : IAsyncLifetime
{
    public async ValueTask InitializeAsync() => await fixture.ResetAsync();
    // ...
}
```

One container, truncation between classes. Roughly 3 seconds of startup for the whole suite.

::: note Respawn
`Respawn` is a small library that generates the truncation statements from your schema automatically, in dependency order:

```csharp
_respawner = await Respawner.CreateAsync(connection, new RespawnerOptions
{
    DbAdapter = DbAdapter.Postgres,
    TablesToIgnore = ["__EFMigrationsHistory"]
});
await _respawner.ResetAsync(connection);
```

Worth it once you have more than a handful of tables — you stop having to update a hard-coded `TRUNCATE` list every time you add one.
:::

## What to test against a real database

These are exactly the things the fakes from lesson 2 cannot verify:

```csharp
[Fact]
public async Task A_duplicate_email_is_rejected_by_the_unique_index()
{
    await repository.AddAsync(User.Register("sam@example.com", ...), default);
    await uow.SaveChangesAsync(default);

    await repository.AddAsync(User.Register("SAM@Example.com", ...), default);   // different casing

    await Should.ThrowAsync<DbUpdateException>(() => uow.SaveChangesAsync(default));
}

[Fact]
public async Task Deleting_a_project_cascades_to_its_tasks()
{
    // ... seed a project with three tasks
    db.Projects.Remove(project);
    await db.SaveChangesAsync(default);

    (await db.Tasks.CountAsync()).ShouldBe(0);
}

[Fact]
public async Task Concurrent_updates_produce_a_concurrency_exception()
{
    await using var contextA = NewContext();
    await using var contextB = NewContext();

    var a = await contextA.Tasks.FirstAsync(t => t.Id == id);
    var b = await contextB.Tasks.FirstAsync(t => t.Id == id);

    a.Rename("from A");
    await contextA.SaveChangesAsync();

    b.Rename("from B");
    await Should.ThrowAsync<DbUpdateConcurrencyException>(() => contextB.SaveChangesAsync());
}

[Fact]
public async Task Search_translates_entirely_to_SQL()
{
    var sql = repository.BuildSearchQuery(new TaskQuery { Text = "bug", Overdue = true }).ToQueryString();

    sql.ShouldContain("ILIKE");
    sql.ShouldContain("WHERE");
    sql.ShouldNotContain("SELECT *");     // we project
}

[Fact]
public async Task The_label_array_column_supports_containment_queries()
{
    var results = await repository.FindByLabelsAsync(["bug", "auth"], default);
    results.ShouldAllBe(t => t.Labels.Contains("bug") && t.Labels.Contains("auth"));
}
```

Every one of these passes trivially against the in-memory provider and tells you nothing.

## Keeping it fast

```csharp
// xUnit v3: assembly-level parallelism is on by default
// tests in DIFFERENT collections run in parallel; within a collection, sequentially

[Collection("Database")]      // shares the container, runs sequentially
[Collection("Database2")]     // a second container, runs in parallel with the first
```

Two or three containers with tests split across them roughly halves a large suite's wall-clock time. Measure before adding complexity.

In CI, the container image should be cached:

```yaml
# GitHub Actions
- run: docker pull postgres:17-alpine     # warms the layer cache
```

::: exercise Level 1 — Guided · Real database tests
1. Add `Testcontainers.PostgreSql` and build `PostgresFixture`.
2. Run your real migrations in `InitializeAsync`.
3. Share the container with a collection fixture.
4. Reset with truncation (or Respawn) between classes.
5. Write the five tests above.
6. Now swap to the in-memory provider and re-run them. Note which pass that should not.
7. Swap back. Record the observation in `DECISIONS.md`.
8. Time the full suite.
:::

::: challenge Level 3 · The persistence contract
Requirements:

1. Every EF Core repository method is tested against real PostgreSQL.
2. The contract test suite from Phase 8 runs against **both** the fake and the EF Core implementation.
3. Any behaviour the fake cannot reproduce is explicitly documented and skipped with a reason, not silently omitted.
4. Migrations are tested: apply all, roll back to the first, re-apply.
5. Seed data is verified.
6. A test that the search query uses an index — by executing `EXPLAIN` and asserting no sequential scan on the tasks table.
7. The whole database suite runs in under 60 seconds.

Number 6 is unusual and genuinely valuable.
:::

::: solution
```csharp
[Fact]
public async Task The_search_query_uses_an_index()
{
    await SeedManyTasksAsync(10_000);
    await db.Database.ExecuteSqlRawAsync("ANALYZE tasks;");      // fresh statistics

    var sql = repository.BuildSearchQuery(new TaskQuery { Statuses = [TaskStatus.Todo] }).ToQueryString();

    await using var connection = new NpgsqlConnection(fixture.ConnectionString);
    await connection.OpenAsync();
    await using var command = new NpgsqlCommand($"EXPLAIN (FORMAT JSON) {StripParameters(sql)}", connection);
    var plan = (string)(await command.ExecuteScalarAsync())!;

    plan.ShouldNotContain("\"Node Type\": \"Seq Scan\"",
        customMessage: $"The search query is doing a sequential scan:\n{plan}");
}
```

Two practical notes:

**`ANALYZE` first.** PostgreSQL chooses a plan from table statistics. On a table just populated in a test, statistics are stale and the planner may pick a sequential scan simply because it thinks the table is tiny. Without `ANALYZE` this test is flaky in the most confusing way.

**Seed enough rows.** With 100 rows a sequential scan genuinely *is* faster and PostgreSQL will correctly choose it. The test needs enough data for an index to be the right choice — 10,000 is a reasonable floor.

Requirement 3, documenting what the fake cannot do, is best expressed in code rather than prose:

```csharp
public abstract class TaskRepositoryContract
{
    protected virtual bool SupportsConstraints => true;
    protected virtual bool SupportsConcurrency => true;

    [SkippableFact]
    public async Task Duplicate_titles_within_a_project_are_rejected()
    {
        Skip.IfNot(SupportsConstraints, "The in-memory fake has no unique constraints.");
        // ...
    }
}
```

`Skip.IfNot` (from `Xunit.SkippableFact`) reports the test as skipped **with the reason**, in the test output. That is documentation nobody can forget to update, and the CI report shows exactly which guarantees the fake does not provide.

Requirement 4, migration round-tripping, catches broken `Down` methods — which nobody notices until the night they need to roll back:

```csharp
[Fact]
public async Task Migrations_roll_back_and_reapply_cleanly()
{
    var migrator = db.GetService<IMigrator>();
    var all = db.Database.GetMigrations().ToList();

    await migrator.MigrateAsync(all.First());     // down to the first
    await migrator.MigrateAsync();                // back up to the latest

    (await db.Database.GetPendingMigrationsAsync()).ShouldBeEmpty();
}
```
:::

::: project Real database tests for TaskFlow
1. `PostgresFixture` with Testcontainers and real migrations.
2. A shared container with truncation between classes.
3. The Phase 8 contract suite run against both implementations.
4. Tests for constraints, cascades, concurrency, array containment and SQL translation.
5. The migration round-trip test.
6. The index test.
7. Suite under 60 seconds, running in CI.
8. `DECISIONS.md`: what the in-memory provider let through when you tried it.

Commit.
:::

::: interview How do you test code that talks to a database?
Against a real database, using Testcontainers to start a PostgreSQL container for the test run and applying the real migrations to it. The container is shared across the suite and tables are truncated between test classes.

I avoid EF Core's in-memory provider, and Microsoft now recommends against it too — it is a LINQ-to-Objects store, so it ignores unique constraints, foreign keys and cascades, has no concurrency tokens, cannot run raw SQL, and happily executes queries that real providers cannot translate. Tests pass while production breaks.

For the fast majority of tests I use in-memory fakes at the repository interface, with a shared contract test suite run against both the fake and the EF Core implementation so they cannot drift. Anything about persistence semantics — constraints, cascades, concurrency, SQL translation — is only meaningful against the real database.
:::

::: checkpoint
- [ ] A real PostgreSQL container runs my database tests
- [ ] My real migrations are applied, and rolling back and forward works
- [ ] I saw which tests the in-memory provider lets pass wrongly
- [ ] Contract tests run against both fake and real implementations
- [ ] The full database suite runs in under 60 seconds
:::

## Common mistakes

::: mistake
**The in-memory provider for database tests.** It does not test the database.

**A container per test class.** Three seconds each adds up fast. Share it.

**No cleanup between tests.** Order-dependent failures that are miserable to diagnose.

**Testing `EXPLAIN` without `ANALYZE` and enough rows.** Flaky in a confusing way.

**Never testing the `Down` migration.** You find out it is broken during an incident.
:::
