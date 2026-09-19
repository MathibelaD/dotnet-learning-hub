---
title: SelectMany, set operations and query syntax
summary: Flattening nested sequences, combining sets, and when the SQL-like syntax is actually the better choice.
minutes: 35
stage: Stage 1
---

## What are we learning?

`SelectMany` — the operator that trips people up — plus the set operations, `Zip`, and the parts of query syntax that method syntax cannot express as well.

## `SelectMany` flattens

```csharp
// Select gives you a sequence OF sequences
IEnumerable<IReadOnlyList<string>> nested = tasks.Select(t => t.Labels);

// SelectMany gives you one flat sequence
IEnumerable<string> flat = tasks.SelectMany(t => t.Labels);
```

That is the whole idea: the lambda returns a sequence per element, and `SelectMany` concatenates them.

It is exactly a nested loop:

```csharp
foreach (var task in tasks)
    foreach (var label in task.Labels)
        yield return label;
```

### Keeping the outer element

The single-argument form loses track of which task each label came from. The two-argument overload fixes that:

```csharp
var pairs = tasks.SelectMany(
    t => t.Labels,                       // the inner sequence
    (task, label) => new { task, label });   // combine outer + inner
```

This overload is the one you actually need most of the time, and the one people forget exists.

### Real uses

```csharp
// every comment across every task
projects.SelectMany(p => p.Tasks).SelectMany(t => t.Comments);

// distinct labels in use
tasks.SelectMany(t => t.Labels).Distinct(StringComparer.OrdinalIgnoreCase);

// flatten a dictionary of lists
lookup.SelectMany(g => g);

// cartesian product
priorities.SelectMany(_ => statuses, (p, s) => (p, s));

// split and flatten
lines.SelectMany(line => line.Split(','));
```

## Set operations

```csharp
a.Distinct()                    // remove duplicates — uses Equals/GetHashCode
a.DistinctBy(t => t.Title)      // remove duplicates by a key
a.Union(b)                      // in either, deduplicated
a.Intersect(b)                  // in both
a.Except(b)                     // in a, not in b
a.Concat(b)                     // both, duplicates kept, no dedup
a.SequenceEqual(b)              // same elements in the same order
```

All except `Concat` deduplicate using `Equals`/`GetHashCode`, which is Phase 1's records lesson arriving with consequences:

```csharp
tasks.Select(t => new { t.Title }).Distinct();     // works — anonymous types have value equality
taskClasses.Distinct();                            // does NOT dedupe — reference equality
taskRecords.Distinct();                            // works — records have value equality
```

And the `-By` variants, added in .NET 6, save you from writing a comparer class:

```csharp
tasks.DistinctBy(t => t.AssigneeId);
tasks.UnionBy(other, t => t.Id);
tasks.ExceptBy(otherIds, t => t.Id);
tasks.IntersectBy(otherIds, t => t.Id);
```

## `Zip`

```csharp
var names = new[] { "sam", "alex", "jo" };
var counts = new[] { 4, 2, 0 };

var pairs = names.Zip(counts, (n, c) => $"{n}: {c}");     // sam: 4, alex: 2, jo: 0
var tuples = names.Zip(counts);                            // IEnumerable<(string, int)>
var three = names.Zip(counts, roles);                      // three-way
```

`Zip` stops at the shorter sequence. It is perfect for pairing parallel arrays and for comparing a sequence against its own offset self:

```csharp
var deltas = values.Zip(values.Skip(1), (a, b) => b - a);   // differences between neighbours
```

## Query syntax, where it wins

Method syntax is the default, but three things read better as a query:

### `let` — name an intermediate value

```csharp
var report =
    from t in tasks
    let daysOpen = (DateTime.UtcNow - t.CreatedAt).TotalDays
    let isStale = daysOpen > 14 && t.IsOpen
    where isStale
    orderby daysOpen descending
    select new { t.Title, Days = (int)daysOpen, t.Priority };
```

In method syntax you either recompute `daysOpen` three times or carry it in an anonymous type through every stage. `let` does that for you.

### Joins

Already shown in the previous lesson — `join ... on ... equals ... into` is far more readable than the four-lambda `GroupJoin` call.

