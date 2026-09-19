---
title: Ordering and element operators
summary: OrderBy, ThenBy, and the First/Single/Last family — including which one throws and when.
minutes: 35
stage: Stage 1
---

## What are we learning?

Sorting sequences, and the six ways to pull a single element out of one. The element operators differ in exactly two dimensions, and once you see the grid you never confuse them again.

## Ordering

```csharp
tasks.OrderBy(t => t.DueDate)                       // ascending
tasks.OrderByDescending(t => t.Priority)            // descending

tasks.OrderByDescending(t => t.Priority)
     .ThenBy(t => t.DueDate)                        // tie-break
     .ThenByDescending(t => t.CreatedAt)            // and again

tasks.Order()                                       // sorts by the elements themselves
tasks.OrderBy(t => t.Title, StringComparer.OrdinalIgnoreCase)   // custom comparer

tasks.Reverse()                                     // reverses the current order
```

::: warn `ThenBy`, never a second `OrderBy`
```csharp
tasks.OrderBy(t => t.Priority).OrderBy(t => t.DueDate)   // ❌ the first sort is thrown away
tasks.OrderBy(t => t.Priority).ThenBy(t => t.DueDate)    // ✅ priority, then due date
```
`OrderBy` re-sorts from scratch. Only the last one has any effect. This is a silent bug — the output is sorted, just not the way you meant.
:::

Two more facts:

- LINQ's sort is **stable**: equal elements keep their original relative order. `Array.Sort` and `List.Sort` are *not* stable. If order-within-ties matters, use LINQ.
- Ordering is one of the few lazy operators that must buffer the whole sequence — it cannot emit the first element until it has seen the last. So `OrderBy(...).First()` still reads everything.

### Sorting by an enum

```csharp
tasks.OrderByDescending(t => t.Priority)      // sorts by the NUMERIC value
```

`Priority.Urgent = 3` sorts above `Priority.Low = 0`. That works only because you assigned the numbers in a meaningful order — which is one more reason to assign them explicitly.

If the display order does not match the numeric order, project a sort key:

```csharp
static int SortKey(TaskStatus s) => s switch
{
    TaskStatus.Blocked => 0, TaskStatus.InProgress => 1, TaskStatus.Todo => 2,
    TaskStatus.Completed => 3, TaskStatus.Cancelled => 4, _ => 99
};
tasks.OrderBy(t => SortKey(t.Status));
```

## The element operators

|  | Throws if empty | Returns default if empty |
|---|---|---|
| **First match** | `First()` | `FirstOrDefault()` |
| **Last match** | `Last()` | `LastOrDefault()` |
| **Exactly one** | `Single()` | `SingleOrDefault()` |
| **By position** | `ElementAt(i)` | `ElementAtOrDefault(i)` |

And the crucial extra rule: **`Single` also throws if there is more than one match.** `First` does not.

```csharp
tasks.First(t => t.Priority == Priority.Urgent)          // the first urgent one
tasks.FirstOrDefault(t => t.Priority == Priority.Urgent) // or null
tasks.FirstOrDefault(t => ..., defaultValue: fallback)   // or a value you supply

tasks.Single(t => t.Id == id)            // exactly one, or throw — asserts uniqueness
tasks.SingleOrDefault(t => t.Id == id)   // at most one, or throw
```

::: design Which one should you use?
**Use `Single`/`SingleOrDefault` when uniqueness is an invariant you want enforced.** Looking up by primary key: if two rows come back, something is deeply wrong and you want to know immediately, not silently take the first.

**Use `First`/`FirstOrDefault` when several matches are legitimate** and you genuinely want the first — usually after an `OrderBy`.

**`FirstOrDefault` on a value type returns `0`, not null.** `tasks.Select(t => t.Priority).FirstOrDefault()` on an empty sequence gives `Priority.Low` (=0), which looks like a real answer. Prefer `Cast<Priority?>().FirstOrDefault()` or check `Any()` first.

**Performance:** `Single` must scan at least one element past the match to prove uniqueness; over a database it becomes `SELECT TOP 2`. `First` stops immediately. For a huge table, that difference is real.
:::

