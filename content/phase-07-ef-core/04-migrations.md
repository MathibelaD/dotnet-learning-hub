---
title: Migrations and seeding
summary: Evolving a schema safely, including the part everyone gets wrong — data that already exists.
minutes: 40
stage: Stage 4
---

## What are we learning?

How EF Core migrations work, how to apply them safely in production, and the discipline that keeps a schema change from taking your application down.

## The commands

```bash
# add a migration after changing the model
dotnet ef migrations add AddTaskDueDate -p src/TaskFlow.Infrastructure -s src/TaskFlow.Api

# see what it will do — READ THIS EVERY TIME
dotnet ef migrations script -p src/TaskFlow.Infrastructure -s src/TaskFlow.Api

# apply to the database
dotnet ef database update -p src/TaskFlow.Infrastructure -s src/TaskFlow.Api

# undo the last migration (only if NOT applied anywhere shared)
dotnet ef migrations remove -p src/TaskFlow.Infrastructure -s src/TaskFlow.Api

# roll the database back to a named migration
dotnet ef database update AddTaskDueDate -p src/TaskFlow.Infrastructure -s src/TaskFlow.Api

# list them
dotnet ef migrations list -p src/TaskFlow.Infrastructure -s src/TaskFlow.Api
```

`-p` is the project containing the `DbContext`; `-s` is the startup project that has the configuration and connection string. Put them in a script so you never type them again.

## What a migration is

```csharp
public partial class AddTaskDueDate : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AddColumn<DateOnly>(
            name: "due_date", table: "tasks", type: "date", nullable: true);

        migrationBuilder.CreateIndex(
            name: "ix_tasks_status_due_date", table: "tasks",
            columns: ["status", "due_date"]);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.DropIndex(name: "ix_tasks_status_due_date", table: "tasks");
        migrationBuilder.DropColumn(name: "due_date", table: "tasks");
    }
}
```

Plus a snapshot file recording the model as of this migration — that is what the next `migrations add` diffs against. **Never edit the snapshot by hand.**

Applied migrations are recorded in a `__EFMigrationsHistory` table, which is how EF Core knows what has already run.

::: warn Always read the generated migration before committing it
EF Core infers intent from a model diff, and sometimes infers wrongly. The classic: renaming a property produces

```csharp
migrationBuilder.DropColumn(name: "notes", table: "tasks");
migrationBuilder.AddColumn<string>(name: "description", table: "tasks");
```

which is a drop-and-recreate — **every value in that column is destroyed**. What you wanted was:

```csharp
migrationBuilder.RenameColumn(name: "notes", table: "tasks", newName: "description");
```

Editing the generated migration is normal and expected. What you must not edit is a migration that has already been applied anywhere other than your own machine.
:::

## Applying in production

```csharp
// ❌ Do not do this
await app.Services.GetRequiredService<TaskFlowDbContext>().Database.MigrateAsync();
```

Auto-migrating at startup is common and wrong for anything real:
- Several instances starting at once race each other.
- A failed migration leaves you with a broken application and no clean rollback.
- The application's database user needs DDL permissions permanently — a large privilege for a service that normally only needs `SELECT`/`INSERT`/`UPDATE`.
- You cannot review what is about to run.

Do this instead:

```bash
# 1. Generate an idempotent script in CI
dotnet ef migrations script --idempotent -o migrate.sql

# 2. Review it in the pull request

# 3. Apply it as a separate, ordered deployment step
psql "$CONNECTION_STRING" -f migrate.sql

# 4. Then deploy the application
```

`--idempotent` wraps each migration in a check against the history table, so running the script twice is safe.

For development and for integration tests, `MigrateAsync()` at startup is fine and convenient. Gate it on the environment.

## Zero-downtime migrations

::: design The expand/contract pattern
During a deployment, old and new application versions run **at the same time**. So any single migration must be compatible with both.

Renaming `notes` to `description` in one step breaks the old version instantly. Instead, three deployments:

```text
1. EXPAND    Add the new column. Write to BOTH, read from the old.
             Old code: unaffected.  New code: works.

2. MIGRATE   Backfill the new column from the old.
             Deploy code that reads from the new and writes to both.

3. CONTRACT  Once no running instance uses the old column, drop it.
```