### Multiple `from` clauses

```csharp
var pairs =
    from project in projects
    from task in project.Tasks           // this is SelectMany
    where task.IsOpen
    select new { project.Name, task.Title };
```

Each additional `from` compiles to a `SelectMany`. For nested iteration this reads much more naturally than chained lambdas.

::: note What query syntax cannot do
There is no query-syntax keyword for `Count`, `Any`, `First`, `ToList`, `Distinct`, `Skip`, `Take` or most other operators. Mixing is normal and expected:

```csharp
var count = (from t in tasks where t.IsOpen select t).Count();
```

Because of that, most codebases settle on method syntax everywhere except for joins and `let`. Do the same.
:::

::: predict What is the difference?
```csharp
var a = tasks.Select(t => t.Labels).Count();
var b = tasks.SelectMany(t => t.Labels).Count();

var c = tasks.SelectMany(t => t.Labels).Distinct().Count();
var d = tasks.Select(t => t.Labels.Count).Sum();
```
Which pairs are equal for the sample data (6 tasks, labels: [bug,auth], [docs], [chore], [security], [bug,tests], [chore])?
:::

::: solution
```text
a = 6    (six sequences)
b = 8    (eight labels in total)
c = 6    (bug, auth, docs, chore, security, tests)
d = 8
```

`b == d` — both count every label including duplicates.
`a` counts tasks, not labels: a classic `Select`-where-you-meant-`SelectMany` bug, and it produces a plausible-looking number that is simply wrong.

If you ever get a count that matches your *outer* collection size when you expected the inner total, this is why.
:::

::: exercise Level 1 — Guided · Flatten and combine
1. Every label across all tasks, with duplicates.
2. Every distinct label, case-insensitive, sorted.
3. Pairs of `(taskTitle, label)` for every label on every task.
4. Labels used by `sam` but not by `alex`.
5. Labels used by both.
6. All labels from tasks and all labels from a "reserved labels" list, combined with no duplicates.
7. Every comment across every task in every project.
8. Using `Zip`: pair each task with the one after it and report which consecutive pairs have the same priority.
9. A cartesian product of all statuses × all priorities as `"Todo/Urgent"` strings.
10. Rewrite (3) in query syntax with two `from` clauses.
:::

::: solution
```csharp
// 3 — the two-argument overload keeps the outer element
tasks.SelectMany(t => t.Labels, (task, label) => (task.Title, label));

// 4
var samLabels  = tasks.Where(t => t.AssigneeId == sam).SelectMany(t => t.Labels);
var alexLabels = tasks.Where(t => t.AssigneeId == alex).SelectMany(t => t.Labels);
var only = samLabels.Except(alexLabels, StringComparer.OrdinalIgnoreCase);

// 8
var samePriority = tasks
    .Zip(tasks.Skip(1), (a, b) => (a, b))
    .Where(p => p.a.Priority == p.b.Priority)
    .Select(p => $"{p.a.Title} / {p.b.Title}");

// 9
var grid = Enum.GetValues<TaskStatus>()
    .SelectMany(_ => Enum.GetValues<Priority>(), (s, p) => $"{s}/{p}");

// 10
var pairs =
    from task in tasks
    from label in task.Labels
    select (task.Title, label);
```

`Enum.GetValues<T>()` is the generic version added in .NET 5 — it returns `T[]` rather than the old non-generic `Array` that needed casting.

`Except` with a `StringComparer` matters here: without it, `"Bug"` and `"bug"` are different labels and the answer is wrong. Every set operation over strings should take a comparer.
:::

::: challenge Level 3 · A dependency resolver
Tasks can depend on other tasks. Given:

```csharp
record TaskNode(string Id, string Title, IReadOnlyList<string> DependsOn);
```

Implement:
1. `IReadOnlyList<string> AllDependencies(string id)` — the full transitive closure, not just direct dependencies.
2. `IReadOnlyList<string> TopologicalOrder()` — an order in which every task comes after everything it depends on.
3. `bool TryFindCycle(out IReadOnlyList<string> cycle)` — detect a dependency loop and report it.

