---
title: Querying and change tracking
summary: What tracking costs, when to turn it off, and why some LINQ cannot become SQL.
minutes: 40
stage: Stage 4
---

## What are we learning?

The change tracker — EF Core's most useful and most misunderstood feature — and the boundary of LINQ-to-SQL translation.

## What tracking does

```csharp
var task = await db.Tasks.FirstAsync(t => t.Id == id, ct);
task.Complete();                         // just a C# method call
await db.SaveChangesAsync(ct);           // EF Core notices and issues an UPDATE
```

Nothing told EF Core that `Status` changed. When the entity was materialised, EF Core stored a **snapshot** of every property. `SaveChanges` compares current values against the snapshot and generates SQL for the differences.

That is genuinely useful. It also means:
- every tracked entity costs a second copy of its data
- `SaveChanges` walks every tracked entity comparing every property
- entities stay in memory until the context is disposed

## `AsNoTracking`

```csharp
var tasks = await db.Tasks
    .AsNoTracking()
    .Where(t => t.ProjectId == projectId)
    .ToListAsync(ct);
```

No snapshot, no tracking, roughly 20–40% faster for large result sets and much less memory. The entities are ordinary objects; changing them and calling `SaveChanges` does nothing.

::: design When to track and when not to
**Track** when you are going to modify and save: a `GET`-then-`PUT` handler, a command that changes state.

**Do not track** for anything read-only, which in a typical API is most traffic.

Make it the default for the context and opt in where you need it:
```csharp
options.UseQueryTrackingBehavior(QueryTrackingBehavior.NoTracking);
// then .AsTracking() on the queries that will modify
```

That default is the safer way round: forgetting `AsNoTracking` on a read costs performance silently, whereas forgetting `AsTracking` on a write makes `SaveChanges` do nothing — which you notice immediately in a test.

Note that **projections are never tracked**. `Select(t => new TaskResponse(...))` produces DTOs, not entities, so there is nothing to track. One more reason projection is the right default for read paths.
:::

## Inspecting the tracker

```csharp
db.ChangeTracker.Entries<TaskItem>()
    .Where(e => e.State == EntityState.Modified)
    .Select(e => new { e.Entity.Id, Changed = e.Properties.Where(p => p.IsModified).Select(p => p.Metadata.Name) });

Console.WriteLine(db.ChangeTracker.DebugView.LongView);     // everything it is holding
db.ChangeTracker.Clear();                                    // detach everything
```

`DebugView.LongView` is the tool for "why is `SaveChanges` doing that". Put a breakpoint before `SaveChanges` and look at it.

## Translation limits

::: warn Not all LINQ can become SQL
```csharp
// ❌ throws: could not be translated
db.Tasks.Where(t => MyHelper(t)).ToListAsync();
db.Tasks.Where(t => t.Labels.Contains("bug", StringComparer.OrdinalIgnoreCase)).ToListAsync();
db.Tasks.Where(t => t.IsOverdue(today)).ToListAsync();          // a C# method on the entity
db.Tasks.OrderBy(t => SortKey(t.Status)).ToListAsync();
```

Since EF Core 3.0 an untranslatable expression **throws** rather than silently evaluating client-side. That was a breaking change and a very good one: the old behaviour fetched the entire table and filtered in memory, which looked fine in development and destroyed production.

The fixes:
```csharp
// 1. Express it in terms EF Core knows
db.Tasks.Where(t => t.DueDate != null && t.DueDate < today && t.Status != TaskStatus.Completed);

// 2. Use EF.Functions for provider-specific operations
db.Tasks.Where(t => EF.Functions.ILike(t.Title, $"%{search}%"));       // PostgreSQL ILIKE
db.Tasks.Where(t => EF.Functions.Like(t.Title, $"%{search}%"));

// 3. Make it a computed column in the database (lesson 2), then it IS translatable

// 4. Explicitly evaluate the rest in memory — AFTER narrowing in SQL
var candidates = await db.Tasks.Where(t => t.ProjectId == id).ToListAsync(ct);
var result = candidates.Where(t => t.IsOverdue(today)).ToList();       // now it is LINQ to Objects
```

Option 4 is legitimate when the SQL-side filter is already narrow. It is a disaster when it is not. The question to ask is always: *how many rows cross the wire?*
:::

## Expression trees, revisited

Phase 3 said `IQueryable` takes `Expression<Func<T, bool>>` rather than a delegate. This is where it matters.

