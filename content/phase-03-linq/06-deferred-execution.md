---
title: Deferred execution, IEnumerable and IQueryable
summary: The most important LINQ lesson. What runs, when it runs, and where it runs.
minutes: 40
stage: Stage 1
---

## What are we learning?

Why a LINQ query is not a result, the difference between `IEnumerable<T>` and `IQueryable<T>`, and the bugs that come from confusing them. This is the lesson that separates people who use LINQ from people who understand it.

## A query is a recipe, not a meal

```csharp
var query = tasks.Where(t => t.IsOpen);   // NOTHING has happened yet
tasks.Add(new TaskItem("Added later"));
var result = query.ToList();              // NOW it runs — and includes the new task
```

`query` is an object that knows how to produce results. Each time you enumerate it, it produces them again, from the current state of the source.

## Which operators execute immediately?

| Deferred (lazy) | Immediate (eager) |
|---|---|
| `Where`, `Select`, `SelectMany` | `ToList`, `ToArray`, `ToDictionary`, `ToHashSet`, `ToLookup` |
| `OrderBy`, `ThenBy` (buffers, still deferred) | `Count`, `Sum`, `Average`, `Min`, `Max`, `Aggregate` |
| `Take`, `Skip`, `Distinct`, `Concat` | `First`, `Single`, `Last`, `ElementAt` |
| `GroupBy`, `Join` (buffers, still deferred) | `Any`, `All`, `Contains`, `SequenceEqual` |
| `Cast`, `OfType`, `Reverse`, `Zip` | `foreach` (this is what enumerates) |

The rule of thumb: **if it returns a sequence, it is deferred; if it returns a single value or a concrete collection, it executes.**

## The three bugs deferred execution causes

### 1. The modified-source surprise

```csharp
var open = tasks.Where(t => t.IsOpen);
tasks.Clear();
Console.WriteLine(open.Count());     // 0 — the query re-reads the (now empty) source
```

### 2. Multiple enumeration

```csharp
var expensive = tasks.Where(t => ExpensiveCheck(t));

if (expensive.Any())                          // pass 1
    Console.WriteLine(expensive.Count());     // pass 2
foreach (var t in expensive) { }              // pass 3
```

Three full passes. Against a database, three round trips. Your IDE will warn you about "possible multiple enumeration of IEnumerable" — that warning is real and you should fix it, not suppress it.

```csharp
var expensive = tasks.Where(ExpensiveCheck).ToList();   // one pass, then reuse
```

### 3. The captured-variable surprise

```csharp
var threshold = Priority.Normal;
var query = tasks.Where(t => t.Priority >= threshold);

threshold = Priority.Urgent;
var result = query.ToList();     // filters by URGENT — the closure captured the variable
```

