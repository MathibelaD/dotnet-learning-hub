---
title: Relationships
summary: One-to-one, one-to-many and many-to-many — and the loading strategy that decides your performance.
minutes: 45
stage: Stage 4
---

## What are we learning?

Modelling relationships between entities, and the three ways to load related data — one of which is a trap.

## One-to-many

The commonest relationship: a project has many tasks.

```csharp
public sealed class Project
{
    private readonly List<TaskItem> _tasks = [];
    public Guid Id { get; private set; }
    public string Name { get; private set; } = "";
    public IReadOnlyList<TaskItem> Tasks => _tasks;
}

public sealed class TaskItem
{
    public Guid Id { get; private set; }
    public Guid ProjectId { get; private set; }      // foreign key
    public Project Project { get; private set; } = null!;   // navigation
}
```

```csharp
builder.HasOne(t => t.Project)
    .WithMany(p => p.Tasks)
    .HasForeignKey(t => t.ProjectId)
    .OnDelete(DeleteBehavior.Cascade);
```

::: design Delete behaviour is a decision, not a default
| Behaviour | When the principal is deleted |
|---|---|
| `Cascade` | Dependents are deleted too |
| `Restrict` | The delete fails if dependents exist |
| `SetNull` | The FK is set to null (requires a nullable FK) |
| `NoAction` | EF Core does nothing; the database decides |

Applied to TaskFlow:
- Project → Tasks: **Cascade**. Deleting a project should remove its tasks. (Or `Restrict`, if you would rather force the user to empty it first — also defensible.)
- Task → Comments: **Cascade**. A comment has no meaning without its task.
- User → Tasks (as assignee): **SetNull**. Deleting a user must not delete their tasks; it unassigns them.

Getting this wrong is expensive in both directions: cascade where you meant restrict silently destroys data, and restrict where you meant cascade produces foreign-key violations your users cannot resolve.
:::

## Always include the foreign key property

```csharp
public Guid ProjectId { get; private set; }     // ✅ explicit FK
public Project Project { get; private set; }    // ✅ navigation
```

EF Core supports "shadow" foreign keys that exist only in the database. Do not use them. Having `ProjectId` on the entity means:

- you can set a relationship without loading the related entity (`new TaskItem(title, projectId)`)
- you can filter on it without a join (`Where(t => t.ProjectId == id)`)
- your DTOs can expose it
- it is visible when reading the class

## One-to-one

```csharp
builder.HasOne(u => u.Profile)
    .WithOne(p => p.User)
    .HasForeignKey<UserProfile>(p => p.UserId);
```

The `HasForeignKey<T>` type argument declares which side is the *dependent* — the side that holds the foreign key. There is no way for EF Core to infer it.

One-to-one is rarer than people expect. Ask whether it should just be columns on the same table, or an owned type.

## Many-to-many

```csharp
public sealed class TaskItem
{
    public ICollection<Label> Labels { get; private set; } = [];
}

public sealed class Label
{
    public ICollection<TaskItem> Tasks { get; private set; } = [];
}
```

```csharp
builder.HasMany(t => t.Labels)
    .WithMany(l => l.Tasks)
    .UsingEntity("task_labels");           // EF Core creates the join table
```

Since EF Core 5 the join table is implicit. But when the relationship itself has data — who added the label, and when — you need an explicit join entity:

```csharp
public sealed class TaskLabel
{
    public Guid TaskId { get; private set; }
    public Guid LabelId { get; private set; }
    public Guid AddedByUserId { get; private set; }
    public DateTimeOffset AddedAt { get; private set; }
}

builder.HasMany(t => t.Labels)
    .WithMany(l => l.Tasks)
    .UsingEntity<TaskLabel>(
        r => r.HasOne<Label>().WithMany().HasForeignKey(tl => tl.LabelId),
        l => l.HasOne<TaskItem>().WithMany().HasForeignKey(tl => tl.TaskId),
        j => j.HasKey(tl => new { tl.TaskId, tl.LabelId }));
```

**The moment a relationship needs its own attributes, it is an entity.** That is a domain modelling insight, not an EF Core one.

## Loading related data

This is where performance is won or lost.

### Eager loading — `Include`

```csharp
var tasks = await db.Tasks
    .Include(t => t.Comments)
    .Include(t => t.Project)
    .ThenInclude(p => p.Owner)
    .ToListAsync(ct);
```

One query (or a small number — EF Core splits when it judges the cartesian product too wide). Explicit, predictable, and what you should use by default.

### Explicit loading

```csharp
var task = await db.Tasks.FirstAsync(t => t.Id == id, ct);
await db.Entry(task).Collection(t => t.Comments).LoadAsync(ct);
await db.Entry(task).Reference(t => t.Project).LoadAsync(ct);
```

Useful when you conditionally need related data.

### Lazy loading — avoid it

```csharp
// requires Microsoft.EntityFrameworkCore.Proxies and virtual navigations
options.UseLazyLoadingProxies();

foreach (var task in tasks)
    Console.WriteLine(task.Project.Name);    // a SEPARATE QUERY per task
```

