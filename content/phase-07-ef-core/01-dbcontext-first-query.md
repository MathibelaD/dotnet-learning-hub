---
title: DbContext and your first query
summary: Connecting to PostgreSQL, and seeing the SQL your C# produces.
minutes: 40
stage: Stage 4
---

## What are we learning?

What an ORM is doing, how `DbContext` works, and — most importantly — how to see the SQL it generates. That last habit is the difference between using EF Core and being at its mercy.

## What EF Core is

An **object-relational mapper**: it translates between C# objects and relational tables. Concretely it does four things:

1. Translates LINQ queries into SQL.
2. Materialises result rows into your entity objects.
3. Tracks changes to those objects and generates `INSERT`/`UPDATE`/`DELETE`.
4. Manages the schema through migrations.

It is not magic and it is not a substitute for knowing SQL. It is a productivity layer whose output you must be able to read.

## Setup

```bash
cd ~/taskflow
dotnet new classlib -o src/TaskFlow.Infrastructure
dotnet sln add src/TaskFlow.Infrastructure
dotnet add src/TaskFlow.Infrastructure reference src/TaskFlow.Domain
dotnet add src/TaskFlow.Api reference src/TaskFlow.Infrastructure

dotnet add src/TaskFlow.Infrastructure package Npgsql.EntityFrameworkCore.PostgreSQL
dotnet add src/TaskFlow.Infrastructure package Microsoft.EntityFrameworkCore.Design

dotnet new tool-manifest
dotnet tool install dotnet-ef
```

::: note Why Infrastructure is a separate project
`TaskFlow.Domain` must not reference EF Core — that is the build rule you enforced in Phase 5. The domain describes *what* a task is; the infrastructure describes *how it is stored*. Keeping them apart means you can change database, or add a second storage mechanism, without touching your business rules.

`Microsoft.EntityFrameworkCore.Design` is only needed for the CLI tooling (migrations). It does not ship to production.
:::

## The DbContext

```csharp
using Microsoft.EntityFrameworkCore;
using TaskFlow.Domain;

namespace TaskFlow.Infrastructure;

public sealed class TaskFlowDbContext(DbContextOptions<TaskFlowDbContext> options) : DbContext(options)
{
    public DbSet<TaskItem> Tasks => Set<TaskItem>();
    public DbSet<Project> Projects => Set<Project>();
    public DbSet<User> Users => Set<User>();
    public DbSet<Comment> Comments => Set<Comment>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(TaskFlowDbContext).Assembly);
    }
}
```

`DbSet<T>` is your queryable entry point per entity type. `=> Set<T>()` as an expression-bodied property avoids the `CS8618` nullable warning that `public DbSet<T> Tasks { get; set; }` produces.

## Registration

```csharp
builder.Services.AddDbContext<TaskFlowDbContext>(options =>
{
    options.UseNpgsql(builder.Configuration.GetConnectionString("Default"));

    if (builder.Environment.IsDevelopment())
    {
        options.EnableSensitiveDataLogging();     // shows parameter VALUES — never in production
        options.EnableDetailedErrors();
    }
});
```

`AddDbContext` registers it as **scoped** — one context per request. That is correct and important: `DbContext` is not thread-safe, and it accumulates tracked entities, so a singleton context is the captive dependency from Phase 5 with the worst possible consequences.

Connection string, in user secrets (Phase 5), never committed:

```bash
dotnet user-secrets set "ConnectionStrings:Default" \
  "Host=localhost;Port=5432;Database=taskflow;Username=taskflow;Password=devpassword"
```

## Your first query

```csharp
public sealed class EfTaskStore(TaskFlowDbContext db) : ITaskStore
{
    public async Task<TaskItem?> GetAsync(Guid id, CancellationToken ct = default) =>
        await db.Tasks.FirstOrDefaultAsync(t => t.Id == id, ct);

    public async Task<IReadOnlyList<TaskItem>> ListAsync(CancellationToken ct = default) =>
        await db.Tasks.OrderByDescending(t => t.CreatedAt).ToListAsync(ct);

    public async Task AddAsync(TaskItem task, CancellationToken ct = default)
    {
        db.Tasks.Add(task);
        await db.SaveChangesAsync(ct);
    }
}
```

Your `ITaskStore` interface from Phase 1 has not changed. That is what the abstraction was for.

## Seeing the SQL

::: warn Do this now, and never turn it off in development
```json
{
  "Logging": {
    "LogLevel": {
      "Microsoft.EntityFrameworkCore.Database.Command": "Information"
    }
  }
}
```

