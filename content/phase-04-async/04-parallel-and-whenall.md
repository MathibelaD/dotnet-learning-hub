---
title: Parallel work, WhenAll and concurrency limits
summary: Doing several things at once safely — and knowing when concurrency is not the answer.
minutes: 40
stage: Stage 1
---

## What are we learning?

Running multiple async operations concurrently, aggregating their results and their failures, and limiting how many run at once.

## Sequential versus concurrent

```csharp
// Sequential: 3 × 100ms = 300ms
var a = await GetAsync(id1);
var b = await GetAsync(id2);
var c = await GetAsync(id3);

// Concurrent: ~100ms
var ta = GetAsync(id1);          // start all three
var tb = GetAsync(id2);
var tc = GetAsync(id3);
var results = await Task.WhenAll(ta, tb, tc);
```

The distinction: `await` **immediately** means "wait for this before doing anything else". Starting the tasks first and awaiting later means they overlap.

```csharp
var tasks = ids.Select(id => GetAsync(id));    // lazy! nothing started yet
var results = await Task.WhenAll(tasks);       // WhenAll enumerates, starting them all
```

::: warn `Select` is lazy — know where your tasks start
```csharp
var tasks = ids.Select(id => GetAsync(id));
foreach (var t in tasks) await t;       // ❌ SEQUENTIAL — each is created when enumerated
```
`Select` does not run anything (Phase 3, lesson 6). Each `GetAsync` is invoked as the `foreach` reaches it, so they run one at a time, exactly as if you had awaited in a loop.

Add `.ToList()` to force them all to start, or just use `Task.WhenAll`, which enumerates once:
```csharp
var tasks = ids.Select(GetAsync).ToList();     // all started
var results = await Task.WhenAll(tasks);
```
:::

## `Task.WhenAll`

```csharp
Task<TaskItem[]> all = Task.WhenAll(taskList);       // Task<T[]> when the tasks return values
await Task.WhenAll(voidTasks);                       // Task when they do not
```

Exception behaviour is the part people get wrong:

```csharp
try
{
    await Task.WhenAll(t1, t2, t3);
}
catch (Exception ex)
{
    // ex is the FIRST exception only — await unwraps AggregateException
}
```

To see all of them, inspect the task:

```csharp
var all = Task.WhenAll(tasks);
try
{
    await all;
}
catch
{
    foreach (var e in all.Exception!.InnerExceptions)
        logger.LogError(e, "one of the parallel operations failed");
}
```

And importantly: **`WhenAll` waits for every task even if one fails early.** It does not cancel the others. If you want that, pass a linked token and cancel it yourself.

## `Task.WhenAny`

```csharp
var completed = await Task.WhenAny(t1, t2, t3);       // the first to finish (or fail)
var result = await completed;                          // re-await to get its value/exception
```

Uses:

```csharp
// Timeout without cancellation support in the underlying call
var work = SlowOperationAsync();
if (await Task.WhenAny(work, Task.Delay(5000)) != work)
    throw new TimeoutException();

// Modern equivalent, much better:
await work.WaitAsync(TimeSpan.FromSeconds(5));       // .NET 6+
```

::: warn `WhenAny` leaves the losers running
The tasks you did not wait for keep going. If one of them later faults and nobody observes it, you have an unobserved exception. Always either await the rest, or attach a continuation, or cancel them with a linked token.
:::

## Limiting concurrency

Firing 10,000 requests at a database at once will not make it faster; it will make it fall over.

```csharp
using var limiter = new SemaphoreSlim(maxConcurrency: 10);

var tasks = ids.Select(async id =>
{
    await limiter.WaitAsync(ct);
    try { return await GetAsync(id, ct); }
    finally { limiter.Release(); }
});

var results = await Task.WhenAll(tasks);
```

Or, much more simply, the modern API:

```csharp
await Parallel.ForEachAsync(ids, new ParallelOptions
{
    MaxDegreeOfParallelism = 10,
    CancellationToken = ct
}, async (id, token) =>
{
    var task = await GetAsync(id, token);
    results.Add(task);            // ← needs a CONCURRENT collection, see below
});
```

`Parallel.ForEachAsync` (from .NET 6) handles the throttling, the cancellation and the exception aggregation. Prefer it.

## Shared state is where this goes wrong

```csharp
var results = new List<TaskItem>();
await Parallel.ForEachAsync(ids, async (id, ct) =>
{
    results.Add(await GetAsync(id, ct));    // ❌ List<T> is NOT thread-safe
});
```

`List<T>.Add` under concurrency produces: lost items, duplicated items, `IndexOutOfRangeException` from inside `Add`, or a corrupted internal array. It usually *seems* to work in testing, which is the worst property a bug can have.

```csharp
var results = new ConcurrentBag<TaskItem>();     // ✅ thread-safe
// or collect the results and aggregate afterwards:
var results = await Task.WhenAll(ids.Select(id => GetAsync(id, ct)));   // ✅ no shared state
```