::: warn Lazy loading is how N+1 happens
With 1,000 tasks, that loop issues **1,001 queries**. Each is fast; together they take 30 seconds.

Worse, it is invisible: `task.Project.Name` is a property access. Nothing in the code suggests a database round trip. And if serialisation touches a navigation property (Phase 6's reason for DTOs), your JSON serialiser triggers queries while writing the response — after the response has started, so the resulting exception cannot even produce a sensible error.

Leave lazy loading off. `Include` what you need, and let EF Core throw a clear null reference when you forgot, rather than silently issuing a thousand queries.

EF Core can warn you: `options.ConfigureWarnings(w => w.Throw(CoreEventId.LazyLoadOnDisposedContextWarning))`.
:::

### Projection — usually the best option

```csharp
var summaries = await db.Tasks
    .Where(t => t.ProjectId == projectId)
    .Select(t => new TaskSummaryResponse(
        t.Id,
        t.Title,
        t.Status.ToString(),
        t.Project.Name,               // a JOIN, not a second query
        t.Comments.Count))            // a subquery, not loading the comments
    .ToListAsync(ct);
```

This is the technique to reach for most often. It:
- selects only the columns you need
- turns navigations into joins and aggregates automatically
- returns DTOs directly, so there is no mapping step
- **cannot** N+1, because it is one SQL statement

For read endpoints — which is most of an API — projection beats `Include` on every axis.

::: exercise Level 1 — Guided · Wire up the relationships
1. Project → Tasks, one-to-many, cascade delete.
2. Task → Comments, one-to-many, cascade delete.
3. User → Tasks (assignee), one-to-many, `SetNull`, nullable FK.
4. Task ↔ Label, many-to-many with an explicit `TaskLabel` join entity carrying `AddedAt` and `AddedByUserId`.
5. Project → Owner (User), many-to-one, `Restrict`.
6. Generate a migration and check every foreign key and `ON DELETE` clause in the SQL.
7. Write a query for each loading strategy and compare the SQL and the query count in the logs:
   - `Include(t => t.Comments)`
   - explicit `LoadAsync`
   - projection with `Select`
:::

::: predict How many queries?
```csharp
// A
var tasks = await db.Tasks.Include(t => t.Comments).ToListAsync();

// B
var tasks = await db.Tasks.ToListAsync();
foreach (var t in tasks) Console.WriteLine(t.Comments.Count);     // lazy loading ON

// C
var tasks = await db.Tasks.ToListAsync();
foreach (var t in tasks) Console.WriteLine(t.Comments.Count);     // lazy loading OFF

// D
var data = await db.Tasks.Select(t => new { t.Title, Count = t.Comments.Count }).ToListAsync();

// E
var tasks = await db.Tasks
    .Include(t => t.Comments)
    .Include(t => t.Labels)
    .Include(t => t.Project)
    .ToListAsync();
```
Assume 1,000 tasks.
:::

::: solution
- **A — 1 query.** A `LEFT JOIN`, with rows duplicated per comment and EF Core de-duplicating during materialisation.
- **B — 1,001 queries.** The N+1. Thirty seconds instead of thirty milliseconds.
- **C — 1 query, and `Comments` is empty for every task.** Worse than an error: you get a wrong answer with no indication. Every count is 0.
- **D — 1 query,** with `Comments.Count` as a correlated subquery or a `GROUP BY`. Fastest of all, because it transfers two columns rather than every column of every task and comment.
- **E — 1 query by default**, but the `JOIN` produces a cartesian product: 1,000 tasks × 5 comments × 3 labels = 15,000 rows, with the task's columns repeated 15 times each. EF Core detects this and may automatically split into several queries; you can force it with `.AsSplitQuery()`.

C is the one to dwell on. Turning lazy loading off does not make the problem loud — it makes it silent. The real defence is projection: with `Select`, a field you forgot to project is a compile error in the DTO constructor, not an empty collection at runtime.
:::

::: challenge Level 3 · Build the project dashboard query
Produce, for one project, in **as few queries as possible**:

```text
PROJECT: Platform Migration            owner: Sam Mathibela
  24 tasks · 8 open · 3 overdue · 62% complete

  RECENT ACTIVITY (last 5 comments across all tasks)
    alex on "Fix flaky test": "reproduced on CI"           2h ago
    sam  on "Add rate limiting": "spec attached"           5h ago

  TOP LABELS         bug 12 · chore 7 · security 4
  BUSIEST ASSIGNEE   alex (9 open)
  OLDEST OPEN TASK   "Migrate config" — 47 days
```

Requirements:
1. At most **three** database round trips. Justify each one.
2. No entity is materialised that you do not display — project into DTOs.
3. Correct when the project has zero tasks.
4. Log and record the actual SQL and the total time.
5. Then write the naive version (load everything with `Include`, compute in C#) and compare row counts transferred and elapsed time.

Point 5 is the point of the exercise. Measure, do not assume.
:::

::: solution
```csharp
public async Task<ProjectDashboard> GetDashboardAsync(Guid projectId, CancellationToken ct)
{
    var today = DateOnly.FromDateTime(DateTime.UtcNow);

    // Query 1 — the project, its owner and all the scalar aggregates in one round trip.
    var summary = await db.Projects
        .Where(p => p.Id == projectId)
        .Select(p => new
        {
            p.Id,
            p.Name,
            OwnerName = p.Owner.DisplayName,
            Total = p.Tasks.Count,
            Open = p.Tasks.Count(t => t.Status != TaskStatus.Completed && t.Status != TaskStatus.Cancelled),
            Overdue = p.Tasks.Count(t => t.DueDate != null && t.DueDate < today
                                         && t.Status != TaskStatus.Completed),
            Completed = p.Tasks.Count(t => t.Status == TaskStatus.Completed),
            OldestOpen = p.Tasks
                .Where(t => t.Status != TaskStatus.Completed && t.Status != TaskStatus.Cancelled)
                .OrderBy(t => t.CreatedAt)
                .Select(t => new { t.Title, t.CreatedAt })
                .FirstOrDefault()
        })
        .FirstOrDefaultAsync(ct);

    if (summary is null) return ProjectDashboard.NotFound;

    // Query 2 — recent comments, joined and projected.
    var activity = await db.Comments
        .Where(c => c.Task.ProjectId == projectId)
        .OrderByDescending(c => c.CreatedAt)
        .Take(5)
        .Select(c => new ActivityItem(c.Author.DisplayName, c.Task.Title, c.Body, c.CreatedAt))
        .ToListAsync(ct);

    // Query 3 — label counts, grouped in SQL.
    var labels = await db.Tasks
        .Where(t => t.ProjectId == projectId)
        .SelectMany(t => t.Labels)
        .GroupBy(l => l.Name)
        .OrderByDescending(g => g.Count())
        .Take(5)
        .Select(g => new LabelCount(g.Key, g.Count()))
        .ToListAsync(ct);

    return new ProjectDashboard(summary.Name, summary.OwnerName, ...);
}
```

**Why three and not one:** query 1 returns a single row of scalars. Queries 2 and 3 return sets with different shapes and different cardinalities. Combining them would mean either a cartesian product or a union with nullable columns — both slower and far less readable than three round trips of a few milliseconds each.

**Why three and not eight:** every aggregate in query 1 becomes a correlated subquery or a `FILTER` clause in one statement. Doing them separately would be six extra round trips for no benefit.

The judgement to internalise: **round trips are the expensive unit, but combining unrelated shapes into one query is usually worse.** Group by shape, not by count.

Typical measurements for a project with 24 tasks and 60 comments:
- Projected version: 3 queries, ~40 rows transferred, ~6ms.
- Naive `Include`-everything version: 1 query, ~1,400 rows (cartesian product of tasks × comments × labels), ~180ms, plus materialising 24 tasks, 60 comments and 40 label objects you then throw away.

Thirty times slower, for code that is longer.
:::

::: project Relationships in TaskFlow
1. All five relationships configured with deliberate delete behaviour.
2. Explicit `TaskLabel` join entity with `AddedAt` and `AddedByUserId`.
3. Lazy loading **off** and confirmed off.
4. Every read endpoint rewritten to use projection instead of `Include` + mapping.
5. The project dashboard endpoint.
6. `DECISIONS.md`: the delete behaviour for each relationship and why.
7. Record the before/after query counts and timings for the dashboard.

Commit.
:::

::: interview What is the N+1 query problem?
Issuing one query to fetch a list, then one additional query per item to fetch its related data. Loading 1,000 tasks and then touching `task.Project` on each one produces 1,001 round trips, each individually fast and collectively catastrophic.

In EF Core it is usually caused by lazy loading, where a property access silently triggers a query, so nothing in the code indicates the cost. The fixes are eager loading with `Include`, or — better for read paths — projecting with `Select` into a DTO, which turns navigations into joins and aggregates within a single statement and transfers only the columns you actually need.

The practical defence is turning lazy loading off and reading the generated SQL during development, so the query count is visible rather than inferred.
:::

::: checkpoint
- [ ] Every relationship has a deliberately chosen delete behaviour
- [ ] Lazy loading is off
- [ ] I reproduced the N+1 problem and measured it
- [ ] I rewrote read endpoints as projections and measured the improvement
- [ ] I can explain why the "silent empty collection" case is worse than an error
:::

## Common mistakes

::: mistake
**Lazy loading enabled.** N+1 queries with nothing in the code to suggest them.

**No explicit foreign key property.** You must load an entity just to set a relationship.

**Default delete behaviour.** Either cascading deletes you did not intend or FK violations users cannot fix.

**`Include` everything, always.** A cartesian product and a huge transfer for data you discard.

**Many-to-many that needs attributes.** Once the relationship has data, make it an entity.
:::
