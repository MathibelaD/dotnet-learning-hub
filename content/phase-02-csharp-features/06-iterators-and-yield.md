---
title: Iterators and yield
summary: Producing a sequence lazily — what `yield return` compiles to and why it changes performance.
minutes: 30
stage: Stage 1
---

## What are we learning?

`yield return`, lazy evaluation, and the state machine the compiler builds for you. This is the mechanism underneath LINQ, and understanding it is what makes Phase 3's "deferred execution" obvious rather than mysterious.

## The problem

```csharp
// Eager: builds the whole list before returning anything
IReadOnlyList<TaskItem> GetOverdue(IEnumerable<TaskItem> tasks, DateOnly today)
{
    var result = new List<TaskItem>();
    foreach (var t in tasks)
        if (t.IsOverdue(today)) result.Add(t);
    return result;
}
```

If there are a million tasks and the caller only wants the first five, you did a million comparisons and allocated a list of every match.

```csharp
// Lazy: produces one item at a time, on demand
IEnumerable<TaskItem> GetOverdue(IEnumerable<TaskItem> tasks, DateOnly today)
{
    foreach (var t in tasks)
        if (t.IsOverdue(today))
            yield return t;
}
```

Now `GetOverdue(tasks, today).Take(5)` stops after finding five.

## What `yield` actually does

A method containing `yield return` is not a normal method. The compiler rewrites it into a **state machine class** implementing `IEnumerable<T>` and `IEnumerator<T>`, where:

- The method body becomes a `MoveNext()` method with a `switch` on a state field.
- Local variables become fields on the generated class.
- `yield return x` sets `Current = x`, records the state, and returns `true`.
- `yield break` returns `false`.

Two consequences that surprise people:

::: warn Nothing runs until you enumerate
```csharp
IEnumerable<int> Numbers()
{
    Console.WriteLine("starting");
    yield return 1;
}

var seq = Numbers();               // prints NOTHING
Console.WriteLine("created");
foreach (var n in seq) { }         // NOW it prints "starting"
```

Output:
```text
created
starting
```

Calling the method only constructs the state machine. The body runs during enumeration.

**This is why argument validation in an iterator is a bug:**
```csharp
IEnumerable<T> Page<T>(IEnumerable<T> source, int size)
{
    ArgumentOutOfRangeException.ThrowIfNegativeOrZero(size);   // ❌ throws at enumeration,
    foreach (...) yield return ...;                            //    not at the call
}
```
The caller passes `size: -1`, gets no exception, stores the sequence, and it blows up somewhere completely unrelated. The fix is the standard two-method split:
```csharp
IEnumerable<T> Page<T>(IEnumerable<T> source, int size)
{
    ArgumentNullException.ThrowIfNull(source);
    ArgumentOutOfRangeException.ThrowIfNegativeOrZero(size);
    return Iterate(source, size);          // eager validation here

    static IEnumerable<T> Iterate(IEnumerable<T> source, int size) { ... yield ... }
}
```
Every LINQ operator in the BCL is written this way. Now you know why.
:::

::: warn Enumerating twice runs it twice
```csharp
var overdue = GetOverdue(tasks, today);
Console.WriteLine(overdue.Count());     // full pass
Console.WriteLine(overdue.Count());     // ANOTHER full pass
foreach (var t in overdue) { }          // and another
```
If the source is a database query or a file read, you just did the work three times. When you need the results more than once, materialise: `.ToList()`.
:::

## `yield break` and infinite sequences

```csharp
IEnumerable<int> Fibonacci()
{
    var (a, b) = (0, 1);
    while (true)
    {
        yield return a;
        (a, b) = (b, a + b);
    }
}

foreach (var n in Fibonacci().Take(10)) Console.Write($"{n} ");   // 0 1 1 2 3 5 8 13 21 34
```

An infinite sequence is fine because nothing is computed until requested. `Take(10)` stops asking, so the loop stops running. Calling `.ToList()` on it would hang forever.

```csharp
IEnumerable<TaskItem> UntilFirstBlocked(IEnumerable<TaskItem> tasks)
{
    foreach (var t in tasks)
    {
        if (t.Status is TaskStatus.Blocked) yield break;   // stop producing
        yield return t;
    }
}
```

## Restrictions