The second is better: **avoiding shared mutable state beats synchronising it.** Phase 13 covers the concurrent collections properly.

## CPU-bound work: `Task.Run` and `Parallel.For`

```csharp
// Move CPU work off the current thread (useful in a UI app; rarely in a server)
var hash = await Task.Run(() => ComputeExpensiveHash(data));

// Use all cores for CPU work
Parallel.For(0, items.Length, i => Process(items[i]));
Parallel.ForEach(items, item => Process(item));
```

::: design Async, or parallel?
They solve different problems and people conflate them constantly.

**Async (`await`)** — for I/O. You are waiting on something external. The goal is to release the thread. One thread can service thousands of concurrent awaits.

**Parallel (`Task.Run`, `Parallel.For`)** — for CPU. You want several cores working at once. It uses more threads, not fewer.

In a web API:
- Async: yes, everywhere you do I/O.
- `Task.Run` around CPU work: usually **no**. The request is already on a thread pool thread; moving the work to another thread pool thread adds overhead and consumes a thread that could serve another request. It helps only if you need to return a response before the work finishes — and then it should be a background service (Phase 14).

In a desktop app, `Task.Run` is genuinely useful: it gets work off the UI thread so the interface stays responsive.
:::

::: predict How long does each take?
```csharp
// A
var sw = Stopwatch.StartNew();
foreach (var id in tenIds) await GetAsync(id);         // each takes 100ms

// B
await Task.WhenAll(tenIds.Select(GetAsync));

// C
foreach (var t in tenIds.Select(GetAsync)) await t;

// D
await Parallel.ForEachAsync(tenIds,
    new ParallelOptions { MaxDegreeOfParallelism = 3 },
    async (id, ct) => await GetAsync(id, ct));
```
:::

::: solution
- **A — ~1000ms.** Ten sequential 100ms calls.
- **B — ~100ms.** All ten start together.
- **C — ~1000ms.** The trap. `Select` is lazy, so each task is created as the loop reaches it. Identical to A despite looking like B.
- **D — ~400ms.** Ten items, three at a time: four batches of 100ms (3+3+3+1).

C is the one to burn in. It looks concurrent and is not, and nothing warns you.
:::

::: exercise Level 1 — Guided · Measure it yourself
Using your `SlowStore` with 100ms latency:

1. Fetch 10 tasks sequentially in a loop. Time it.
2. Fetch the same 10 with `Task.WhenAll`. Time it.
3. Write the buggy version C above. Time it. Confirm it matches (1).
4. Fetch them with `Parallel.ForEachAsync` at `MaxDegreeOfParallelism` of 2, 5 and 10. Time each.
5. Collect results into a `List<T>` from `Parallel.ForEachAsync` with 100 items and 10-way parallelism. Run it twenty times. Record how many runs produce the wrong count or throw.
6. Fix (5) with `ConcurrentBag<T>` and confirm it is stable over twenty runs.

Write all the numbers down. This exercise is worth more than the explanation.
:::

::: challenge Level 3 · A resilient batch processor
Build:

```csharp
Task<BatchResult<TIn, TOut>> ProcessBatchAsync<TIn, TOut>(
    IEnumerable<TIn> items,
    Func<TIn, CancellationToken, Task<TOut>> processor,
    BatchOptions options,
    CancellationToken ct = default);
```

Requirements:
- Configurable max concurrency.
- Per-item timeout.
- Per-item retry with backoff (reuse your `RetryAsync`).
- One item failing does **not** stop the batch.
- The result reports successes with their outputs, and failures with the item and its exception.
- Optional fail-fast mode: on the first failure, cancel everything still running.
- Progress reporting.
- Correct under cancellation at any point.

This is a genuinely useful piece of code. You will reuse it in Phase 14.
:::

::: solution
```csharp
public sealed record BatchOptions
{
    public int MaxConcurrency { get; init; } = 8;
    public TimeSpan ItemTimeout { get; init; } = TimeSpan.FromSeconds(30);
    public int MaxAttempts { get; init; } = 1;
    public bool FailFast { get; init; }
}

public sealed record BatchResult<TIn, TOut>(
    IReadOnlyList<(TIn Item, TOut Result)> Succeeded,
    IReadOnlyList<(TIn Item, Exception Error)> Failed,
    bool Cancelled);

public static async Task<BatchResult<TIn, TOut>> ProcessBatchAsync<TIn, TOut>(
    IEnumerable<TIn> items,
    Func<TIn, CancellationToken, Task<TOut>> processor,
    BatchOptions options,
    IProgress<(int done, int failed)>? progress = null,
    CancellationToken ct = default)
{
    var succeeded = new ConcurrentBag<(TIn, TOut)>();
    var failed = new ConcurrentBag<(TIn, Exception)>();
    var done = 0;

    using var batchCts = CancellationTokenSource.CreateLinkedTokenSource(ct);

    try
    {
        await Parallel.ForEachAsync(items,
            new ParallelOptions
            {
                MaxDegreeOfParallelism = options.MaxConcurrency,
                CancellationToken = batchCts.Token
            },
            async (item, token) =>
            {
                using var itemCts = CancellationTokenSource.CreateLinkedTokenSource(token);
                itemCts.CancelAfter(options.ItemTimeout);

                try
                {
                    var result = await RetryAsync(
                        () => processor(item, itemCts.Token), options.MaxAttempts);
                    succeeded.Add((item, result));
                }
                catch (Exception ex) when (!ct.IsCancellationRequested)
                {
                    failed.Add((item, ex));
                    if (options.FailFast) await batchCts.CancelAsync();
                }
                finally
                {
                    progress?.Report((Interlocked.Increment(ref done), failed.Count));
                }
            });
    }
    catch (OperationCanceledException)
    {
        return new BatchResult<TIn, TOut>([.. succeeded], [.. failed],
            Cancelled: ct.IsCancellationRequested);
    }

    return new BatchResult<TIn, TOut>([.. succeeded], [.. failed], Cancelled: false);
}
```