::: predict What does each line do?
```csharp
var empty = new List<TaskItem>();

Console.WriteLine(empty.FirstOrDefault()?.Title ?? "none");
Console.WriteLine(empty.First().Title);
Console.WriteLine(tasks.Single(t => t.Priority == Priority.High).Title);
Console.WriteLine(tasks.Select(t => t.Labels.Count).FirstOrDefault());
Console.WriteLine(empty.Select(t => t.Labels.Count).FirstOrDefault());
```
:::

::: solution
1. `none` — `FirstOrDefault` returns null, `?.` short-circuits, `??` supplies the fallback.
2. **Throws** `InvalidOperationException: Sequence contains no elements.`
3. **Throws** `InvalidOperationException: Sequence contains more than one matching element.` — there are two High tasks in the sample data.
4. `2` — the first task has two labels.
5. `0` — and this is the dangerous one. The sequence is empty, `int`'s default is `0`, and `0` is indistinguishable from "a task with no labels". No exception, no null, just a wrong answer that flows onward.

Line 5 is the reason `FirstOrDefault` on value types deserves suspicion. If "empty" and "zero" mean different things in your code, do not let a default paper over the difference.
:::

## Paging

```csharp
const int pageSize = 20;

var page = tasks
    .OrderByDescending(t => t.CreatedAt)     // ordering is MANDATORY for stable paging
    .Skip((pageNumber - 1) * pageSize)
    .Take(pageSize)
    .ToList();

tasks.TakeLast(5);
tasks.SkipWhile(t => t.IsComplete);
tasks.TakeWhile(t => t.Priority >= Priority.High);
tasks.Chunk(100);                            // IEnumerable<T[]>, batches of 100
```

::: warn Paging without ordering is broken
`Skip`/`Take` over an unordered source gives an undefined subset. In memory it usually *looks* stable. Against a database, without `ORDER BY`, the engine may return rows in any order — so page 2 can contain rows you already saw on page 1 and omit others entirely.

**Always order by something unique** (or order by your sort key *then* by the id as a tie-break). You will implement this properly in Phase 6.
:::

::: exercise Level 1 — Guided · Sort and select
1. Tasks ordered by priority (most urgent first), then by due date (soonest first), then by title.
2. The three most recently completed tasks.
3. The single task with a given id — using the operator that asserts uniqueness.
4. The first overdue task, or a friendly message if there is none.
5. Page 2 of all tasks, 2 per page, ordered stably.
6. Tasks ordered by title, ignoring case, with the empty-title ones last.
7. The task with the most labels (do it two ways: `OrderByDescending().First()` and `MaxBy()`).
:::

::: solution
```csharp
// 1
tasks.OrderByDescending(t => t.Priority)
     .ThenBy(t => t.DueDate ?? DateOnly.MaxValue)     // nulls last
     .ThenBy(t => t.Title, StringComparer.OrdinalIgnoreCase);

// 2
tasks.Where(t => t.CompletedAt is not null)
     .OrderByDescending(t => t.CompletedAt)
     .Take(3);

// 4
var message = tasks.FirstOrDefault(t => t.IsOverdue(today)) is { } overdue
    ? $"Oldest overdue: {overdue.Title}"
    : "Nothing overdue 🎉";

// 5
tasks.OrderByDescending(t => t.CreatedAt).ThenBy(t => t.Id)
     .Skip(2).Take(2);

// 7
tasks.OrderByDescending(t => t.Labels.Count).First();   // sorts everything: O(n log n)
tasks.MaxBy(t => t.Labels.Count);                       // single pass: O(n)
```

`t.DueDate ?? DateOnly.MaxValue` is the idiom for "nulls sort last". `OrderBy` places nulls first by default, which is almost never what a user wants from a due-date column.

`MaxBy`/`MinBy` (from .NET 6) are what you want when you need the *element* with the maximum value, not the maximum value itself. `tasks.Max(t => t.Labels.Count)` gives you `2`; `tasks.MaxBy(t => t.Labels.Count)` gives you the task. Both return the first on a tie.
:::