```csharp
// This works — an expression tree EF Core can read and translate
Expression<Func<TaskItem, bool>> filter = t => t.Status == TaskStatus.Todo;
db.Tasks.Where(filter);

// This does NOT — a compiled delegate is opaque
Func<TaskItem, bool> predicate = t => t.Status == TaskStatus.Todo;
db.Tasks.Where(predicate);      // binds to Enumerable.Where -> loads the WHOLE TABLE
```

The second compiles. It even works. It fetches every row.

Your Phase 2 `TaskFilters` class returned `Func<TaskItem, bool>`. To reuse that composable design against a database, change the type:

```csharp
public static class TaskFilters
{
    public static Expression<Func<TaskItem, bool>> Open =>
        t => t.Status != TaskStatus.Completed && t.Status != TaskStatus.Cancelled;

    public static Expression<Func<TaskItem, bool>> WithStatus(TaskStatus status) =>
        t => t.Status == status;
}

db.Tasks.Where(TaskFilters.Open).Where(TaskFilters.WithStatus(status));
```

Chained `Where` calls become `AND` in one SQL statement. The composable design from Phase 2 works unchanged against a database — you only had to change one word in the type.

Combining expressions with `&&` is harder (you cannot just write `a && b` on two expression trees) — `LinqKit`'s `PredicateBuilder` or a small expression visitor solves it. Chaining `Where` is simpler and usually enough.

## Rewriting the search

Your Phase 3 `Search` becomes:

```csharp
public async Task<Page<TaskSummaryResponse>> SearchAsync(TaskQuery query, CancellationToken ct)
{
    IQueryable<TaskItem> q = db.Tasks.AsNoTracking();

    if (query.ProjectId is { } projectId) q = q.Where(t => t.ProjectId == projectId);
    if (query.AssigneeId is { } assignee) q = q.Where(t => t.AssigneeId == assignee);
    if (query.Statuses is { Count: > 0 } s) q = q.Where(t => s.Contains(t.Status));
    if (query.Overdue is true) q = q.Where(t => t.DueDate != null && t.DueDate < today
                                                && t.Status != TaskStatus.Completed);
    if (!string.IsNullOrWhiteSpace(query.Text))
        q = q.Where(t => EF.Functions.ILike(t.Title, $"%{query.Text}%")
                      || EF.Functions.ILike(t.Description!, $"%{query.Text}%"));

    var total = await q.CountAsync(ct);                       // SELECT count(*)

    var items = await q
        .OrderByDescending(t => t.CreatedAt).ThenBy(t => t.Id)
        .Skip((page - 1) * size).Take(size)
        .Select(t => new TaskSummaryResponse(t.Id, t.Title, t.Status.ToString(),
                                             t.Project.Name, t.Comments.Count))
        .ToListAsync(ct);

    return new Page<TaskSummaryResponse>(items, page, size, total);
}
```

**Two queries, not one.** In Phase 3 you materialised the filtered list and counted it in memory, which was right for an in-memory store. Against a database it is exactly wrong: `COUNT(*)` on the server is cheap, and transferring every matching row to count them is not. The same requirement, the opposite implementation — and knowing *why* is the point.

::: exercise Level 1 — Guided · Tracking, measured
1. Query 5,000 tasks with tracking, then with `AsNoTracking`. Time both and compare memory (`GC.GetTotalAllocatedBytes()`).
2. Load a task, change the title, print `db.ChangeTracker.DebugView.LongView` before `SaveChanges`.
3. Load with `AsNoTracking`, change the title, call `SaveChanges`, and confirm nothing happened.
4. Write a `Where` using a C# method on the entity and read the exception.
5. Fix it four ways: rewrite the expression, use `EF.Functions`, add a computed column, and evaluate in memory after narrowing.
6. Change `TaskFilters` to return `Expression<Func<TaskItem, bool>>` and confirm the SQL now contains your filters.
7. Deliberately pass a `Func<>` instead and check the SQL — confirm the `WHERE` clause disappears.
:::

::: challenge Level 3 · Port the whole search engine
Rewrite your Phase 3 `Search` for EF Core.

Requirements:
1. Every filter translated to SQL — verify with `ToQueryString()` that no filtering happens in memory.
2. Exactly two round trips: a count and a page.
3. Case-insensitive text search using `ILIKE`, over title, description and labels.
4. Facet counts (per status, per label) — decide whether they justify a third query, and justify your answer.
5. Sorting by any field, stable, nulls last.
6. Benchmark against 100,000 tasks and record the timings.
7. Add the indexes needed to make it fast, and show the `EXPLAIN ANALYZE` before and after.

Point 7 is the one that will teach you the most.
:::

