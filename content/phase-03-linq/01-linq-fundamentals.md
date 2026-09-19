---
title: LINQ fundamentals — Where and Select
summary: Filtering and projecting. Two operators that replace most of the loops you have ever written.
minutes: 40
stage: Stage 1
---

## What are we learning?

The two LINQ operators you will use more than all the others combined, and the mental model that makes the rest obvious.

## The setup

Every example in this phase uses a list of tasks. Create it once in your scratch project and keep it — you will use it for the next six lessons.

```csharp
var tasks = new List<TaskItem>
{
    new("Fix login bug",        Priority.Urgent) { Status = TaskStatus.InProgress, AssigneeId = sam,   DueDate = new(2026, 9, 20), Labels = ["bug", "auth"] },
    new("Write API docs",       Priority.Low)    { Status = TaskStatus.Todo,       AssigneeId = null,  DueDate = new(2026, 10, 5), Labels = ["docs"] },
    new("Migrate to .NET 10",   Priority.High)   { Status = TaskStatus.Completed,  AssigneeId = alex,  CompletedAt = new(2026, 9, 12), Labels = ["chore"] },
    new("Add rate limiting",    Priority.Normal) { Status = TaskStatus.Todo,       AssigneeId = sam,   DueDate = new(2026, 9, 18), Labels = ["security"] },
    new("Fix flaky test",       Priority.High)   { Status = TaskStatus.Blocked,    AssigneeId = alex,  Labels = ["bug", "tests"] },
    new("Update dependencies",  Priority.Low)    { Status = TaskStatus.Completed,  AssigneeId = sam,   CompletedAt = new(2026, 9, 15), Labels = ["chore"] },
};
```

## The model: a pipeline of sequences

```text
source  ──▶  Where  ──▶  Select  ──▶  OrderBy  ──▶  ToList
IEnumerable    IEnumerable   IEnumerable   IEnumerable     List
```

Every LINQ operator takes an `IEnumerable<T>` and returns another `IEnumerable<TSomething>`. That is why they chain. Nothing is executed until something at the end pulls — the iterator machinery from Phase 2 is exactly what makes this work.

## `Where` — keep the ones that match

```csharp
var open = tasks.Where(t => t.Status != TaskStatus.Completed);

var urgentOpen = tasks
    .Where(t => t.Priority == Priority.Urgent)
    .Where(t => t.Status != TaskStatus.Completed);      // chained = AND

var either = tasks.Where(t => t.Priority == Priority.Urgent || t.Status == TaskStatus.Blocked);

var withIndex = tasks.Where((t, i) => i % 2 == 0);      // overload with the index
```

`Where` takes a `Func<T, bool>` — the predicate from Phase 2. It returns a lazy sequence, not a list.

## `Select` — transform each element

```csharp
var titles = tasks.Select(t => t.Title);                          // IEnumerable<string>

var summaries = tasks.Select(t => new TaskSummary(t.Id, t.Title, t.Priority, t.IsComplete));

var anonymous = tasks.Select(t => new { t.Title, t.Priority });   // anonymous type

var numbered = tasks.Select((t, i) => $"{i + 1}. {t.Title}");     // with index
```

`Select` is `map` in other languages. The result type is whatever the lambda returns.

::: note Anonymous types
`new { t.Title, t.Priority }` creates a compiler-generated type with those two read-only properties, value equality and a useful `ToString`. It exists only inside the method — you cannot use it as a return type or a field.

Use them for intermediate steps inside a query. The moment the shape needs to leave the method, make it a `record`. This is the tuple rule again, for the same reason.
:::

## Reading a real query

```csharp
var report = tasks
    .Where(t => t.Status != TaskStatus.Completed)
    .Where(t => t.DueDate is { } due && due < DateOnly.FromDateTime(DateTime.UtcNow))
    .Select(t => new
    {
        t.Title,
        t.Priority,
        DaysLate = DateOnly.FromDateTime(DateTime.UtcNow).DayNumber - t.DueDate!.Value.DayNumber
    })
    .ToList();
```

Read it top to bottom as a sentence: *take the tasks, keep the incomplete ones, keep the ones past their due date, and for each produce a title, priority and days-late.*

