---
title: Grouping and joining
summary: GroupBy, ToLookup, Join and GroupJoin — turning flat sequences into structured reports.
minutes: 40
stage: Stage 1
---

## What are we learning?

The operators that combine and restructure sequences. `GroupBy` is the one you will use constantly; `Join` matters most because of what it becomes in Phase 7.

## `GroupBy`

```csharp
IEnumerable<IGrouping<TaskStatus, TaskItem>> groups = tasks.GroupBy(t => t.Status);

foreach (var group in groups)
{
    Console.WriteLine($"{group.Key}: {group.Count()}");
    foreach (var task in group)          // IGrouping<K,T> IS an IEnumerable<T>
        Console.WriteLine($"   {task.Title}");
}
```

`IGrouping<TKey, TElement>` is a sequence with a `Key`. That is the whole type.

### The overloads that save you work

```csharp
// group by key, project each element
tasks.GroupBy(t => t.Status, t => t.Title);          // IGrouping<TaskStatus, string>

// group by key, project the whole group -> straight to your result shape
tasks.GroupBy(
    t => t.AssigneeId,
    (key, group) => new
    {
        Assignee = key,
        Count = group.Count(),
        Open = group.Count(t => t.IsOpen)
    });

// compound key with a tuple — value equality for free (Phase 2)
tasks.GroupBy(t => (t.ProjectId, t.Status));

// custom comparer
tasks.GroupBy(t => t.Title, StringComparer.OrdinalIgnoreCase);
```

The two-argument result-selector overload is the one to reach for: it goes from raw sequence to report shape in a single operator.

### `GroupBy` buffers everything

Unlike `Where` and `Select`, `GroupBy` cannot produce its first group until it has seen every element — an element belonging to group one might be last. So it reads the whole source and holds all groups in memory. That is unavoidable, and worth knowing before you group ten million rows.

## `ToLookup`

```csharp
ILookup<TaskStatus, TaskItem> byStatus = tasks.ToLookup(t => t.Status);

var blocked = byStatus[TaskStatus.Blocked];        // never null — empty sequence if absent
var none = byStatus[TaskStatus.Cancelled];         // empty, no exception
```

A lookup is a dictionary from key to **many** values, and it is:
- **Eager** — built immediately, unlike `GroupBy`.
- **Safe to index** — a missing key gives an empty sequence, not an exception.
- **Immutable** — no `Add`.

Use `ToLookup` when you will query the groups repeatedly by key. Use `GroupBy` when you will iterate the groups once.

## `Join` — inner join

```csharp
var assigned = tasks.Join(
    users,                       // inner sequence
    task => task.AssigneeId,     // key from the outer
    user => user.Id,             // key from the inner
    (task, user) => new { task.Title, user.DisplayName });   // result
```

This is a SQL inner join: tasks with no matching user disappear. It is implemented with a hash table on the inner sequence, so it is O(n + m), not O(n × m).

Query syntax reads considerably better for joins:

```csharp
var assigned =
    from task in tasks
    join user in users on task.AssigneeId equals user.Id
    select new { task.Title, user.DisplayName };
```

## `GroupJoin` — left outer join

```csharp
var perUser =
    from user in users
    join task in tasks on user.Id equals task.AssigneeId into userTasks
    select new { user.DisplayName, Count = userTasks.Count() };
```

`into userTasks` collects the matches into a sub-sequence — including an empty one when there are no matches. That is what makes it a *left* join: every user appears.

To get a flat left join (one row per pair, with nulls), add `DefaultIfEmpty`:

```csharp
var flat =
    from user in users
    join task in tasks on user.Id equals task.AssigneeId into g
    from task in g.DefaultIfEmpty()
    select new { user.DisplayName, Title = task?.Title ?? "(no tasks)" };
```

That `from ... in g.DefaultIfEmpty()` incantation is the standard LINQ left-join idiom. You will meet it verbatim in Phase 7.

::: note In-memory, a dictionary often beats a join
```csharp
var userById = users.ToDictionary(u => u.Id);
var assigned = tasks
    .Where(t => t.AssigneeId is not null)
    .Select(t => new { t.Title, Name = userById[t.AssigneeId.Value].DisplayName });
```
Clearer than `Join` for most people, and equally fast. `Join` earns its keep when the query will be translated to SQL, where it becomes a real database join — which is exactly the Phase 7 case.
:::