Details worth noticing:

- **Two linked token sources.** `batchCts` lets fail-fast cancel the whole batch; `itemCts` adds the per-item timeout on top. Each layer adds one reason to stop without losing the others.
- **`when (!ct.IsCancellationRequested)`** again — distinguishing the caller cancelling from an item failing.
- **`Interlocked.Increment(ref done)`** because `done++` from ten threads loses increments (Phase 1's static counter bug, now at scale).
- **`[.. succeeded]`** is a collection expression with a spread — it materialises the `ConcurrentBag` into an array. Reading a bag while items are still being added would give an inconsistent snapshot, which is fine here because everything has finished.
- **`await batchCts.CancelAsync()`** rather than `Cancel()`: `Cancel()` runs registered callbacks synchronously on the calling thread, which can deadlock if a callback blocks. `CancelAsync` (from .NET 8) does not.
:::

::: project Parallelise TaskFlow's import
1. Rewrite the importer with `Parallel.ForEachAsync`, max concurrency configurable via `--concurrency` (default 4).
2. Use your `ProcessBatchAsync` if you built it.
3. Prove correctness: import 5,000 tasks and confirm the store ends up with exactly 5,000. Run it ten times.
4. Make the in-memory store thread-safe — `Dictionary<Guid, TaskItem>` is not. Swap it for `ConcurrentDictionary`, then verify (3) again.
5. Benchmark concurrency 1, 2, 4, 8, 16, 32 against your `SlowStore`. Plot the numbers in `DECISIONS.md` and explain where the curve flattens and why.
6. Add `--fail-fast`.

Commit.
:::

::: solution What the benchmark should show
With a fixed 50ms simulated latency and 5,000 items you should see roughly: 1 → 250s, 2 → 125s, 4 → 62s, 8 → 31s, 16 → 16s, 32 → 8s. Near-linear, because the work is pure waiting and adding waiters costs almost nothing.

Against a **real** database the curve flattens and then reverses — typically somewhere between 10 and 50, depending on the connection pool size (the default for Npgsql is 100) and what the server can take. Past that point you are queuing on the pool, and past a further point you are causing lock contention in the database itself.

The lesson: **concurrency is not free and more is not better.** The right number comes from measuring against the real dependency, and it belongs in configuration, not in a constant. This is why Phase 14 covers rate limiting from the *client* side as well as the server side.
:::

::: interview How do you run multiple async operations concurrently?
Start them without awaiting, then await the collection: `var tasks = ids.Select(GetAsync).ToList(); await Task.WhenAll(tasks);`. Awaiting immediately inside a loop is sequential.

The trap worth mentioning is that `Select` is lazy — `foreach (var t in ids.Select(GetAsync)) await t;` creates each task as the loop reaches it, so it runs sequentially despite looking parallel.

For anything more than a handful, add a concurrency limit — `Parallel.ForEachAsync` with `MaxDegreeOfParallelism`, or a `SemaphoreSlim` — because firing thousands of concurrent requests at a database exhausts the connection pool. And any shared collection written from concurrent tasks must be a concurrent type, or better, avoided by having each task return its result.
:::

::: checkpoint
- [ ] I measured sequential vs `WhenAll` vs the lazy-`Select` trap myself
- [ ] I reproduced `List<T>` corruption under concurrency
- [ ] I know `WhenAll` surfaces only the first exception when awaited
- [ ] I can explain the difference between async and parallel
- [ ] TaskFlow's import is concurrent, thread-safe and benchmarked
:::

## Common mistakes

::: mistake
**`foreach (var t in items.Select(DoAsync)) await t;`** — sequential, not concurrent.

**Unbounded `Task.WhenAll` over thousands of items.** Exhausts the connection pool or gets you rate-limited.

**Writing to a `List<T>` or `Dictionary` from parallel tasks.** Corruption that passes testing.

**`Task.Run` in an ASP.NET Core action.** Adds overhead and steals a pool thread for no benefit.

**Ignoring the losers from `WhenAny`.** Unobserved exceptions and wasted work.
:::