::: debug Level 4 · Why is the list sorted wrong?
This is supposed to show blocked tasks first, then in-progress, then to-do, each group sorted by due date. It shows something else. Find both bugs.

```csharp
var board = tasks
    .OrderBy(t => t.DueDate)
    .OrderBy(t => t.Status)
    .Where(t => t.Status != TaskStatus.Completed)
    .ToList();
```
:::

::: solution
**Bug 1: the second `OrderBy` discards the first.** It should be `.ThenBy(t => t.DueDate)`.

**Bug 2: ordering by `t.Status` sorts by the enum's numeric values** — `Todo=0, InProgress=1, Blocked=2` — which is the opposite of the requested order. A sort-key projection is needed.

There is also a third, non-bug worth noticing: `Where` after `OrderBy` sorts elements that are then thrown away. Correct output, wasted work. Filter first.

```csharp
static int BoardOrder(TaskStatus s) => s switch
{
    TaskStatus.Blocked => 0, TaskStatus.InProgress => 1, TaskStatus.Todo => 2, _ => 3
};

var board = tasks
    .Where(t => t.Status is not (TaskStatus.Completed or TaskStatus.Cancelled))
    .OrderBy(t => BoardOrder(t.Status))
    .ThenBy(t => t.DueDate ?? DateOnly.MaxValue)
    .ToList();
```
:::

::: project Add sorting and paging to TaskFlow
Add to your store:

```csharp
public sealed record Page<T>(IReadOnlyList<T> Items, int PageNumber, int PageSize, int TotalCount)
{
    public int TotalPages => (int)Math.Ceiling(TotalCount / (double)PageSize);
    public bool HasNext => PageNumber < TotalPages;
    public bool HasPrevious => PageNumber > 1;
}

public Page<TaskItem> Query(
    Func<TaskItem, bool>? filter = null,
    TaskSortBy sortBy = TaskSortBy.Created,
    bool descending = true,
    int pageNumber = 1,
    int pageSize = 20);
```

Requirements:
- `TaskSortBy` is an enum: `Created`, `DueDate`, `Priority`, `Title`, `Status`.
- Sorting is always stable — tie-break on `Id`.
- `pageNumber` below 1 and `pageSize` outside 1..100 are clamped, not thrown.
- `TotalCount` is the count **after** filtering, before paging.
- Nulls in `DueDate` sort last regardless of direction.

Wire it into your `list` command with `--sort`, `--desc`, `--page` options.

This exact signature — with `IQueryable` instead of `Func` — is what you implement in Phase 7, and what your API exposes in Phase 6. Getting the shape right now saves rework.

Commit.
:::

::: interview What is the difference between First and Single?
`First` returns the first matching element and throws only if there are none. `Single` returns the only matching element and throws if there are none **or** if there is more than one.

So `Single` is an assertion of uniqueness. Use it for primary-key lookups, where two results mean a data-integrity problem you want to hear about immediately. Use `First` when multiple matches are expected and you want the first, usually after ordering.

The performance note worth adding: against a database, `First` translates to `TOP 1` and `Single` to `TOP 2`, because it must fetch a second row to prove there is not one.
:::

::: checkpoint
- [ ] I know that a second `OrderBy` discards the first
- [ ] I can fill in the throws/default grid for First, Last, Single and ElementAt from memory
- [ ] I understand why `FirstOrDefault` on a value type is dangerous
- [ ] I always order before paging, with a unique tie-break
- [ ] TaskFlow has a `Page<T>` type and a sortable, pageable query
:::

## Common mistakes

::: mistake
**Chaining `OrderBy` twice instead of `ThenBy`.** Silent wrong order.

**`Skip`/`Take` without `OrderBy`.** Duplicated and missing rows across pages, intermittently.

**`Single` on a query that legitimately matches several rows.** Throws in production on data that is perfectly valid.

**Ordering before filtering.** Sorts rows you are about to discard.

**`OrderBy(t => t.DueDate)` with nulls.** Nulls come first. Users expect them last.
:::