::: exercise Level 1 — Guided · Group six ways
1. Count of tasks per status.
2. Titles grouped by priority, printed as a heading with an indented list.
3. Tasks grouped by assignee, with unassigned appearing as `"(unassigned)"`.
4. Count of tasks per label — note that one task has several labels, so a plain `GroupBy` will not do it (you need `SelectMany`, next lesson — or work around it).
5. Tasks grouped by whether they are overdue: two groups, `true` and `false`.
6. A `ToLookup` by status, then index it with a status that has no tasks and confirm you get an empty sequence rather than an exception.
:::

::: solution
```csharp
// 1
tasks.GroupBy(t => t.Status)
     .Select(g => new { Status = g.Key, Count = g.Count() })
     .OrderByDescending(x => x.Count);

// 3 — the null key needs handling; grouping on a projected string is simplest
tasks.GroupBy(t => t.AssigneeId is { } id ? names[id] : "(unassigned)")
     .OrderByDescending(g => g.Count());

// 4 — a task has many labels, so flatten first
tasks.SelectMany(t => t.Labels, (task, label) => new { label, task })
     .GroupBy(x => x.label, StringComparer.OrdinalIgnoreCase)
     .Select(g => new { Label = g.Key, Count = g.Count() });

// 5
var overdueGroups = tasks.GroupBy(t => t.IsOverdue(today));

// 6
var lookup = tasks.ToLookup(t => t.Status);
Console.WriteLine(lookup[TaskStatus.Cancelled].Count());   // 0, no exception
```

`GroupBy` **does** accept a null key — it groups all the nulls together — but the resulting `g.Key` is null, and printing it gives an empty string. Projecting to a display string first, as in (3), is usually clearer than handling null downstream.
:::

::: challenge Level 3 · The board report
Produce this exact output from `tasks` and `users`:

```text
SPRINT BOARD                                   6 tasks · 2 assignees

BLOCKED (1)
  ! Fix flaky test               alex      high
IN PROGRESS (1)
  ! Fix login bug                sam       urgent    due 2026-09-20
TODO (2)
    Add rate limiting            sam       normal    due 2026-09-18  OVERDUE
    Write API docs               (none)    low       due 2026-10-05
COMPLETED (2)
  ✓ Migrate to .NET 10           alex      high      completed 2026-09-12
  ✓ Update dependencies          sam       low       completed 2026-09-15

LABELS   bug 2 · chore 2 · auth 1 · docs 1 · security 1 · tests 1
```

Requirements:
- Status sections in the given order, and a section is omitted entirely if empty.
- Within a section: priority descending, then due date ascending, nulls last.
- Label counts sorted by count descending, then name ascending.
- `OVERDUE` marker on open tasks past their due date.
- Alignment done with format specifiers.
- No `foreach` at the top level — build the whole thing with LINQ and `string.Join`.
:::

::: solution
```csharp
static readonly TaskStatus[] BoardOrder =
    [TaskStatus.Blocked, TaskStatus.InProgress, TaskStatus.Todo, TaskStatus.Completed, TaskStatus.Cancelled];

var byStatus = tasks.ToLookup(t => t.Status);

var sections = BoardOrder
    .Select(status => (status, items: byStatus[status]
        .OrderByDescending(t => t.Priority)
        .ThenBy(t => t.DueDate ?? DateOnly.MaxValue)
        .ToList()))
    .Where(s => s.items.Count > 0)
    .Select(s => $"{s.status.ToString().ToUpperInvariant()} ({s.items.Count})\n" +
                 string.Join("\n", s.items.Select(FormatRow)));

var labels = tasks
    .SelectMany(t => t.Labels)
    .GroupBy(l => l, StringComparer.OrdinalIgnoreCase)
    .OrderByDescending(g => g.Count())
    .ThenBy(g => g.Key, StringComparer.Ordinal)
    .Select(g => $"{g.Key} {g.Count()}");

Console.WriteLine($"""
    SPRINT BOARD{new string(' ', 35)}{tasks.Count} tasks · {tasks.Select(t => t.AssigneeId).Where(a => a is not null).Distinct().Count()} assignees

    {string.Join("\n", sections)}

    LABELS   {string.Join(" · ", labels)}
    """);

string FormatRow(TaskItem t) =>
    $"  {Marker(t)} {t.Title,-28} {Name(t.AssigneeId),-9} {t.Priority.ToString().ToLowerInvariant(),-9}" +
    (t.CompletedAt is { } c ? $"completed {c:yyyy-MM-dd}"
     : t.DueDate is { } d ? $"due {d:yyyy-MM-dd}{(t.IsOverdue(today) ? "  OVERDUE" : "")}"
     : "");
```