That readability is the point. The equivalent loop is about fourteen lines and you have to hold the accumulator in your head.

## Query syntax

C# has a second, SQL-like syntax for the same thing:

```csharp
var report =
    from t in tasks
    where t.Status != TaskStatus.Completed
    orderby t.Priority descending, t.DueDate
    select new { t.Title, t.Priority };
```

It compiles to exactly the method calls. It is genuinely nicer for joins and for `let` (Phase 3 lesson 5); method syntax is better for everything else and is what you will see in most codebases. Learn to read both, write method syntax by default.

::: warn `Where` before `Select`, almost always
```csharp
tasks.Select(Expensive).Where(x => x.Ok)    // transforms ALL, then filters
tasks.Where(t => t.Ok).Select(Expensive)    // filters first, transforms fewer
```
Same result, different amount of work. With a database (Phase 7) the difference can be "fetch 10,000 rows" versus "fetch 12".
:::

::: exercise Level 1 — Guided · Ten queries
Write each one, print the result, and check it by eye against the data above.

1. All task titles.
2. Titles of urgent tasks only.
3. Titles of tasks that are neither completed nor cancelled.
4. Tasks assigned to `sam`, as `"title (priority)"` strings.
5. Unassigned tasks.
6. Tasks with the label `"bug"`.
7. Tasks whose title contains "fix", case-insensitive.
8. For each task, an anonymous object with `Title`, `Status` and `LabelCount`.
9. Tasks with a due date, numbered from 1.
10. Titles of tasks that have **no** labels.

Then rewrite numbers 3 and 8 in query syntax.
:::

::: solution
```csharp
// 3
var active = tasks.Where(t => t.Status is not (TaskStatus.Completed or TaskStatus.Cancelled))
                  .Select(t => t.Title);

// 6 — note the comparer; "Bug" should match
var bugs = tasks.Where(t => t.Labels.Contains("bug", StringComparer.OrdinalIgnoreCase));

// 7
var fixes = tasks.Where(t => t.Title.Contains("fix", StringComparison.OrdinalIgnoreCase));

// 8
var overview = tasks.Select(t => new { t.Title, t.Status, LabelCount = t.Labels.Count });

// 9
var due = tasks.Where(t => t.DueDate is not null)
               .Select((t, i) => $"{i + 1}. {t.Title} — {t.DueDate:yyyy-MM-dd}");

// 10
var unlabelled = tasks.Where(t => t.Labels.Count == 0).Select(t => t.Title);
```

Three habits visible here:

- **`is not (A or B)`** rather than `!= A && != B`. Shorter and harder to get wrong.
- **`StringComparison.OrdinalIgnoreCase`** passed explicitly. `Contains(string)` without a comparison is culture-sensitive in some overloads and ordinal in others; being explicit removes a class of locale bugs. In Phase 7 it also determines whether the query can use a database index.
- **`t.Labels.Count == 0`** rather than `!t.Labels.Any()`. For anything with a `Count` property, `Count` is O(1) and `Any()` allocates an enumerator. For a lazy sequence with no count, `Any()` is the right call because it stops after one element.
:::

::: predict Three queries, one result each
```csharp
var q = tasks.Where(t => { Console.WriteLine($"testing {t.Title}"); return t.Priority == Priority.High; });

Console.WriteLine("--- created ---");
var first = q.First();
Console.WriteLine("--- first ---");
var count = q.Count();
Console.WriteLine("--- count ---");
```
How many "testing" lines appear in total, and where?
:::

::: solution
Zero before `--- created ---`. Then three before `--- first ---` (it stops at "Migrate to .NET 10", the third element, which is the first High). Then all six before `--- count ---`.

Nine in total, and the predicate ran over the third element twice.

Two lessons:
1. **Nothing runs at query construction.** Only when something pulls.
2. **Each terminal operation re-runs the whole pipeline.** If you need the results more than once, `.ToList()` them first. If the source were a database, you would have issued two queries.

This is deferred execution, and it is covered properly in lesson 6 of this phase. Notice it now.
:::

::: challenge Level 3 · Replace a loop nobody wants to read
Rewrite this in LINQ. The result must be identical, including ordering.