The lambda holds the variable, not its value at the time the query was built (Phase 2's closure lesson).

::: warn The one that costs you a production incident
```csharp
public IEnumerable<TaskItem> GetOpenTasks()
{
    using var context = new TaskFlowDbContext();
    return context.Tasks.Where(t => t.IsOpen);      // ❌ returns an unexecuted query
}                                                    //    and disposes the context

var tasks = GetOpenTasks().ToList();   // ObjectDisposedException
```

The query has not run when the method returns. By the time the caller enumerates it, the `DbContext` — and its database connection — is gone.

The fix is to materialise before the resource goes away:
```csharp
return context.Tasks.Where(t => t.IsOpen).ToList();
```

**Rule: never return a lazy sequence across a boundary that owns a disposable resource.** You will meet this exact bug in Phase 7, and now you will recognise it.
:::

## `IEnumerable<T>` versus `IQueryable<T>`

This is the single most common .NET interview question about LINQ, and the answer is genuinely important.

```csharp
IEnumerable<TaskItem> a = context.Tasks.Where(t => t.IsOpen);   // LINQ to Objects
IQueryable<TaskItem>  b = context.Tasks.Where(t => t.IsOpen);   // LINQ to Entities
```

| | `IEnumerable<T>` | `IQueryable<T>` |
|---|---|---|
| Lambda compiles to | a **delegate** (`Func<T,bool>`) | an **expression tree** (`Expression<Func<T,bool>>`) |
| Where the work happens | in your process, in .NET | wherever the provider sends it — usually SQL |
| Data transferred | all rows, then filtered | only matching rows |
| Operators available | everything in LINQ | only what the provider can translate |
| Namespace | `System.Linq.Enumerable` | `System.Linq.Queryable` |

The critical consequence:

```csharp
// IQueryable — filtering happens in SQL
IQueryable<TaskItem> q = context.Tasks;
var result = q.Where(t => t.IsOpen).Take(10).ToList();
// SELECT TOP 10 * FROM tasks WHERE status <> 3

// IEnumerable — filtering happens in memory, AFTER fetching everything
IEnumerable<TaskItem> e = context.Tasks;          // ← the type change is the bug
var result = e.Where(t => t.IsOpen).Take(10).ToList();
// SELECT * FROM tasks     ← all 4 million rows, over the network, then filtered
```

**Assigning an `IQueryable` to an `IEnumerable` variable silently moves the work from the database into your process.** Same code, same results, catastrophically different performance. It is a one-word change and there is no warning.

The same thing happens with `AsEnumerable()`, and with calling a method the provider cannot translate:

```csharp
context.Tasks.Where(t => MyHelper(t)).ToList();
// EF Core cannot translate MyHelper -> throws (in EF Core 3.0+) or silently
// evaluates client-side (older versions, which is worse)
```

::: predict How many times does the predicate run?
```csharp
var calls = 0;
var query = tasks.Where(t => { calls++; return t.IsOpen; });

var list = query.ToList();
var count = query.Count();
var first = query.First();
var any = query.Any();

Console.WriteLine(calls);
```
:::

::: solution
With six tasks, of which the first is open:

- `ToList()` — 6
- `Count()` — 6
- `First()` — 1 (stops at the first match)
- `Any()` — 1

Total: **14**.

If instead you had written `var list = query.ToList();` and then used `list.Count`, `list[0]` and `list.Count > 0`, the total would be **6**.

That is the whole argument for materialising once when you need the results more than once.
:::

::: exercise Level 1 — Guided · Prove each behaviour
Write a small program that demonstrates, with output, each of these:

1. A query built before an item is added includes that item when enumerated after.
2. A query enumerated three times runs its predicate three times.
3. Materialising with `ToList()` fixes (2).
4. Changing a captured variable after building a query changes the result.
5. `OrderBy` reads the entire source even when followed by `First()`.
6. `Take(2)` on an infinite sequence terminates; `Count()` on it does not (write it, then comment it out).

Keep this file. It is the best five minutes of revision available before an interview.
:::

::: challenge Level 3 · Build your own deferred operator
Implement `WhereWithStats<T>` that behaves exactly like `Where` but also reports, afterwards, how many elements it examined and how many it passed.

Requirements:
- Fully deferred — no work at call time.
- Correct when enumerated multiple times (the stats should reflect the *last* enumeration, and you must document that choice).
- Correct when enumeration stops early.
- Argument validation is eager.
- Works with `foreach` and with LINQ chaining.

Then answer: why is exposing mutable statistics from a lazy sequence a questionable design, and what would you do instead?
:::

::: solution
```csharp
public sealed class CountingFilter<T>(IEnumerable<T> source, Func<T, bool> predicate)
{
    public int Examined { get; private set; }
    public int Passed { get; private set; }

    public IEnumerable<T> Results => Iterate();

    private IEnumerable<T> Iterate()
    {
        Examined = Passed = 0;                  // reset per enumeration
        foreach (var item in source)
        {
            Examined++;
            if (!predicate(item)) continue;
            Passed++;
            yield return item;
        }
    }
}
```

**Why it is questionable:** the statistics are only meaningful *after* a complete enumeration, and the object cannot tell you whether that happened. Read them too early and they are partial; read them after a `Take(3)` and they describe a truncated run; enumerate twice concurrently and they are nonsense. The class has state whose validity depends on invisible timing.

What to do instead: return the statistics **with** the results, so they cannot be read at the wrong time:

```csharp
public static (IReadOnlyList<T> Results, int Examined) WhereCounting<T>(
    this IEnumerable<T> source, Func<T, bool> predicate)
{
    var results = new List<T>();
    var examined = 0;
    foreach (var item in source)
    {
        examined++;
        if (predicate(item)) results.Add(item);
    }
    return (results, examined);
}
```

This is eager, and that is the right call: **you cannot have both laziness and a complete summary of the work done.** Choosing eagerness here is not a compromise, it is the honest answer to the requirement.
:::

::: project Audit TaskFlow for deferred-execution bugs
Go through every method in your store and query extensions and classify each return type:

1. Does it return `IEnumerable<T>` or a materialised collection?
2. If lazy, can the caller enumerate it twice? What happens if they do?
3. If lazy, can the source be modified between construction and enumeration?

Then apply this policy and fix everything that violates it:

- **Internal composition helpers** (your query extensions): return `IEnumerable<T>`, stay lazy, so chains do not materialise at each step.
- **Anything a caller outside the store receives**: return `IReadOnlyList<T>`, materialised.
- **Anything with a `Page<T>`**: already materialised.

Add a comment at the top of `TaskQueryExtensions.cs` stating the policy, so the next person (you, in Phase 8) knows the rule.

Commit with a message naming at least one real bug you found.
:::

::: interview What is the difference between IEnumerable and IQueryable?
`IEnumerable<T>` represents an in-memory sequence; its LINQ operators take **delegates** and execute in your process, so filtering happens after the data is already loaded.

`IQueryable<T>` represents a query against a remote source; its operators take **expression trees** — data structures describing the lambda — which a provider such as EF Core translates into SQL and executes on the server. Only matching rows come back.

The practical trap worth volunteering: assigning an `IQueryable` to an `IEnumerable` variable, or calling `AsEnumerable()`, switches from server-side to client-side evaluation. The code compiles, the results are identical, and you have just moved a `WHERE` clause from the database into your application — which can mean fetching millions of rows to return ten.
:::

::: checkpoint
- [ ] I can list five deferred operators and five immediate ones
- [ ] I proved multiple enumeration with a counter and saw the number
- [ ] I can explain why returning a query from a method that disposed its context throws
- [ ] I can state the `IEnumerable` vs `IQueryable` difference in terms of delegates vs expression trees
- [ ] I audited TaskFlow's return types and wrote down the policy
:::

## Common mistakes

::: mistake
**Multiple enumeration.** `if (q.Any()) { foreach (var x in q) ... }` runs the query twice. Materialise once.

**Returning `IEnumerable<T>` from a repository.** The caller enumerates after the context is disposed, or enumerates twice and issues two queries.

**Assigning `IQueryable` to `var`... and then to `IEnumerable`.** Silent client-side evaluation.

**Calling `.ToList()` too early.** The mirror-image mistake: `context.Tasks.ToList().Where(...)` loads the whole table and filters in memory. Materialise *after* filtering, not before.

**Assuming `OrderBy` is cheap before `First()`.** It sorts everything. `MinBy`/`MaxBy` is one pass.
:::