The same pattern applies to: making a nullable column required (add with a default, backfill, then add the constraint), splitting a column, and changing a type.

It feels like a lot of ceremony for a rename. It is the difference between a deployment and an outage, and it is the single most valuable operational thing in this phase.
:::

Adding a non-nullable column to an existing table is the one everybody hits:

```csharp
// ❌ fails if rows exist: "column contains null values"
migrationBuilder.AddColumn<int>("priority", "tasks", nullable: false);

// ✅
migrationBuilder.AddColumn<int>("priority", "tasks", nullable: false, defaultValue: 1);
```

## Seeding

Two kinds, and they are different.

**Reference data** — belongs in the migration, versioned with the schema:

```csharp
protected override void OnModelCreating(ModelBuilder builder)
{
    builder.Entity<Label>().HasData(
        new { Id = new Guid("..."), Name = "bug", Colour = "#d73a4a" },
        new { Id = new Guid("..."), Name = "chore", Colour = "#0e8a16" });
}
```

`HasData` generates `INSERT` statements in the migration. Note the **hard-coded Guids**: seed data needs stable keys, because EF Core diffs it on every `migrations add`. `Guid.NewGuid()` here would produce a delete-and-reinsert on every migration.

**Development sample data** — not in migrations, because it must never reach production:

```csharp
public static async Task SeedDevelopmentDataAsync(TaskFlowDbContext db, CancellationToken ct)
{
    if (await db.Tasks.AnyAsync(ct)) return;      // idempotent

    var project = new Project("Platform Migration", ownerId);
    db.Projects.Add(project);
    for (var i = 1; i <= 50; i++)
        db.Tasks.Add(new TaskItem($"Sample task {i}", project.Id));

    await db.SaveChangesAsync(ct);
}

// Program.cs
if (app.Environment.IsDevelopment())
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<TaskFlowDbContext>();
    await db.Database.MigrateAsync();
    await SeedDevelopmentDataAsync(db, CancellationToken.None);
}
```

::: exercise Level 1 — Guided · Migrate a real change
1. Create the initial migration and apply it. Inspect the database: `docker compose exec db psql -U taskflow -c '\d tasks'`.
2. Add `EstimatedHours` (nullable decimal) to `TaskItem`. Migrate. Read the SQL.
3. Add `IsArchived` (non-nullable bool). Migrate, and observe what EF Core does about existing rows.
4. Rename `Description` to `Notes`. Generate the migration and **look at it** — confirm the drop/add, then edit it to a `RenameColumn`.
5. Apply, then roll back to the previous migration and confirm the column returns.
6. Generate an idempotent script and run it twice against a fresh database.
7. Add a `Label` seed with `HasData` and stable Guids. Run `migrations add` again with no other changes and confirm the migration is empty — if it is not, your Guids are not stable.
:::

::: challenge Level 3 · Split a column with zero downtime
`TaskItem.Title` currently holds strings like `"[BUG] Fix the login redirect"`. You need to split the bracketed prefix into a separate `Category` column.

Requirements:
1. Three migrations following expand / migrate / contract.
2. At no point can a running instance of either the old or the new code fail.
3. The backfill handles 1,000,000 rows without locking the table for minutes — batch it.
4. Rows with no bracketed prefix get `Category = 'general'`.
5. A verification query proving the backfill is complete before the contract step.
6. Every step is reversible.

Write the three migrations and the deployment runbook. This is a genuine production task and being able to describe it is a strong interview signal.
:::

::: solution
**Migration 1 — expand.**
```csharp
migrationBuilder.AddColumn<string>("category", "tasks", maxLength: 50, nullable: true);
migrationBuilder.CreateIndex("ix_tasks_category", "tasks", "category");
```
Nullable, so existing rows are fine and old code ignores it. Deploy application v2, which writes both `Title` and `Category` but still reads `Title`.

