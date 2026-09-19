---
title: "Checkpoint: the TaskFlow query engine"
summary: Build the filtering, sorting, searching and paging engine the API will expose in Phase 6.
minutes: 75
stage: Stage 1
---

## What are we learning?

Nothing new. You are building the query layer that every later phase depends on, using only LINQ.

::: stop
Everything below is achievable with what you learned in this phase. If you get stuck, the lesson that covers it is named in the requirement.
:::

## The target

One method that answers every question the application will ever ask about tasks:

```csharp
public Page<TaskSummary> Search(TaskQuery query);
```

where:

```csharp
public sealed record TaskQuery
{
    public string? Text { get; init; }                        // matches title, description, labels
    public IReadOnlySet<TaskStatus>? Statuses { get; init; }
    public Priority? MinPriority { get; init; }
    public Guid? ProjectId { get; init; }
    public Guid? AssigneeId { get; init; }
    public bool? Unassigned { get; init; }
    public IReadOnlyList<string>? Labels { get; init; }       // must have ALL of these
    public IReadOnlyList<string>? AnyLabels { get; init; }    // must have AT LEAST ONE
    public DateOnly? DueBefore { get; init; }
    public DateOnly? DueAfter { get; init; }
    public bool? Overdue { get; init; }
    public DateTime? CreatedAfter { get; init; }

    public TaskSortBy SortBy { get; init; } = TaskSortBy.Created;
    public bool Descending { get; init; } = true;
    public int Page { get; init; } = 1;
    public int PageSize { get; init; } = 20;
}
```

## Requirements

### 1. Composable filtering

Every filter property is optional. A null property means "do not filter on this". Build the query by conditionally chaining `Where` clauses — **not** with one enormous predicate full of null checks.

```csharp
var q = _tasks.Values.AsEnumerable();

if (query.ProjectId is { } projectId)
    q = q.Where(t => t.ProjectId == projectId);

if (query.Statuses is { Count: > 0 } statuses)
    q = q.Where(t => statuses.Contains(t.Status));
// ... and so on
```

That pattern — reassigning a lazy sequence — is the one you will use verbatim against `IQueryable` in Phase 7, where each `Where` becomes a SQL `AND`.

### 2. Text search

`Text` matches if it appears, case-insensitively, in the title, the description, **or** any label. An empty or whitespace `Text` means no text filter.

### 3. Label filters

`Labels` requires all of them (`All`); `AnyLabels` requires at least one (`Any`). Both case-insensitive. Both can be supplied at once.

### 4. Sorting

`TaskSortBy` = `Created`, `Due`, `Priority`, `Title`, `Status`, `Relevance`.

- Nulls in `DueDate` always sort last, regardless of direction.
- Always tie-break on `Id` so paging is stable (lesson 2).
- `Relevance` only makes sense when `Text` is set: rank a title match above a description match above a label match. If `Text` is not set, fall back to `Created`.

### 5. Paging

Clamp `Page` to at least 1 and `PageSize` to 1..100. `TotalCount` is counted after filtering, before paging. Enumerate the filtered sequence **once** for both the count and the page (lesson 6) — do not run the pipeline twice.

### 6. Projection

Return `TaskSummary`, not `TaskItem`. The summary carries `Id`, `Title`, `Status`, `Priority`, `DueDate`, `AssigneeName`, `LabelCount`, `CommentCount`, `IsOverdue`.

### 7. Facets

Alongside the page, return counts per status and per label **for the filtered set** — what a UI needs to render filter sidebars showing "Todo (12)".

## Checkpoint

::: checkpoint Before you look at the solution
- [ ] Every filter is optional and composes with every other
- [ ] Text search covers title, description and labels, case-insensitively
- [ ] Sorting is stable and nulls sort last
- [ ] The pipeline is enumerated exactly once
- [ ] Facet counts reflect the filters, not the whole store
- [ ] Nothing throws on an empty store or a query that matches nothing
- [ ] I tested with a store of 10,000 generated tasks and it returns in well under a second
:::

::: project Build it
Work in `src/TaskFlow.Console/Domain/TaskSearch.cs`.

Generate test data:
```csharp
var random = new Random(42);        // fixed seed — reproducible
var tasks = Enumerable.Range(1, 10_000)
    .Select(i => new TaskItem($"Task {i} {Words(random)}", projectIds[random.Next(3)])
    {
        Priority = (Priority)random.Next(4),
        DueDate = random.Next(3) == 0 ? null : DateOnly.FromDateTime(DateTime.UtcNow.AddDays(random.Next(-30, 60)))
    })
    .ToList();
```

Add a `search` command to your CLI exercising every filter. Commit.
:::

