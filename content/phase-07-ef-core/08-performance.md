---
title: Query performance
summary: Finding the slow query, understanding why it is slow, and fixing it with evidence.
minutes: 40
stage: Stage 4
---

## What are we learning?

A systematic method for EF Core performance: measure, read the SQL, read the plan, then change something — in that order.

## The method

```text
1. MEASURE      which endpoint is slow, and how slow
2. COUNT        how many queries did it issue?
3. READ THE SQL what did EF Core generate?
4. READ THE PLAN what did PostgreSQL do with it?
5. FIX          index, rewrite, project, cache — in that order of preference
6. MEASURE      confirm, and keep the number
```

Skipping to step 5 is how people add indexes that do nothing and caches that serve stale data.

## Step 2 — counting queries

```csharp
options.LogTo(Console.WriteLine, [DbLoggerCategory.Database.Command.Name], LogLevel.Information);
```

Or catch N+1 automatically in tests:

```csharp
public sealed class QueryCountInterceptor : DbCommandInterceptor
{
    public int Count { get; private set; }
    public override ValueTask<DbDataReader> ReaderExecutingAsync(
        DbCommand command, CommandEventData eventData,
        InterceptionResult<DbDataReader> result, CancellationToken ct = default)
    {
        Count++;
        return base.ReaderExecutingAsync(command, eventData, result, ct);
    }
}

// in a test
Assert.True(interceptor.Count <= 3, $"Expected ≤3 queries, got {interceptor.Count}");
```

That assertion in an integration test is the most effective N+1 defence there is — it fails the moment someone adds a lazy navigation access, rather than six months later in production.

## The five common causes

### 1. N+1

Covered in lesson 3. Fix with projection or `Include`.

### 2. Selecting columns you do not need

```csharp
// ❌ every column of every row, including a 2 KB description
var titles = await db.Tasks.ToListAsync(ct);
foreach (var t in titles) Console.WriteLine(t.Title);

// ✅ one column
var titles = await db.Tasks.Select(t => t.Title).ToListAsync(ct);
```

On a wide table this is often a 10–50× difference in bytes transferred.

### 3. Missing indexes

```sql
EXPLAIN ANALYZE SELECT * FROM tasks WHERE project_id = '...' AND status <> 'Completed';
```

`Seq Scan` with a large `Rows Removed by Filter` means the database read rows only to throw them away.

```csharp
builder.HasIndex(t => new { t.ProjectId, t.Status });
```

Column order in a composite index matters: it can serve queries filtering on `ProjectId` alone, or on both — but not on `Status` alone. Put the most selective, most-always-present column first.

### 4. Cartesian explosion

```csharp
db.Projects
    .Include(p => p.Tasks).ThenInclude(t => t.Comments)
    .Include(p => p.Members)
```
10 projects × 100 tasks × 20 comments × 5 members = 1,000,000 rows, most of them repeated data.

```csharp
.AsSplitQuery()      // several queries instead of one huge join
```

Or configure it globally: `options.UseQuery SplitBehavior(QuerySplittingBehavior.SplitQuery)`. The trade-off is that split queries are not a single atomic snapshot — run them inside a transaction if that matters.

### 5. Tracking on read paths

Lesson 5. Default to `NoTracking`.

## Reading a plan

```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT ...;
```

What to look for:

| Sign | Meaning |
|---|---|
| `Seq Scan` on a large table | No usable index |
| `Rows Removed by Filter: 99711` | Reading rows only to discard them |
| `rows=1000` vs `actual rows=95000` | The planner's estimate is wrong — statistics are stale, run `ANALYZE` |
| `Nested Loop` with a high row count | Often a missing index on the join column |
| `Sort` with `Disk` | The sort exceeded `work_mem` and spilled |
| A large `Buffers: read=` | Reading from disk rather than cache |

The single most useful line is `Rows Removed by Filter`. It tells you directly how much work was wasted.

## Compiled queries

For a query executed thousands of times per second, the expression-tree compilation itself becomes measurable:

```csharp
private static readonly Func<TaskFlowDbContext, Guid, CancellationToken, Task<TaskItem?>> GetById =
    EF.CompileAsyncQuery((TaskFlowDbContext db, Guid id, CancellationToken ct) =>
        db.Tasks.FirstOrDefault(t => t.Id == id));

var task = await GetById(db, id, ct);
```

Typically 10–30% on very hot paths. Measure before adopting it — it costs readability and is rarely the biggest win available.

## Pooling

```csharp
builder.Services.AddDbContextPool<TaskFlowDbContext>(options => options.UseNpgsql(cs));
```

Reuses context instances rather than constructing them per request. Worth a few percent under high load. **Caveat:** a pooled context must not hold per-request state in fields — if your context has a `CurrentUserId` field set at construction, pooling will leak it between requests.

::: exercise Level 1 — Guided · Find and fix three slow queries
Seed 100,000 tasks, 500,000 comments and 50 projects.