The technique worth stealing: **`ToLookup` plus an explicit order array.** Grouping alone gives you groups in first-seen order and omits empty ones unpredictably. Driving the output from `BoardOrder` and indexing the lookup gives deterministic sections, and the empty-sequence-on-missing-key behaviour of `ILookup` means no null checks anywhere.

`{t.Title,-28}` is a format alignment: negative means left-align in a 28-character field. Use these rather than `PadRight` — they compose inside interpolated strings and are harder to get wrong.
:::

::: project Reporting for TaskFlow
Add a `report` command producing:

1. **By status** — counts and percentages.
2. **By assignee** — tasks, open, overdue, completion rate, sorted by workload.
3. **By label** — counts, top ten.
4. **By project** — a cross-tab of project × status.
5. **Velocity** — tasks completed per week for the last eight weeks, including weeks with zero (this one is harder than it looks — `GroupBy` will not produce the empty weeks; you have to generate the week range and left-join to it).

Requirements: every section a separate method returning a string; no method longer than fifteen lines; nothing throws on empty data.

Number 5 is the one that teaches the real lesson. Commit.
:::

::: solution The velocity trick
`GroupBy` can only produce groups for keys that exist in the data. A week with no completions has no elements, so it silently vanishes and your chart lies.

The fix is to generate the full key range and left-join the data onto it:

```csharp
var weeks = Enumerable.Range(0, 8)
    .Select(i => ISOWeek.GetWeekOfYear(DateTime.UtcNow.AddDays(-7 * i)))
    .Reverse()
    .ToList();

var completedByWeek = tasks
    .Where(t => t.CompletedAt is not null)
    .ToLookup(t => ISOWeek.GetWeekOfYear(t.CompletedAt!.Value));

var velocity = weeks.Select(w => new { Week = w, Count = completedByWeek[w].Count() });
```

`weeks` drives the output; the lookup supplies the numbers and returns empty for the gaps. **Generate the axis, then join the data to it** — that is the general answer to every "my chart is missing the empty buckets" problem, and it comes up constantly in reporting work.
:::

::: interview What is the difference between GroupBy and ToLookup?
Both produce key-to-many-values. `GroupBy` is a lazy LINQ operator returning `IEnumerable<IGrouping<K,T>>` — it is evaluated when enumerated and is meant to be iterated once. `ToLookup` executes immediately and returns an `ILookup<K,T>`, an immutable structure you can index by key repeatedly.

The practical difference: indexing an `ILookup` with a missing key returns an **empty sequence**, whereas indexing a `Dictionary` throws. That makes `ToLookup` the right choice when you will query groups by key several times, and it is what makes report code free of null checks.
:::

::: checkpoint
- [ ] I can use the `GroupBy` result-selector overload without looking it up
- [ ] I know `GroupBy` must buffer the entire source
- [ ] I used `ToLookup` and confirmed a missing key gives an empty sequence
- [ ] I can write a left join in query syntax with `into` and `DefaultIfEmpty`
- [ ] I solved the missing-empty-weeks problem by generating the axis first
:::

## Common mistakes

::: mistake
**Expecting `GroupBy` to produce empty groups.** It cannot invent keys that are not in the data.

**Indexing a `Dictionary` built from `ToDictionary` with a possibly-missing key.** Throws. `ToLookup` or `GetValueOrDefault`.

**`ToDictionary` on a key that is not unique.** Throws `ArgumentException: An item with the same key has already been added`. If duplicates are possible, you wanted `ToLookup` or `GroupBy`.

**Grouping ten million rows in memory.** `GroupBy` buffers. Group in the database (Phase 7) instead.

**Enumerating a group more than once inside the loop.** `g.Count()` then `g.Sum()` then `foreach (var x in g)` re-enumerates each time. For an in-memory `GroupBy` the group is already materialised, but the habit will burn you against a remote source.
:::