**Migration 2 — backfill, batched.**
```csharp
migrationBuilder.Sql("""
    DO $$
    DECLARE updated integer;
    BEGIN
      LOOP
        WITH batch AS (
          SELECT id FROM tasks WHERE category IS NULL LIMIT 5000 FOR UPDATE SKIP LOCKED
        )
        UPDATE tasks t
        SET category = COALESCE(NULLIF(substring(t.title from '^\[([A-Z]+)\]'), ''), 'general'),
            title    = trim(regexp_replace(t.title, '^\[[A-Z]+\]\s*', ''))
        FROM batch WHERE t.id = batch.id;

        GET DIAGNOSTICS updated = ROW_COUNT;
        EXIT WHEN updated = 0;
        COMMIT;
      END LOOP;
    END $$;
    """);
```

`LIMIT 5000` plus `COMMIT` per batch keeps each transaction short, so no long lock is held and replication does not fall behind. `FOR UPDATE SKIP LOCKED` lets the backfill run while the application is actively writing.

Then deploy application v3, which reads `Category` and still writes both.

**Verification, before contracting:**
```sql
SELECT count(*) AS unbackfilled FROM tasks WHERE category IS NULL;
SELECT count(*) AS still_prefixed FROM tasks WHERE title ~ '^\[[A-Z]+\]';
```
Both must be zero. Do not proceed on assumption.

**Migration 3 — contract.**
```csharp
migrationBuilder.AlterColumn<string>("category", "tasks",
    maxLength: 50, nullable: false, defaultValue: "general");
```
Deploy application v4, which no longer writes the prefix into `Title`.

**The runbook:**
```text
1. Deploy migration 1 (add nullable column)         reversible: drop column
2. Deploy app v2 (dual write)                       reversible: redeploy v1
3. Run migration 2 (batched backfill)               reversible: it is additive
4. Verify both counts are zero
5. Deploy app v3 (read new, dual write)             reversible: redeploy v2
6. Wait one full deployment cycle                   ← the step people skip
7. Deploy migration 3 (NOT NULL)                    reversible: drop the constraint
8. Deploy app v4 (stop writing the old format)
```

Step 6 is the one that gets skipped and causes the outage. "No instance is running the old code" has to be *verified*, not assumed — a slow-draining instance, a queued background job, or a canary left behind will all still be on the old contract.
:::

::: project Migrations for TaskFlow
1. An initial migration creating the full schema; read every line.
2. `Label` reference data seeded with `HasData` and stable Guids.
3. Development sample data seeded separately, idempotently, Development-only.
4. `scripts/migrate.sh` wrapping the CLI flags.
5. An idempotent script generated in CI and committed to `docs/migrations/`.
6. No auto-migration in Production — gate it on the environment.
7. `DECISIONS.md`: your migration policy, including who applies them and when.

Commit.
:::

::: interview How do you handle database migrations in production?
Migrations are generated from model changes, reviewed like any other code, and — importantly — read before being committed, because EF Core infers intent from a diff and a rename can come out as a drop-and-add that destroys data.

For deployment I generate an idempotent SQL script in CI, review it in the pull request, and apply it as an explicit ordered step before deploying the application. Auto-migrating at startup races between instances, leaves a half-applied state on failure, and requires the application's database user to hold DDL permissions permanently.

For anything that would break the currently-running version, I use expand/contract: add the new structure, deploy code that writes both, backfill in batches, deploy code that reads the new structure, wait for the old version to drain, then drop the old structure. Each step is individually reversible and no step breaks either version.
:::

::: checkpoint
- [ ] I read every generated migration before applying it
- [ ] I caught a rename generated as a drop-and-add and fixed it
- [ ] I rolled a migration back and confirmed the schema returned
- [ ] Seed data uses stable Guids and produces no spurious migrations
- [ ] Production does not auto-migrate, and I can explain why
- [ ] I can describe expand/contract for a column rename
:::

## Common mistakes

::: mistake
**Committing a migration without reading it.** Renames become data loss.

**`Database.Migrate()` at startup in production.** Races, half-applied state, excessive privileges.

**Editing an already-applied migration.** Your history and the database diverge permanently.

**`Guid.NewGuid()` in `HasData`.** Every `migrations add` produces a spurious delete-and-reinsert.

**Adding a non-nullable column with no default to a populated table.** The migration fails, usually in the environment you cannot easily fix.

**An unbatched `UPDATE` over millions of rows.** Locks the table, blows out the transaction log, stalls replication.
:::
