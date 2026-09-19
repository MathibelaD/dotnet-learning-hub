---
title: Async streams, ValueTask and async exceptions
summary: IAsyncEnumerable, await foreach, when ValueTask is worth it, and how exceptions really flow through tasks.
minutes: 40
stage: Stage 1
---

## What are we learning?

The remaining async machinery you will actually meet: streaming results, the cheaper task type, and exactly when an async exception is thrown.

## `IAsyncEnumerable<T>` — lazy, but async

Phase 2's iterators were synchronous: `yield return` could not sit next to `await`. `IAsyncEnumerable<T>` fixes that.

```csharp
public async IAsyncEnumerable<TaskItem> StreamAsync(
    [EnumeratorCancellation] CancellationToken ct = default)
{
    var page = 0;
    while (true)
    {
        var batch = await _repo.GetPageAsync(page++, 100, ct);   // await
        if (batch.Count == 0) yield break;

        foreach (var task in batch)
            yield return task;                                   // and yield
    }
}
```

Consumed with `await foreach`:

```csharp
await foreach (var task in store.StreamAsync(ct))
{
    Console.WriteLine(task.Title);
    if (task.Priority == Priority.Urgent) break;   // stops fetching further pages
}
```

::: warn `[EnumeratorCancellation]` is not optional
Without that attribute, the token passed to `StreamAsync(ct)` is *not* the token the enumerator uses, and `WithCancellation` has no effect:

```csharp
await foreach (var t in store.StreamAsync().WithCancellation(ct))
```

The attribute tells the compiler to forward the token from `GetAsyncEnumerator(ct)` into your parameter. Forget it and you get a cancellable-looking stream that cannot be cancelled. The analyser `CA2015`... does not exist for this, unfortunately — you have to remember.
:::

### When to use it

Good: paging through a large result set, reading a file line by line, consuming a message stream, server-sent events.

Not needed: anything that fits comfortably in memory. `Task<IReadOnlyList<T>>` is simpler and often faster, because a streaming enumerator has per-item overhead.

## `ValueTask<T>`

```csharp
public ValueTask<TaskItem?> GetAsync(Guid id)
{
    if (_cache.TryGetValue(id, out var cached))
        return new ValueTask<TaskItem?>(cached);       // no allocation at all

    return new ValueTask<TaskItem?>(LoadAsync(id));    // wraps a real Task
}
```

`Task<T>` is a class — every async call that actually suspends allocates one. `ValueTask<T>` is a struct, so when the result is already available there is no allocation.

::: design When ValueTask is worth it
Use it when **all three** are true:
1. The method is called very frequently (a hot path).
2. It usually completes synchronously — a cache hit, a buffer that already has data.
3. You have measured that the allocation matters.

Otherwise use `Task<T>`. `ValueTask` comes with real restrictions that `Task` does not have:

- **Await it at most once.** Awaiting twice is undefined behaviour.
- **Do not** call `.Result` on an incomplete one.
- **Do not** await it concurrently from several places.
- If you need any of those, call `.AsTask()` first.

This is why `IAsyncEnumerable<T>.MoveNextAsync()` returns `ValueTask<bool>` — it is called once per element, and often the next element is already buffered.
:::

## How exceptions flow

```csharp
static async Task<int> FailAsync()
{
    throw new InvalidOperationException("boom");
}

var task = FailAsync();          // does NOT throw here — the exception is captured
Console.WriteLine("still running");
var value = await task;          // throws HERE
```

An exception inside an async method is **captured in the returned task**, not thrown at the call site. It surfaces when you await.

There is one exception to that rule, and it catches people:

```csharp
static Task<int> FailFast(string s)
{
    ArgumentNullException.ThrowIfNull(s);     // NOT async — throws immediately
    return DoWorkAsync(s);
}
```