A method with `yield` cannot have `ref`/`out`/`in` parameters, cannot be `unsafe`, cannot `yield` inside a `try` with a `catch` (a `try`/`finally` is allowed), and must return `IEnumerable<T>`, `IEnumerator<T>`, or the non-generic versions. For async, use `IAsyncEnumerable<T>` with `await foreach` — Phase 4.

::: predict Count the "checking" lines
```csharp
IEnumerable<int> Evens(IEnumerable<int> source)
{
    foreach (var n in source)
    {
        Console.WriteLine($"checking {n}");
        if (n % 2 == 0) yield return n;
    }
}

var result = Evens([1, 2, 3, 4, 5, 6]).Take(2).ToList();
Console.WriteLine($"got {result.Count}");
```
How many "checking" lines appear, and which numbers?
:::

::: solution
```text
checking 1
checking 2
checking 3
checking 4
got 2
```

Four, not six. `Take(2)` stops pulling once it has two items, so `Evens` never examines 5 or 6.

This is the entire value proposition of lazy sequences: **work is done on demand, and unneeded work is never done.** It is also why `Take` before an expensive operation and `Where` before `Select` change performance in LINQ, which is the next phase.

Trace the flow once, properly: `ToList` pulls from `Take`, `Take` pulls from `Evens`, `Evens` pulls from the array. Each item is pulled all the way through the chain before the next one starts. Nothing is buffered between stages. Hold that picture — it explains every LINQ behaviour you will meet.
:::

::: exercise Level 1 — Guided · Write five iterators
No LINQ allowed. Use `yield return` for each.

1. `IEnumerable<T> TakeWhile<T>(IEnumerable<T> source, Func<T, bool> predicate)`
2. `IEnumerable<T> Interleave<T>(IEnumerable<T> a, IEnumerable<T> b)` — alternates, stops when either runs out
3. `IEnumerable<IReadOnlyList<T>> Windowed<T>(IEnumerable<T> source, int size)` — sliding windows: `[1,2,3,4]` with size 2 gives `[1,2] [2,3] [3,4]`
4. `IEnumerable<DateOnly> DaysBetween(DateOnly from, DateOnly to)`
5. `IEnumerable<TaskItem> Flatten(IEnumerable<Project> projects)` — every task across every project

For (2) you will need to call `GetEnumerator()` and `MoveNext()` by hand. That is the point — do it once and `foreach` will never be mysterious again.
:::

::: solution
```csharp
static IEnumerable<T> Interleave<T>(IEnumerable<T> a, IEnumerable<T> b)
{
    ArgumentNullException.ThrowIfNull(a);
    ArgumentNullException.ThrowIfNull(b);
    return Iterate(a, b);

    static IEnumerable<T> Iterate(IEnumerable<T> a, IEnumerable<T> b)
    {
        using var ea = a.GetEnumerator();
        using var eb = b.GetEnumerator();

        while (ea.MoveNext() && eb.MoveNext())
        {
            yield return ea.Current;
            yield return eb.Current;
        }
    }
}
```

`using var` on the enumerators matters: `IEnumerator<T>` is `IDisposable`, and for a database or file-backed sequence, disposal is what releases the connection or handle. `foreach` does this for you automatically — when you enumerate by hand, you have to.

```csharp
static IEnumerable<IReadOnlyList<T>> Windowed<T>(IEnumerable<T> source, int size)
{
    var window = new Queue<T>(size);
    foreach (var item in source)
    {
        window.Enqueue(item);
        if (window.Count < size) continue;
        yield return window.ToArray();      // copy — the queue keeps changing
        window.Dequeue();
    }
}
```

`window.ToArray()` is the important line. Yielding the `Queue` itself would hand every caller the same mutating object, and by the time they looked at it the contents would have moved on. Returning a live view of mutable internal state is a bug that is extremely hard to diagnose because the value is correct at the moment it is produced.
:::

::: challenge Level 3 · A streaming report
Write a method that reads a large file of task records (one JSON object per line) and produces `IEnumerable<TaskItem>` **without loading the file into memory**.

Requirements:
- Works on a file too big to fit in RAM.
- The file handle is closed when enumeration finishes *or* when the caller stops early (`.Take(5)`).
- A malformed line is skipped, with a count of skipped lines available to the caller afterwards.
- Argument validation happens eagerly.

Generate a test file of 500,000 lines and prove that `.Take(5)` returns immediately rather than reading the whole file. Measure it.
:::