1. Add the query-counting interceptor.
2. Write the naive project dashboard: `Include` everything, compute in C#. Measure time and query count.
3. Rewrite with projection. Measure again.
4. `EXPLAIN ANALYZE` the search query with no indexes. Record `Rows Removed by Filter`.
5. Add the composite index. Re-run. Record the improvement.
6. Compare `ToListAsync()` against `Select(t => t.Title).ToListAsync()` for 100,000 rows — time and bytes.
7. Build a deliberate cartesian explosion, count the rows returned, then fix it with `AsSplitQuery()`.

Write every number into `DECISIONS.md`. Numbers you measured are worth more in an interview than techniques you read about.
:::

::: challenge Level 3 · A performance budget you cannot break
Requirements:

1. Every API endpoint responds in under 100ms at the 95th percentile with 100,000 tasks.
2. No endpoint issues more than **three** database queries — enforced by a test, not by review.
3. No endpoint transfers more than 200 rows.
4. A CI test fails if any endpoint regresses past the budget.
5. A `/diagnostics/slow-queries` endpoint (Development only) listing the slowest queries seen since startup.
6. Indexes justified by `EXPLAIN` output committed alongside the migration that adds them.

Point 6 is a discipline worth adopting permanently: an index with no recorded justification is an index nobody will dare remove.
:::

::: solution
For points 2 and 4, an integration test harness:

```csharp
public sealed class QueryBudgetTests(ApiFactory factory) : IClassFixture<ApiFactory>
{
    public static TheoryData<string, int> Endpoints => new()
    {
        { "/api/tasks?page=1&pageSize=20", 3 },
        { "/api/tasks/{id}", 1 },
        { "/api/projects/{id}/stats", 3 },
        { "/api/projects/{id}/tasks", 3 },
    };

    [Theory, MemberData(nameof(Endpoints))]
    public async Task Endpoint_stays_within_its_query_budget(string url, int budget)
    {
        factory.QueryCounter.Reset();
        var response = await factory.CreateClient().GetAsync(url.Replace("{id}", SeedData.TaskId.ToString()));
        response.EnsureSuccessStatusCode();

        Assert.True(factory.QueryCounter.Count <= budget,
            $"{url} issued {factory.QueryCounter.Count} queries (budget {budget}):\n" +
            string.Join("\n", factory.QueryCounter.Sql));
    }
}
```

Printing the actual SQL in the failure message is what makes this test useful rather than annoying — the person who broke it sees immediately which extra query appeared.

For point 5, a `DbCommandInterceptor` recording durations into a bounded structure:

```csharp
public sealed class SlowQueryRecorder : DbCommandInterceptor
{
    private readonly ConcurrentQueue<SlowQuery> _slow = new();

    public override DbDataReader ReaderExecuted(DbCommand command, CommandExecutedEventData data, DbDataReader result)
    {
        if (data.Duration.TotalMilliseconds > 50)
        {
            _slow.Enqueue(new SlowQuery(command.CommandText, data.Duration, DateTimeOffset.UtcNow));
            while (_slow.Count > 100) _slow.TryDequeue(out _);      // bounded
        }
        return result;
    }
}
```

`ConcurrentQueue` because interceptors run on many threads (Phase 13), and the bound because an unbounded diagnostic buffer is a memory leak with extra steps.

**The general principle worth taking from this challenge:** performance requirements that are not asserted are aspirations. A query-count test is cheap, fast and catches the single most common EF Core regression. Add one to every project you work on.
:::

::: project Make TaskFlow fast
1. The query-count interceptor, registered in tests.
2. Query budgets asserted for every endpoint.
3. Every read endpoint projecting; none using `Include` + mapping.
4. Indexes added from `EXPLAIN ANALYZE` evidence, with the evidence in a comment on the migration.
5. `AsSplitQuery` where a cartesian product exists.
6. `AddDbContextPool`.
7. A benchmark script seeding 100,000 tasks and timing every endpoint; results committed.

Commit. **Phase 7 is nearly done** — one checkpoint lesson to go.
:::

::: interview How would you diagnose a slow API endpoint backed by EF Core?
In order: measure the endpoint to confirm what is actually slow; count the queries it issues, because N+1 is the most common cause and a query counter finds it immediately; read the generated SQL to see what EF Core produced; then run `EXPLAIN ANALYZE` on that SQL to see what the database did with it.

The plan tells you which fix is right. A sequential scan with a large `Rows Removed by Filter` means a missing index. A huge row count from joins means a cartesian explosion, fixed with `AsSplitQuery` or projection. Selecting entities where you need three columns means switching to a projection.

Only after that would I consider caching, because caching a query that is slow for a fixable reason just hides it — and adds a staleness problem you did not previously have.
:::

::: checkpoint
- [ ] I can state the six-step diagnostic method from memory
- [ ] I have measured, not guessed, every performance claim I make about TaskFlow
- [ ] I can read `EXPLAIN ANALYZE` and identify a missing index
- [ ] Query budgets are asserted in tests
- [ ] Every index I added has recorded justification
:::

## Common mistakes

::: mistake
**Adding indexes by guesswork.** They cost write performance and storage, and most guessed indexes are never used.

**Caching to hide a missing index.** Now you have two problems.

**Optimising before measuring.** The bottleneck is almost never where you assume.

**`Include` on a read path.** Projection transfers a fraction of the data.

**`AddDbContextPool` with per-request state in a context field.** It leaks between requests.
:::