Now every query prints its SQL and its parameters:

```text
info: Microsoft.EntityFrameworkCore.Database.Command[20101]
      Executed DbCommand (3ms) [Parameters=[@__id_0='3f2a...'], CommandType='Text']
      SELECT t."Id", t."Title", t."Status", ...
      FROM "Tasks" AS t
      WHERE t."Id" = @__id_0
      LIMIT 2
```

Two things to notice immediately:
- `LIMIT 2`, because `FirstOrDefaultAsync`... no — `Single` would be `LIMIT 2`. `First` is `LIMIT 1`. Reading these teaches you the mapping.
- Values are **parameters** (`@__id_0`), not string-concatenated. That is why EF Core is not vulnerable to SQL injection by default (Phase 9).

Every "why is this slow" and "why did it return the wrong rows" question in the next eight phases is answered by reading this output. Developers who do not enable it debug by guessing.
:::

Other ways to see a query:

```csharp
var sql = db.Tasks.Where(t => t.IsOpen).ToQueryString();     // no execution, just the SQL
Console.WriteLine(sql);
```

`ToQueryString()` in a scratch program is the fastest way to answer "what does this LINQ actually do".

## Raw SQL, when you need it

```csharp
var tasks = await db.Tasks
    .FromSql($"SELECT * FROM \"Tasks\" WHERE \"Title\" ILIKE {pattern}")
    .ToListAsync(ct);

await db.Database.ExecuteSqlAsync($"UPDATE \"Tasks\" SET \"Status\" = 4 WHERE \"Id\" = {id}");
```

`FromSql` and `ExecuteSqlAsync` take **`FormattableString`**, and every interpolated value becomes a parameter. The variants ending in `Raw` (`FromSqlRaw`) take a plain string and do **not** parameterise — that is where SQL injection lives. Prefer the interpolated forms; when you must use `Raw`, pass parameters explicitly.

::: exercise Level 1 — Guided · Connect and query
1. Start PostgreSQL: `docker compose up -d db`.
2. Create `TaskFlow.Infrastructure` and the `DbContext` above.
3. Register it, with the connection string in user secrets.
4. Create the schema for now with `db.Database.EnsureCreatedAsync()` in a scratch program. (Migrations come in lesson 4 — `EnsureCreated` is for experiments only, never for a real application.)
5. Insert three tasks, then query them back.
6. Turn on command logging and read the SQL for: `FirstOrDefaultAsync`, `SingleAsync`, `ToListAsync`, `AnyAsync`, `CountAsync`.
7. For each, write down the SQL it produced. Notice `LIMIT 1` vs `LIMIT 2` vs `EXISTS` vs `COUNT(*)` — this is Phase 3's `First`-vs-`Single` and `Any`-vs-`Count` lesson, now with visible consequences.
:::

::: predict What SQL does each produce?
```csharp
db.Tasks.Where(t => t.Priority == Priority.Urgent).ToListAsync();
db.Tasks.FirstOrDefaultAsync(t => t.Id == id);
db.Tasks.SingleOrDefaultAsync(t => t.Id == id);
db.Tasks.AnyAsync(t => t.IsOpen);
db.Tasks.CountAsync(t => t.IsOpen);
db.Tasks.Where(t => t.IsOpen).ToList().Count;
```
Write your prediction, then check with `ToQueryString()` and the logs.
:::

::: solution
```sql
-- Where
SELECT ... FROM "Tasks" WHERE "Priority" = 3

-- FirstOrDefault
SELECT ... FROM "Tasks" WHERE "Id" = @p LIMIT 1

-- SingleOrDefault
SELECT ... FROM "Tasks" WHERE "Id" = @p LIMIT 2      -- fetches two to prove uniqueness

-- Any
SELECT EXISTS (SELECT 1 FROM "Tasks" WHERE ...)

-- Count
SELECT count(*)::int FROM "Tasks" WHERE ...

-- Where(...).ToList().Count
SELECT ... FROM "Tasks" WHERE ...                    -- EVERY ROW, transferred, then counted
```

The last one is the lesson. `.ToList()` materialises the whole result set into memory, and `.Count` then counts objects. For a table with a million open tasks that is a million rows over the network to produce one integer.

`CountAsync()` sends `count(*)` and returns one number. Same-looking code, wildly different cost — and the only way to notice is to read the SQL.

Also note `IsOpen`: if that is a computed C# property with no database mapping, EF Core **cannot translate it** and will throw. Lesson 2 covers making computed properties queryable.
:::

::: challenge Level 3 · Swap the store with no other changes
Your `ITaskStore` has an in-memory implementation. Add an EF Core one.

