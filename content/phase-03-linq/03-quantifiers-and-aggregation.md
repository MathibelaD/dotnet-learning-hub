---
title: Quantifiers and aggregation
summary: Any, All, Count, Sum, Average, Min, Max and Aggregate — and the subtle cost differences between them.
minutes: 30
stage: Stage 1
---

## What are we learning?

The operators that collapse a sequence into a single value, and the performance traps hiding among them.

## Quantifiers

```csharp
tasks.Any()                                        // is there anything at all?
tasks.Any(t => t.Priority == Priority.Urgent)      // is there at least one match?
tasks.All(t => t.AssigneeId is not null)           // do they all match?
tasks.Contains(someTask)                           // uses Equals — see Phase 1 records
```

Both `Any` and `All` **short-circuit**. `Any` stops at the first match; `All` stops at the first non-match. That makes them cheap.

::: warn `All` on an empty sequence returns `true`
```csharp
new List<TaskItem>().All(t => t.Priority == Priority.Urgent)   // true
```
This is "vacuous truth" — *all zero* elements satisfy the condition. It is mathematically correct and it causes real bugs:

```csharp
if (order.Items.All(i => i.InStock))
    Ship(order);            // ships an order with no items
```

Whenever `All` guards an action, ask whether empty should pass. If not: `items.Count > 0 && items.All(...)`.
:::

## Counting

```csharp
tasks.Count()                                  // enumerates unless the source has a Count
tasks.Count(t => t.IsComplete)                 // always enumerates everything
tasks.LongCount()                              // for sequences bigger than int.MaxValue
```

::: warn `Count() > 0` versus `Any()`
```csharp
if (query.Count() > 0)     // enumerates the ENTIRE sequence
if (query.Any())           // stops at the first element
```
`Enumerable.Count()` does check for `ICollection<T>` and use its `Count` property when it can — so on a `List<T>` it is O(1). But on a lazy query, a database query, or an iterator, it walks everything. `Any()` is never worse and often dramatically better. Make it your default.

Conversely, when you already hold a `List<T>` or an array, `list.Count` (the property, no parentheses) beats both.
:::

## Aggregation

```csharp
tasks.Sum(t => t.EstimatedHours)
tasks.Average(t => t.EstimatedHours)         // throws on an empty sequence!
tasks.Min(t => t.CreatedAt)
tasks.Max(t => t.CreatedAt)
tasks.MinBy(t => t.CreatedAt)                // the ELEMENT, not the value
tasks.MaxBy(t => t.Labels.Count)
```

Behaviour on empty sequences is inconsistent and worth memorising:

| Operator | Empty sequence |
|---|---|
| `Sum` | `0` |
| `Average` | **throws** `InvalidOperationException` |
| `Min` / `Max` on value types | **throws** |
| `Min` / `Max` on nullable or reference types | `null` |
| `MinBy` / `MaxBy` | `null` (or throws for non-nullable value types) |
| `Count` | `0` |

So `tasks.Average(t => t.Hours)` in a report is a crash waiting for the day a filter matches nothing.

```csharp
var avg = tasks.Count > 0 ? tasks.Average(t => t.Hours) : 0;
// or
var avg = tasks.Select(t => (double?)t.Hours).Average() ?? 0;   // nullable overload returns null
```

## `Aggregate` — the general case

```csharp
// seed, then fold
var totalLabels = tasks.Aggregate(0, (sum, t) => sum + t.Labels.Count);

// with a result selector
var summary = tasks.Aggregate(
    seed: (open: 0, done: 0),
    func: (acc, t) => t.IsComplete ? (acc.open, acc.done + 1) : (acc.open + 1, acc.done),
    resultSelector: acc => $"{acc.open} open, {acc.done} done");

// no seed — uses the first element, throws if empty
var longest = titles.Aggregate((a, b) => a.Length >= b.Length ? a : b);
```

`Aggregate` is `reduce`/`fold`. It is the operator everything else could be built from, and the one you should reach for last — `Sum`, `Max`, `Count` and a well-named loop are all clearer when they fit.

::: design When `Aggregate` earns its place
Good use: a single pass computing several results at once, where making three passes would be wasteful.

```csharp
var stats = tasks.Aggregate(
    new Stats(),
    (s, t) => s with
    {
        Total = s.Total + 1,
        Open = s.Open + (t.IsOpen ? 1 : 0),
        Overdue = s.Overdue + (t.IsOverdue(today) ? 1 : 0),
        Hours = s.Hours + t.EstimatedHours
    });
```

Bad use: anything a named operator already does. `tasks.Aggregate(0, (c, _) => c + 1)` is `Count()` written to be unreadable.

Honest alternative: a `foreach` loop with four counters is arguably clearer than the `Aggregate` above and allocates nothing. Both are defensible; pick the one your team will read faster.
:::

::: predict What does this print?
```csharp
var empty = new List<int>();

Console.WriteLine(empty.Sum());
Console.WriteLine(empty.Count());
Console.WriteLine(empty.All(x => x > 100));
Console.WriteLine(empty.Any(x => x > 100));
Console.WriteLine(empty.Average());
```
:::

::: solution
```text
0
0
True
False
```
and then line five throws `InvalidOperationException: Sequence contains no elements.`