::: solution
```csharp
public sealed class TaskFileReader(string path)
{
    public int SkippedLines { get; private set; }

    public IEnumerable<TaskItem> Read()
    {
        if (!File.Exists(path)) throw new FileNotFoundException(path);
        return Iterate();
    }

    private IEnumerable<TaskItem> Iterate()
    {
        using var reader = new StreamReader(path);      // 'finally' from using runs on early exit
        while (reader.ReadLine() is { } line)
        {
            TaskItem? task = null;
            try { task = JsonSerializer.Deserialize<TaskItem>(line); }
            catch (JsonException) { SkippedLines++; }

            if (task is not null) yield return task;
        }
    }
}
```

Two things worth dwelling on:

**`using` inside an iterator works correctly on early exit.** When the caller abandons enumeration, `foreach` disposes the enumerator, which resumes the state machine in its `finally` blocks — closing the `StreamReader`. This is why `IEnumerator<T>` implements `IDisposable` and why `foreach` disposes it. Without that mechanism, `.Take(5)` over a file would leak a handle every time.

**The `try`/`catch` is outside the `yield return`.** You cannot `yield return` inside a `try` block that has a `catch` — the compiler forbids it (`CS1626`), because the state machine cannot resume into a half-unwound exception context. Deserialise into a local inside the `try`, then yield outside it.

`while (reader.ReadLine() is { } line)` is a pattern-matched read loop: `is { }` means "is not null", and it declares `line` at the same time. Cleaner than `while ((line = reader.ReadLine()) != null)`.
:::

::: project Make TaskFlow's store stream
1. Change your query extensions so they are all `IEnumerable<TaskItem>` returning, lazily.
2. Add `IEnumerable<TaskItem> StreamAll()` to the store, using `yield return` over the dictionary values.
3. Add an import command that reads tasks from a JSON-lines file lazily and adds them.
4. Add an export command that writes them out, streaming, without building a big string.
5. Prove the laziness: add a `Console.WriteLine` inside the iterator and run a query with `.Take(3)`. Count the lines.

Then answer in `DECISIONS.md`: where in TaskFlow is laziness **wrong**, and why? (Hint: think about what happens when the store is mutated while a lazy sequence over it is still being enumerated.)

Commit.
:::

::: solution The DECISIONS.md answer
Laziness is wrong wherever the caller might enumerate after the underlying data has changed. Specifically:

`IEnumerable<TaskItem> StreamAll()` over `_tasks.Values` throws `InvalidOperationException: Collection was modified` if anything adds a task while a caller is still enumerating. A method returning `IReadOnlyList<TaskItem>` built with `.ToList()` takes a snapshot and is safe.

The same problem with a bigger blast radius appears in Phase 7: returning a lazy `IQueryable` out of a repository means the query executes at the call site, possibly after the `DbContext` has been disposed — producing `ObjectDisposedException` in a completely unrelated part of the application.

The rule that follows: **lazy inside a pipeline, eager at the boundary.** Compose lazily for as long as you are still building the query; materialise with `.ToList()` before handing results to another layer.
:::

::: interview What does `yield return` do?
It turns the method into an iterator: the compiler generates a state machine class implementing `IEnumerable<T>`/`IEnumerator<T>`, where local variables become fields and the method body becomes `MoveNext()`. Each `yield return` sets `Current` and saves the position so execution resumes there on the next call.

The practical consequences: nothing in the method body runs until enumeration begins (so argument validation must go in a separate non-iterator wrapper), the sequence can be infinite, enumerating twice runs the body twice, and `foreach` disposing the enumerator is what lets `using` inside an iterator release resources when a caller stops early.
:::

::: checkpoint
- [ ] I can explain why an iterator's argument validation must be split into two methods
- [ ] I predicted the "checking" output correctly
- [ ] I wrote `Interleave` with manual `GetEnumerator()` and `using`
- [ ] I proved laziness by measuring `.Take(5)` over a 500,000-line file
- [ ] I can state where laziness is wrong and why
:::

## Common mistakes

::: mistake
**Validating arguments inside an iterator.** The exception surfaces at a random later point, far from the bug.

**Enumerating an `IEnumerable` several times without realising.** `if (seq.Any()) return seq.First();` runs the sequence twice. `seq.Count()` after a `foreach` runs it again.

**Returning a lazy sequence from a repository or service.** The consumer enumerates it after the connection, transaction or context is gone.

**Yielding a mutable object you keep changing.** Every consumer sees the same object, whose contents have since moved on. Yield a copy.
:::