Because `FailFast` is not `async`, the guard throws synchronously, before any task exists. Whether validation throws at call time or at await time depends on whether the method is marked `async`. For an API others consume, being consistent matters — and this is another reason the two-method split from Phase 2's iterators shows up in async code too.

## Exception handling patterns

```csharp
// Normal — reads exactly like synchronous code
try
{
    var task = await _repo.GetAsync(id, ct);
}
catch (TaskNotFoundException ex)
{
    // the real exception type, unwrapped by await
}
catch (OperationCanceledException) when (ct.IsCancellationRequested)
{
    // expected, not an error
}
finally
{
    // runs after the continuation resumes
}
```

```csharp
// Several tasks: await unwraps only the FIRST failure
var all = Task.WhenAll(tasks);
try { await all; }
catch
{
    foreach (var e in all.Exception!.InnerExceptions) Log(e);
}
```

```csharp
// Unobserved exceptions — a task that faults and is never awaited
TaskScheduler.UnobservedTaskException += (_, e) =>
{
    logger.LogError(e.Exception, "unobserved task exception");
    e.SetObserved();
};
```

That last handler is worth adding to any long-running application. Since .NET 4.5 an unobserved exception no longer crashes the process — it is silently dropped when the task is garbage collected, which means a whole class of failure can be invisible. The handler makes it visible.

::: predict When does "caught" print?
```csharp
Console.WriteLine("A");
var t = ThrowAsync();
Console.WriteLine("B");
try { await t; } catch { Console.WriteLine("caught"); }
Console.WriteLine("C");

static async Task ThrowAsync()
{
    Console.WriteLine("1");
    await Task.Delay(10);
    Console.WriteLine("2");
    throw new Exception();
}
```
:::

::: solution
```text
A
1
B
2
caught
C
```

`ThrowAsync` runs synchronously to the first suspending await, printing "1". Control returns to the caller, which prints "B". After the delay the method resumes, prints "2", then throws — and the exception is stored in the task. The `await` at the `try` re-throws it, so "caught" prints.

Nothing is thrown at the `var t = ThrowAsync();` line, even though that is where the exception "happens" in the source order. This is why a `try` wrapped around the *call* but not the *await* catches nothing.
:::

::: exercise Level 1 — Guided · Stream and handle
1. Add `IAsyncEnumerable<TaskItem> StreamAsync([EnumeratorCancellation] CancellationToken ct)` to your store, yielding in pages of 50 with a simulated 20ms delay per page.
2. Consume it with `await foreach` and `break` after 10 items. Count how many pages were actually fetched. (One.)
3. Remove `[EnumeratorCancellation]` and confirm `.WithCancellation(ct)` stops working.
4. Write an async method that throws, call it without awaiting, and confirm nothing happens. Then await it.
5. Register `TaskScheduler.UnobservedTaskException` and prove it fires — you will need `GC.Collect(); GC.WaitForPendingFinalizers();` to force it.
6. Write a `ValueTask<TaskItem?>` cache-first lookup and confirm the cache-hit path allocates nothing (use `GC.GetAllocatedBytesForCurrentThread()` before and after).
:::

::: challenge Level 3 · A streaming, cancellable, resumable export
Build an exporter that writes every task to a JSON-lines file.

Requirements:
- Source is `IAsyncEnumerable<TaskItem>`; the whole set never exists in memory at once.
- Writes are buffered and flushed every 1,000 records.
- Cancellable at any point; the file is flushed and closed cleanly, and the caller learns how many records were written.
- On restart with `--resume`, it skips records already written (count the lines in the existing file).
- `IAsyncDisposable` on the exporter so `await using` releases the file handle.
- One malformed record does not abort the export.

Then measure peak memory while exporting 1,000,000 generated tasks. It should be roughly flat.
:::