```csharp
var result = new List<string>();
var seen = new HashSet<string>();

foreach (var task in tasks)
{
    if (task.Status == TaskStatus.Completed) continue;
    if (task.AssigneeId is null) continue;

    foreach (var label in task.Labels)
    {
        if (label.StartsWith("x-")) continue;
        var key = $"{task.AssigneeId}:{label}";
        if (!seen.Add(key)) continue;
        result.Add($"{label} -> {task.Title}");
    }
}

result.Sort();
```

Then answer: is the LINQ version actually better here? Be honest.
:::

::: solution
```csharp
var result = tasks
    .Where(t => t.Status != TaskStatus.Completed && t.AssigneeId is not null)
    .SelectMany(t => t.Labels
        .Where(l => !l.StartsWith("x-"))
        .Select(l => new { Key = $"{t.AssigneeId}:{l}", Line = $"{l} -> {t.Title}" }))
    .DistinctBy(x => x.Key)
    .Select(x => x.Line)
    .Order()
    .ToList();
```

`SelectMany` flattens the nested loop (lesson 5). `DistinctBy` replaces the `HashSet` bookkeeping. `Order()` — added in .NET 7 — is `OrderBy(x => x)`.

**Is it better?** Mostly yes: the six-line version states what it produces rather than how it accumulates, and there is no mutable state to get wrong. But two honest caveats:

- `DistinctBy` keeps the *first* occurrence, same as the `HashSet` version. If you had reached for `Distinct()` on the whole anonymous object instead, the behaviour would differ. Replacing a loop with LINQ means checking the semantics match, not just the output on today's data.
- The loop version does exactly one pass and allocates one set. The LINQ version allocates an anonymous object per label, plus enumerators per stage. For six tasks this is irrelevant. For six million in a hot path, measure.

The right instinct: **LINQ by default for readability; a loop when you have measured that it matters or when the logic genuinely is imperative.** Reflexively converting every loop to LINQ produces the kind of unreadable single expression that gives LINQ a bad name.
:::

::: project Rewrite TaskFlow's queries
Open the hand-written query methods you committed in Phase 1 (`ByStatus`, `ByLabel`, `CountByStatus`, `Overdue`) and rewrite every one in LINQ.

```bash
cd ~/taskflow
git log --oneline --all | grep "hand-written"    # find that commit
git show <hash> -- src/TaskFlow.Console/Domain/InMemoryStore.cs
```

Requirements:
- Same behaviour, verified by running both against the same data.
- Count the lines in each version and record both numbers in `DECISIONS.md`.
- Find at least one place where the LINQ version is **not** clearly better, and say so.

Commit with a message stating the line-count difference.
:::

::: interview What is LINQ?
Language Integrated Query: a set of operators — mostly extension methods on `IEnumerable<T>` and `IQueryable<T>` — plus dedicated C# syntax, that let you express filtering, projection, ordering, grouping and aggregation over any sequence.

The two points that matter in practice: operators are **lazy**, returning a sequence that does no work until enumerated; and the same query syntax targets in-memory collections (`IEnumerable`, compiled to delegates) or a remote data source (`IQueryable`, compiled to an expression tree that a provider like EF Core translates to SQL).
:::

::: checkpoint
- [ ] I have the six-task sample data saved and can run queries against it
- [ ] I wrote all ten queries without copying
- [ ] I predicted the deferred-execution output correctly
- [ ] I can explain why `Where` should usually come before `Select`
- [ ] I rewrote TaskFlow's queries in LINQ and recorded the line counts
:::

## Common mistakes

::: mistake
**`Select` before `Where`.** Transforms everything, then discards most of it.

**Assuming `Where` returns a list.** It returns a lazy sequence. `var x = tasks.Where(...); tasks.Clear(); x.Count();` returns 0.

**Using `Count() > 0` instead of `Any()`.** `Count()` enumerates the entire sequence; `Any()` stops at the first element. On an infinite sequence, `Count()` never returns.

**String comparisons without a `StringComparison`.** Works on your machine, fails on a Turkish locale, and prevents index usage in a database query.
:::