The pair that catches everyone is lines 3 and 4: `All` is `true` and `Any` is `false` on the same empty sequence. They are not negations of each other — `!Any(p)` equals `All(!p)`, not `All(p)`.
:::

::: exercise Level 1 — Guided · A statistics report
Compute all of these over the sample data and print a tidy report.

1. Total number of tasks.
2. Number that are open.
3. Whether every task has at least one label.
4. Whether any task is both urgent and unassigned.
5. The earliest `CreatedAt`.
6. The task with the latest due date.
7. The average number of labels per task, safe on an empty list.
8. The total of all labels across all tasks.
9. The longest title.
10. The percentage of tasks completed, to one decimal place.

Then do the whole thing again in **one** `Aggregate` call and compare which you would rather maintain.
:::

::: solution
```csharp
var today = DateOnly.FromDateTime(DateTime.UtcNow);

Console.WriteLine($"""
    Total:        {tasks.Count}
    Open:         {tasks.Count(t => t.IsOpen)}
    All labelled: {tasks.Count > 0 && tasks.All(t => t.Labels.Count > 0)}
    Urgent+free:  {tasks.Any(t => t.Priority == Priority.Urgent && t.AssigneeId is null)}
    First made:   {tasks.Min(t => t.CreatedAt):yyyy-MM-dd}
    Latest due:   {tasks.Where(t => t.DueDate is not null).MaxBy(t => t.DueDate)?.Title ?? "—"}
    Avg labels:   {(tasks.Count == 0 ? 0 : tasks.Average(t => t.Labels.Count)):F1}
    Total labels: {tasks.Sum(t => t.Labels.Count)}
    Longest:      {tasks.MaxBy(t => t.Title.Length)?.Title}
    Complete:     {(tasks.Count == 0 ? 0 : 100.0 * tasks.Count(t => t.IsComplete) / tasks.Count):F1}%
    """);
```

Note the raw string literal `"""` — three or more quotes, content on its own lines, and the closing delimiter's indentation is stripped from every line. It is the right tool for multi-line output and for embedded JSON or SQL, because nothing needs escaping.

Also note `tasks.Count` with no parentheses: `tasks` is a `List<T>`, so that is the O(1) property.

Ten separate passes over the data, and for six items that is completely fine. The `Aggregate` version is one pass and noticeably harder to read. **Do not optimise a ten-element report.** Learn the difference so that when you are aggregating a million rows you know the option exists.
:::

::: challenge Level 3 · A workload report
Produce this, from the task list, in as few passes as you can while keeping it readable:

```text
WORKLOAD BY ASSIGNEE
  sam      4 tasks   2 open   1 overdue   avg priority 2.3
  alex     2 tasks   1 open   0 overdue   avg priority 2.5
  (none)   1 task    1 open   0 overdue   avg priority 0.0

  Busiest: sam (4)
  Team completion rate: 33.3%
```

Requirements:
- Unassigned tasks appear as `(none)`.
- Sorted by task count descending.
- Nothing throws when a group is empty or the list is empty.
- Column alignment done with format specifiers, not manual padding.

You need `GroupBy`, which is the next lesson — go and read it first, or work it out from the name.
:::

::: project Add a stats command to TaskFlow
Add `TaskStatistics` as a record with: `Total`, `ByStatus` (dictionary), `Overdue`, `Unassigned`, `AverageLabels`, `CompletionRate`, `OldestOpen`, `MostUrgent`.

Requirements:
- A static `From(IEnumerable<TaskItem> tasks, DateOnly today)` factory.
- Every field safe on an empty sequence — no exception, sensible zeros.
- One integration point: a `stats` command in your CLI that prints it.
- Write one throwaway check that calls `TaskStatistics.From([], today)` and confirm nothing throws. That single line would have caught the `Average` bug.

Commit.
:::

::: interview Why use `Any()` instead of `Count() > 0`?
`Any()` stops as soon as it finds one element; `Count()` must enumerate the whole sequence to produce a number you then throw away. On a `List<T>` the difference is negligible because `Count()` detects `ICollection<T>` and reads the `Count` property — but on a lazy iterator, a large query, or an EF Core `IQueryable`, `Count()` can mean a full table scan where `Any()` becomes `SELECT EXISTS`.

The same reasoning applies to `All`, which short-circuits on the first failure. The one gotcha worth mentioning: `All` returns `true` for an empty sequence, so guarding an action with it can let an empty collection through.
:::

::: checkpoint
- [ ] I know `All` returns true on an empty sequence and why that causes bugs
- [ ] I can list which aggregation operators throw on empty and which return zero
- [ ] I use `Any()` rather than `Count() > 0` by reflex
- [ ] I wrote a statistics report that is safe on empty input
- [ ] I know when `Aggregate` is worth it and when it is showing off
:::

## Common mistakes

::: mistake
**`Average()` without checking for empty.** Throws. Very common in reporting code that works until a filter matches nothing.

**`Count() > 0` on a lazy or remote sequence.** Enumerates everything.

**Treating `All` as the negation of `Any`.** `!Any(p)` is `All(!p)`.

**`Sum` on a sequence of `int` that can overflow.** `int` silently wraps in an unchecked context. For large counts use `LongCount`/`Sum` over `long`, or wrap in `checked`.

**Calling an aggregate several times on the same lazy query.** Each call re-enumerates. Materialise first.
:::