Requirements:
1. `EfTaskStore` implements `ITaskStore` exactly, with no interface change.
2. Which implementation is used is a configuration setting: `"TaskFlow:Storage": "InMemory" | "Postgres"`.
3. **No file outside `Program.cs` and `TaskFlow.Infrastructure` changes.** Controllers, services, validators — all untouched.
4. The API behaves identically under both.
5. Run your `.http` file against both and diff the responses.

If point 3 fails, something is leaking, and finding what is the real exercise.
:::

::: solution
```csharp
builder.Services.AddScoped<ITaskStore>(sp =>
{
    var options = sp.GetRequiredService<IOptions<TaskFlowOptions>>().Value;
    return options.Storage switch
    {
        StorageKind.Postgres => sp.GetRequiredService<EfTaskStore>(),
        StorageKind.InMemory => sp.GetRequiredService<InMemoryTaskStore>(),
        var other => throw new InvalidOperationException($"Unknown storage '{other}'.")
    };
});
```

Things that commonly leak and break requirement 3:

**`IReadOnlyList<T>` vs `IQueryable<T>` in the interface.** If `ITaskStore` returned `IQueryable`, every consumer would be coupled to EF Core's translation limits — and Phase 3's deferred-execution bug would appear the moment a consumer enumerated after the context was disposed. Returning materialised lists is what makes the two implementations substitutable.

**Guid generation.** The in-memory store's entities assign `Guid.NewGuid()` in the constructor. PostgreSQL could generate them instead. Keeping generation in the domain means the same behaviour either way — and it means you have the id *before* saving, which simplifies a lot of code.

**Ordering.** `Dictionary<Guid, TaskItem>.Values` has an unspecified order that looks stable; a SQL query with no `ORDER BY` also has an unspecified order that is genuinely not stable. If your tests passed on in-memory and fail on PostgreSQL, a missing `ORDER BY` is the first thing to check. This is Phase 3's paging lesson arriving for real.

**Case-insensitive comparison.** `StringComparer.OrdinalIgnoreCase` in memory has no automatic SQL equivalent; `ILIKE` or a `citext` column or `EF.Functions.ILike` is needed. Lesson 5 covers this.

That last pair is the honest answer to "is the abstraction leak-free": it is not, entirely. Behaviour that depends on ordering or string collation differs. The abstraction is still worth having — it just is not a guarantee, and knowing precisely where it leaks is what distinguishes someone who has shipped this from someone who has read about it.
:::

::: project TaskFlow on PostgreSQL
1. `TaskFlow.Infrastructure` with `TaskFlowDbContext`.
2. `EfTaskStore` implementing `ITaskStore`.
3. Storage selectable by configuration.
4. Command logging on in Development.
5. Connection string in user secrets.
6. Run the full `.http` file against PostgreSQL and confirm identical behaviour.
7. In `DECISIONS.md`, record every behavioural difference you found between the two stores.

Commit.
:::

::: interview What is Entity Framework Core?
An object-relational mapper for .NET. It translates LINQ queries into SQL, materialises result rows into entity objects, tracks changes to those objects so `SaveChanges` can generate the right `INSERT`/`UPDATE`/`DELETE` statements, and manages schema evolution through migrations.

`DbContext` is the unit of work and the change tracker; it is registered as scoped, one per request, because it is not thread-safe and it accumulates tracked entities.

The practical point worth making: it generates parameterised SQL, so it is not injection-prone by default — but the SQL it generates is something you should read, not assume. Turning on `Microsoft.EntityFrameworkCore.Database.Command` logging at `Information` is the first thing I do on any EF Core project.
:::

::: checkpoint
- [ ] PostgreSQL is running and TaskFlow connects to it
- [ ] I can see the SQL for every query in my logs
- [ ] I predicted the SQL for six LINQ operators and checked each
- [ ] I understand why `.ToList().Count` is different from `.CountAsync()`
- [ ] The API runs identically on in-memory and PostgreSQL storage
:::

## Common mistakes

::: mistake
**Registering `DbContext` as a singleton.** Not thread-safe, never releases memory, connection eventually dies.

**Never looking at the generated SQL.** You will not notice the N+1 query, the missing index or the client-side evaluation.

**`EnsureCreated()` in a real application.** It creates the schema once and cannot evolve it. Use migrations.

**`EnableSensitiveDataLogging` in production.** It logs parameter values, which includes personal data and, in the wrong query, credentials.

**`FromSqlRaw` with string concatenation.** SQL injection, in an ORM that was protecting you.
:::