Use LINQ where it helps and plain code where it does not. Part of the exercise is recognising that **graph traversal is not a LINQ problem** — `SelectMany` gets you one level, and recursion or an explicit stack gets you the rest.
:::

::: solution
```csharp
public IReadOnlyList<string> AllDependencies(string id)
{
    var seen = new HashSet<string>();
    var stack = new Stack<string>(ById[id].DependsOn);

    while (stack.TryPop(out var next))
    {
        if (!seen.Add(next)) continue;              // already visited — also stops cycles
        foreach (var dep in ById[next].DependsOn) stack.Push(dep);
    }
    return seen.ToList();
}
```

This is the honest answer to a question a lot of people try to force into LINQ. `SelectMany` flattens exactly one level:

```csharp
node.DependsOn.SelectMany(d => ById[d].DependsOn)      // two levels, and no further
```

You can recurse with a local function returning `IEnumerable<string>` and `yield return`, which is elegant — but without a `seen` set it loops forever on a cycle, and adding shared mutable state to a lazy sequence is a trap: the set is only correct if the sequence is enumerated exactly once.

**The lesson: LINQ is for sequences, not graphs.** When the shape of the problem is traversal with visited-tracking, write the loop. Choosing the right tool is worth more than making everything a one-liner.

Topological order with Kahn's algorithm:
```csharp
var inDegree = nodes.ToDictionary(n => n.Id, n => n.DependsOn.Count);
var ready = new Queue<string>(inDegree.Where(kv => kv.Value == 0).Select(kv => kv.Key));
var order = new List<string>();

while (ready.TryDequeue(out var id))
{
    order.Add(id);
    foreach (var dependent in Dependents[id])
        if (--inDegree[dependent] == 0) ready.Enqueue(dependent);
}

// if order.Count < nodes.Count, everything left is in a cycle
```
:::

::: project Task dependencies in TaskFlow
You built `Dependency(Guid BlockedBy)` as a behaviour back in Phase 1. Make it real.

1. Add `IReadOnlyList<Guid> Blockers(Guid taskId)` and `IReadOnlyList<Guid> Blocking(Guid taskId)` to the store.
2. Add `IReadOnlyList<TaskItem> Ready()` — open tasks whose blockers are all complete. This is what a "what can I work on now" view is.
3. Add cycle detection, and refuse to add a dependency that would create one.
4. Add a `tree` command that prints the dependency tree for a task, indented.
5. Every one of these must be safe when a blocker id refers to a task that no longer exists.

Commit. Point (5) is not busywork — dangling references are the single most common bug in this kind of feature, and Phase 7 shows you how a database foreign key removes the problem entirely.
:::

::: interview What does SelectMany do?
It projects each element to a sequence and concatenates the results into one flat sequence — the LINQ equivalent of a nested loop, and `flatMap` in other languages.

The overload worth mentioning is the two-argument one, which takes both the outer element and each inner element, so you keep track of where each flattened item came from. In query syntax, a second `from` clause compiles to `SelectMany`.

A concrete example helps: `tasks.SelectMany(t => t.Labels)` gives every label across every task, whereas `tasks.Select(t => t.Labels)` gives a sequence of label collections.
:::

::: checkpoint
- [ ] I can explain the difference between `Select` and `SelectMany` with an example
- [ ] I used the two-argument `SelectMany` overload to keep the outer element
- [ ] I passed a `StringComparer` to every set operation over strings
- [ ] I used `let` in query syntax and know why method syntax has no equivalent
- [ ] I recognised that graph traversal is not a LINQ problem
:::

## Common mistakes

::: mistake
**`Select` where you meant `SelectMany`.** You get a sequence of sequences and a count that matches the outer collection.

**`Distinct()` on a class without value equality.** Silently removes nothing.

**Set operations on strings without a comparer.** `"Bug"` and `"bug"` are different, and your counts are wrong in a way nobody notices for months.

**`Union` when you meant `Concat`.** `Union` deduplicates; if you wanted all items including duplicates, you lost data.

**Forcing graph or tree work into LINQ.** Recursion without visited-tracking hangs on cycles; adding a shared `HashSet` to a lazy query breaks on the second enumeration.
:::