::: solution
```csharp
public sealed class TaskExporter(string path) : IAsyncDisposable
{
    private StreamWriter? _writer;

    public async Task<int> ExportAsync(
        IAsyncEnumerable<TaskItem> source, int skip = 0, CancellationToken ct = default)
    {
        _writer = new StreamWriter(path, append: skip > 0);
        var written = 0;
        var seen = 0;

        try
        {
            await foreach (var task in source.WithCancellation(ct))
            {
                if (seen++ < skip) continue;

                try
                {
                    await _writer.WriteLineAsync(JsonSerializer.Serialize(task).AsMemory(), ct);
                    if (++written % 1000 == 0) await _writer.FlushAsync(ct);
                }
                catch (JsonException) { /* skip malformed, keep going */ }
            }
        }
        finally
        {
            if (_writer is not null) await _writer.FlushAsync(CancellationToken.None);
        }

        return written;
    }

    public async ValueTask DisposeAsync()
    {
        if (_writer is not null) await _writer.DisposeAsync();
    }
}
```

Two details that make the difference between working and nearly working:

**`await _writer.FlushAsync(CancellationToken.None)` in the `finally`.** Using `ct` there would be wrong — the token is already cancelled, so the flush would be skipped and the last buffered records lost. Cleanup must not be cancellable by the thing that triggered the cleanup. This is a general rule: **pass `CancellationToken.None` to cleanup operations.**

**`IAsyncDisposable` rather than `IDisposable`.** `StreamWriter.Dispose()` flushes synchronously, blocking a thread. `DisposeAsync` does it properly. Anything holding an async resource should implement `IAsyncDisposable` and be consumed with `await using`. Phase 13 goes deeper.

Memory stays flat because nothing is ever materialised: the source yields one task at a time, and the writer's buffer is bounded.
:::

::: project Streaming for TaskFlow
1. Add `IAsyncEnumerable<TaskItem> StreamAsync` to your store.
2. Rewrite `export` to stream, with `await using`.
3. Rewrite `import` to read as `IAsyncEnumerable<string>` (`File.ReadLinesAsync` gives you one directly).
4. Register `TaskScheduler.UnobservedTaskException` in `Main` and log through it.
5. Export 1,000,000 generated tasks. Record peak memory in `DECISIONS.md` and compare with a non-streaming version that builds a `List<TaskItem>` first.

Commit. Phase 4 is done: TaskFlow is now fully async, cancellable, concurrent and streaming.
:::

::: interview What is the difference between Task and ValueTask?
`Task<T>` is a reference type, so every asynchronous operation that actually suspends allocates one. `ValueTask<T>` is a struct that can wrap either an already-available result — allocating nothing — or a real `Task<T>` when the operation does suspend.

You use `ValueTask` on hot paths that usually complete synchronously, such as a cache-first lookup or `IAsyncEnumerable.MoveNextAsync`. The cost is a stricter contract: you may await it only once, you must not block on it, and you cannot await it from multiple places. If you need any of that, call `.AsTask()`.

The default should stay `Task<T>` unless you have measured the allocation to be a problem.
:::

::: checkpoint Phase 4 complete
- [ ] I wrote an `IAsyncEnumerable` with `[EnumeratorCancellation]` and proved the attribute matters
- [ ] I know exactly when an async exception is thrown
- [ ] I registered an unobserved-exception handler and saw it fire
- [ ] I can state the three `ValueTask` restrictions
- [ ] TaskFlow streams import and export with flat memory usage
- [ ] I can explain async, cancellation and concurrency to someone else without notes
:::

## Common mistakes

::: mistake
**Forgetting `[EnumeratorCancellation]`.** A stream that quietly ignores cancellation.

**Awaiting a `ValueTask` twice.** Undefined behaviour, and no exception tells you.

**Cancellable cleanup.** Passing the already-cancelled token to a flush or a dispose, so cleanup is skipped exactly when it is needed.

**`try` around the call instead of around the `await`.** Catches nothing.

**Assuming an unawaited faulted task will crash something.** It fails silently. Register the handler.
:::