::: solution
For the label filter with a PostgreSQL `text[]` column:
```csharp
if (query.Labels is { Count: > 0 } labels)
    q = q.Where(t => labels.All(l => t.Labels.Contains(l)));       // translates to @>
```
Npgsql maps this to the array containment operator, which a GIN index can serve.

For facets, a third query grouping in SQL:
```csharp
var facets = await q
    .GroupBy(t => t.Status)
    .Select(g => new { Status = g.Key, Count = g.Count() })
    .ToListAsync(ct);
```
`q` still carries every filter, so the facets are correct for the filtered set. It is a third round trip and it is worth it — computing facets in memory would require transferring every matching row.

For point 7, `EXPLAIN ANALYZE` on the unindexed search of 100,000 rows:
```text
Seq Scan on tasks  (cost=0.00..4821.00 rows=312 width=...) (actual time=0.031..38.442 rows=289)
  Filter: ((status <> 'Completed') AND (due_date < '2026-09-19'))
  Rows Removed by Filter: 99711
Execution Time: 38.6 ms
```

After `CREATE INDEX ix_tasks_status_due_date ON tasks (status, due_date)`:
```text
Bitmap Heap Scan on tasks  (cost=8.11..312.44 rows=312 width=...) (actual time=0.079..0.412 rows=289)
  Recheck Cond: ((status <> 'Completed') AND (due_date < '2026-09-19'))
Execution Time: 0.5 ms
```

Seventy times faster. `Rows Removed by Filter: 99711` is the diagnostic to look for — it means the database read 99,711 rows only to discard them.

For `ILIKE '%text%'` a plain B-tree index cannot help, because the leading wildcard makes it unsearchable. Two options:
```sql
CREATE EXTENSION pg_trgm;
CREATE INDEX ix_tasks_title_trgm ON tasks USING gin (title gin_trgm_ops);
```
or move to full-text search with `tsvector`. The trigram index is the smaller change and handles substring matches; full-text search is better for word-based relevance ranking.

**Learn to read `EXPLAIN ANALYZE`.** It is the single highest-leverage database skill, it is not EF Core specific, and most .NET developers never do. `db.Tasks.Where(...).ToQueryString()` gives you the SQL; paste it into `psql` with `EXPLAIN ANALYZE` in front.
:::

::: project TaskFlow's queries on SQL
1. `NoTracking` as the context default, `AsTracking` where you modify.
2. `TaskFilters` returning `Expression<Func<TaskItem, bool>>`.
3. `SearchAsync` fully translated — verified with `ToQueryString()`.
4. Two queries for a page, three with facets.
5. Every read endpoint projecting to a DTO.
6. Indexes added based on `EXPLAIN ANALYZE`, not on guesswork.
7. Seed 100,000 tasks and record before/after timings in `DECISIONS.md`.

Commit.
:::

::: interview What is change tracking in EF Core?
When an entity is materialised by a tracking query, `DbContext` stores a snapshot of its property values. On `SaveChanges` it compares the current values against that snapshot and generates only the necessary `INSERT`, `UPDATE` and `DELETE` statements — which is why modifying a loaded entity and calling `SaveChanges` works without telling EF Core what changed.

The cost is memory for the snapshots and time spent comparing, so read-only queries should use `AsNoTracking`, or the context should default to no-tracking with `AsTracking` opted into where you modify. Projections are never tracked at all, because they produce DTOs rather than entities.

The related point is that `IQueryable` operators take expression trees. Passing a compiled `Func<T, bool>` to `Where` silently binds to the in-memory LINQ operator, which loads the entire table and filters in memory — it compiles and it works, which is what makes it dangerous.
:::

::: checkpoint
- [ ] I measured the cost of tracking versus `AsNoTracking`
- [ ] I read `ChangeTracker.DebugView` before a `SaveChanges`
- [ ] I triggered a translation failure and fixed it four different ways
- [ ] My filters are `Expression<Func<T, bool>>` and appear in the SQL
- [ ] I ran `EXPLAIN ANALYZE` and added an index based on what it said
:::

## Common mistakes

::: mistake
**Tracking on read-only queries.** Wasted memory and time on every request.

**`Func<T, bool>` instead of `Expression<Func<T, bool>>`.** Silently loads the whole table.

**Materialising to count.** `.ToList().Count` instead of `CountAsync()`.

**`ToList()` before filtering.** The most expensive single character sequence in EF Core.

**Adding indexes by guesswork.** Indexes cost write performance and storage. Add them because `EXPLAIN` told you to.
:::