::: solution A reference implementation
```csharp
public Page<TaskSummary> Search(TaskQuery query)
{
    var page = Math.Max(1, query.Page);
    var size = Math.Clamp(query.PageSize, 1, 100);
    var today = DateOnly.FromDateTime(DateTime.UtcNow);

    var q = _tasks.Values.AsEnumerable();

    if (query.ProjectId is { } projectId)     q = q.Where(t => t.ProjectId == projectId);
    if (query.AssigneeId is { } assigneeId)   q = q.Where(t => t.AssigneeId == assigneeId);
    if (query.Unassigned is true)             q = q.Where(t => t.AssigneeId is null);
    if (query.MinPriority is { } min)         q = q.Where(t => t.Priority >= min);
    if (query.DueBefore is { } before)        q = q.Where(t => t.DueDate is { } d && d < before);
    if (query.DueAfter is { } after)          q = q.Where(t => t.DueDate is { } d && d > after);
    if (query.CreatedAfter is { } created)    q = q.Where(t => t.CreatedAt > created);
    if (query.Overdue is { } overdue)         q = q.Where(t => t.IsOverdue(today) == overdue);

    if (query.Statuses is { Count: > 0 } statuses)
        q = q.Where(t => statuses.Contains(t.Status));

    if (query.Labels is { Count: > 0 } all)
        q = q.Where(t => all.All(l => t.Labels.Contains(l, StringComparer.OrdinalIgnoreCase)));

    if (query.AnyLabels is { Count: > 0 } any)
        q = q.Where(t => any.Any(l => t.Labels.Contains(l, StringComparer.OrdinalIgnoreCase)));

    if (!string.IsNullOrWhiteSpace(query.Text))
    {
        var text = query.Text.Trim();
        q = q.Where(t =>
            t.Title.Contains(text, StringComparison.OrdinalIgnoreCase) ||
            (t.Description?.Contains(text, StringComparison.OrdinalIgnoreCase) ?? false) ||
            t.Labels.Any(l => l.Contains(text, StringComparison.OrdinalIgnoreCase)));
    }

    // ONE enumeration: materialise the filtered set, then count, sort, page and
    // compute facets from the same list.
    var filtered = q.ToList();

    var ordered = Sort(filtered, query, today);

    var items = ordered
        .Skip((page - 1) * size)
        .Take(size)
        .Select(t => ToSummary(t, today))
        .ToList();

    return new Page<TaskSummary>(items, page, size, filtered.Count)
    {
        StatusFacets = filtered.GroupBy(t => t.Status)
                               .ToDictionary(g => g.Key, g => g.Count()),
        LabelFacets = filtered.SelectMany(t => t.Labels)
                              .GroupBy(l => l, StringComparer.OrdinalIgnoreCase)
                              .OrderByDescending(g => g.Count())
                              .Take(20)
                              .ToDictionary(g => g.Key, g => g.Count(), StringComparer.OrdinalIgnoreCase)
    };
}

private static IEnumerable<TaskItem> Sort(List<TaskItem> tasks, TaskQuery query, DateOnly today)
{
    var desc = query.Descending;

    IOrderedEnumerable<TaskItem> ordered = query.SortBy switch
    {
        TaskSortBy.Title    => Apply(t => t.Title, StringComparer.OrdinalIgnoreCase),
        TaskSortBy.Priority => Apply(t => (int)t.Priority),
        TaskSortBy.Status   => Apply(t => (int)t.Status),
        TaskSortBy.Due      => desc
            ? tasks.OrderByDescending(t => t.DueDate ?? DateOnly.MinValue)
            : tasks.OrderBy(t => t.DueDate ?? DateOnly.MaxValue),     // nulls last either way
        TaskSortBy.Relevance when !string.IsNullOrWhiteSpace(query.Text)
                            => tasks.OrderBy(t => Rank(t, query.Text)),
        _                   => Apply(t => t.CreatedAt)
    };

    return ordered.ThenBy(t => t.Id);        // stable paging

    IOrderedEnumerable<TaskItem> Apply<TKey>(Func<TaskItem, TKey> key, IComparer<TKey>? cmp = null) =>
        desc ? tasks.OrderByDescending(key, cmp) : tasks.OrderBy(key, cmp);
}

private static int Rank(TaskItem t, string text) =>
    t.Title.Contains(text, StringComparison.OrdinalIgnoreCase) ? 0
    : t.Description?.Contains(text, StringComparison.OrdinalIgnoreCase) == true ? 1
    : 2;
```

Four decisions worth understanding rather than copying:

**`var filtered = q.ToList();` before counting and sorting.** Without it you would enumerate the whole filter chain once for `Count()` and again for the page — and against a database that is two round trips. Phase 7 revisits this: there, two queries is actually the *right* answer, because `COUNT(*)` in SQL is far cheaper than transferring every row.

**The local `Apply` function** removes the duplicated `desc ? OrderByDescending : OrderBy` from every arm. `IOrderedEnumerable<T>` is the type `OrderBy` returns and the type `ThenBy` requires — naming it is what lets the tie-break apply to every branch.

**`DueDate ?? DateOnly.MinValue` when descending, `MaxValue` when ascending.** Both push nulls to the end. This is the kind of asymmetry you only get right by writing out what each direction should do.

**Facets from `filtered`, not from `_tasks`.** Facet counts must reflect the current filters, or the UI shows "Todo (400)" and clicking it returns three results.
:::

::: interview Walk me through how you would implement search and filtering
Describe the composable pattern: start from the full sequence, conditionally chain a `Where` per supplied filter so that absent filters cost nothing, then order with a stable tie-break, then count, then page.

The two details that show you have done it before: **paging requires a deterministic sort including a unique tie-break**, otherwise rows repeat or vanish between pages; and **the count must be taken after filtering but before paging**, from the same pipeline, so you do not enumerate twice.

If they push further: against a database you keep the whole chain as `IQueryable` so every filter becomes SQL, and you issue exactly two queries — one `COUNT` and one page — rather than materialising the filtered set.
:::

::: checkpoint Phase 3 complete
- [ ] `Search` handles every filter, composed lazily
- [ ] Paging is stable and the count is correct
- [ ] Facets reflect the filters
- [ ] 10,000 tasks search in well under a second
- [ ] I compared my implementation against the reference and understand every difference
- [ ] I can write `Where`, `Select`, `GroupBy`, `OrderBy`, `Any` and `SelectMany` from memory
:::
