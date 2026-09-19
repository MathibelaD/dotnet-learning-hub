---
title: Cancellation
summary: CancellationToken — how to accept one, how to honour it, and how to create one.
minutes: 35
stage: Stage 1
---

## What are we learning?

Cooperative cancellation: the .NET mechanism for stopping work that is no longer needed. This is not optional polish — in a web API, every abandoned request that keeps running is capacity you are giving away.

## Cooperative means the code must check

There is no way to forcibly abort a task in .NET. (`Thread.Abort` existed and was removed because it corrupted state.) Cancellation works because **the running code agrees to check**.

```csharp
public async Task<IReadOnlyList<TaskItem>> SearchAsync(TaskQuery query, CancellationToken ct)
{
    ct.ThrowIfCancellationRequested();              // check at entry

    var results = new List<TaskItem>();
    foreach (var batch in batches)
    {
        ct.ThrowIfCancellationRequested();          // check each iteration
        results.AddRange(await LoadAsync(batch, ct)); // pass it down
    }
    return results;
}
```

Three things happen in that method, and all three are required:

1. **Check** at the start and in loops.
2. **Pass** the token to everything you call.
3. **Throw** `OperationCanceledException` — that is the agreed signal, not a `return`.

## Accepting a token

```csharp
public Task<TaskItem?> GetAsync(Guid id, CancellationToken ct = default)
```

Convention: last parameter, named `cancellationToken` or `ct`, defaulted to `default` (which is `CancellationToken.None` — a token that never cancels).

**Every async method you write should accept one.** Adding it later means changing every signature and every call site, which is exactly why lesson 1 told you to add them before they did anything.

## Creating one

```csharp
using var cts = new CancellationTokenSource();
var task = LongRunningAsync(cts.Token);

cts.Cancel();                                       // cancel manually

using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));   // auto-cancel
timeout.CancelAfter(TimeSpan.FromSeconds(2));       // or change it later

// combine several tokens — cancels when ANY of them cancels
using var linked = CancellationTokenSource.CreateLinkedTokenSource(requestToken, timeout.Token);
```

The linked source is the pattern you will use in an API: cancel when the client disconnects **or** when your own timeout fires.

## Responding to cancellation

```csharp
try
{
    await ProcessAsync(ct);
}
catch (OperationCanceledException) when (ct.IsCancellationRequested)
{
    logger.LogInformation("Cancelled by caller");
    // do NOT treat this as an error — it is the expected outcome
}
```

::: warn `OperationCanceledException` is not a failure
When a user closes their browser tab, ASP.NET Core cancels the request token. Your handler throws `OperationCanceledException`. If your error middleware logs that as an error and returns a 500, your dashboards fill with fake errors caused by people navigating away.

Handle it distinctly. In Phase 6 you map it to HTTP 499 (client closed request) and log it at information level.

Note also: `TaskCanceledException` derives from `OperationCanceledException`, so catching the base type covers both.
:::

## Registering a callback

```csharp
using var registration = ct.Register(() => Console.WriteLine("cancelling…"));
```

Useful for releasing an external resource when cancellation arrives. Dispose the registration when you are done, or you leak it — for a long-lived token, every un-disposed registration stays attached.

## Where the token comes from

| Context | Source |
|---|---|
| ASP.NET Core action | `HttpContext.RequestAborted`, or just add a `CancellationToken` parameter and it is injected |
| Background service | `stoppingToken` passed to `ExecuteAsync` |
| Console app | `Console.CancelKeyPress`, or `PosixSignalRegistration` |
| Test | `new CancellationTokenSource(timeout).Token` |
| Nothing to cancel | `CancellationToken.None` |

::: predict What happens?
```csharp
using var cts = new CancellationTokenSource(100);

try
{
    await Task.Delay(1000, cts.Token);
    Console.WriteLine("finished");
}
catch (OperationCanceledException)
{
    Console.WriteLine("cancelled");
}

// and this one?
using var cts2 = new CancellationTokenSource(100);
try
{
    await Task.Delay(1000);                 // no token passed
    Console.WriteLine("finished");
}
catch (OperationCanceledException)
{
    Console.WriteLine("cancelled");
}
```
:::

::: solution
First: `cancelled` after ~100ms.
Second: `finished` after the full 1000ms.

The second `Task.Delay` was never given the token, so nothing can cancel it. The `CancellationTokenSource` fires, and nothing is listening.

**This is the most common cancellation bug: accepting a token and forgetting to pass it down.** The signature promises cancellability, the behaviour does not deliver it, and there is no compiler warning. Analyser rule `CA2016` catches it — turn it on.
:::

::: exercise Level 1 — Guided · Make things cancellable
1. Write `async Task<int> CountSlowlyAsync(int to, CancellationToken ct)` that delays 100ms per number, checks the token each iteration, and returns how far it got.
2. Call it with a 500ms timeout and confirm it stops around 5.
3. Write a version that **swallows** `OperationCanceledException` and returns the partial count instead of throwing. Decide which behaviour is correct for a "count" operation and why.
4. Use `CreateLinkedTokenSource` to combine a 300ms timeout with a manual `cts`. Cancel manually before the timeout and confirm it stops.
5. Add `ct.Register(() => Console.WriteLine("cleanup"))` and confirm it fires.
6. Add the analyser and prove it catches a missing token:
   ```ini
   dotnet_diagnostic.CA2016.severity = error
   ```
:::

::: solution
```csharp
static async Task<int> CountSlowlyAsync(int to, CancellationToken ct)
{
    var reached = 0;
    for (var i = 1; i <= to; i++)
    {
        ct.ThrowIfCancellationRequested();
        await Task.Delay(100, ct);
        reached = i;
    }
    return reached;
}
```

On point 3: **throwing is almost always correct.** A cancelled operation has an *undefined* result — returning a partial count makes it indistinguishable from a complete one, and the caller acts on data it thinks is whole.

Return partial results only when the API explicitly says so, and then make it structurally obvious:
```csharp
record PartialResult<T>(T Value, bool WasCancelled);
```

The general principle: **cancellation is an exception because the result is meaningless, not because something went wrong.** That distinction is why `OperationCanceledException` gets its own handling everywhere.
:::

::: challenge Level 3 · A cancellable, resumable import
Build an importer that reads tasks from a large file and adds them to the store.

Requirements:
- Fully cancellable: token checked per line, passed to every async call.
- On cancellation, the work done so far is **not** rolled back, and the caller learns exactly how many were imported and where to resume from.
- A per-item timeout of 2 seconds, linked to the caller's token, so one hung item cannot stall the import.
- Progress reported through `IProgress<ImportProgress>`.
- The file handle is released on cancellation.
- Cancelling twice, or after completion, is harmless.

Then answer: why is `IProgress<T>` better than passing an `Action<T>` callback?
:::

::: solution
```csharp
public sealed record ImportProgress(int Processed, int Failed, string? CurrentItem);
public sealed record ImportResult(int Imported, int Failed, long ResumeAtLine, bool Cancelled);

public async Task<ImportResult> ImportAsync(
    string path, IProgress<ImportProgress>? progress = null, CancellationToken ct = default)
{
    var imported = 0; var failed = 0; long line = 0;

    using var reader = new StreamReader(path);
    try
    {
        while (await reader.ReadLineAsync(ct) is { } text)
        {
            line++;
            ct.ThrowIfCancellationRequested();

            using var perItem = CancellationTokenSource.CreateLinkedTokenSource(ct);
            perItem.CancelAfter(TimeSpan.FromSeconds(2));

            try
            {
                var task = JsonSerializer.Deserialize<TaskItem>(text)
                           ?? throw new JsonException("null");
                await _store.AddAsync(task, perItem.Token);
                imported++;
                progress?.Report(new ImportProgress(imported, failed, task.Title));
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                failed++;          // the PER-ITEM timeout fired, not the caller's cancellation
            }
            catch (JsonException)
            {
                failed++;
            }
        }
    }
    catch (OperationCanceledException)
    {
        return new ImportResult(imported, failed, line, Cancelled: true);
    }

    return new ImportResult(imported, failed, line, Cancelled: false);
}
```

The subtle line is `catch (OperationCanceledException) when (!ct.IsCancellationRequested)`. Both the caller's cancellation and the per-item timeout surface as the same exception type. The filter distinguishes them: if the caller's token is *not* cancelled, this must be the item timeout, so count it as a failure and continue. If the caller's token *is* cancelled, the filter is false, the exception propagates to the outer catch, and the whole import stops.

Getting that distinction right is the difference between "one slow record aborts the import" and "one slow record is skipped".

**Why `IProgress<T>` beats a raw callback:** its default implementation, `Progress<T>`, captures the `SynchronizationContext` at construction and marshals `Report` calls back to it. In a UI app that means the handler runs on the UI thread automatically, so you can update a progress bar without an explicit dispatch. It is also a named interface with a documented contract — "report is called from arbitrary threads and must not throw" — where an `Action<T>` says nothing.
:::

::: project Wire cancellation through TaskFlow
The `CancellationToken` parameters you added in lesson 1 are still ignored. Make them real.

1. Every store method honours the token: `ThrowIfCancellationRequested` at entry, and pass it to everything.
2. Your `SlowStore` decorator passes it to `Task.Delay`.
3. The CLI installs a handler so `Ctrl+C` cancels gracefully rather than killing the process:
   ```csharp
   using var cts = new CancellationTokenSource();
   Console.CancelKeyPress += (_, e) =>
   {
       e.Cancel = true;                 // stop the runtime from killing us
       Console.WriteLine("\nCancelling…");
       cts.Cancel();
   };
   ```
4. `Main` catches `OperationCanceledException` and returns exit code `130` (the Unix convention for SIGINT).
5. Long commands (`search` over 10,000 tasks, `import`) report progress and stop promptly.
6. Add `dotnet_diagnostic.CA2016.severity = error` to `.editorconfig` and fix what it finds.

Test it: start a slow import, press `Ctrl+C`, and confirm you get a clean message and a partial count rather than a stack trace.

Commit.
:::

::: interview How does cancellation work in .NET?
It is cooperative. A `CancellationTokenSource` owns a `CancellationToken`, which is handed to the operations you might want to stop. Nothing is forcibly aborted — the running code must check the token, either with `ThrowIfCancellationRequested()` or by passing it to framework methods that check it themselves, and signal cancellation by throwing `OperationCanceledException`.

The conventions that matter: the token is the last parameter, defaulted; you always pass it down to the calls you make, or the cancellation stops at your method; and `OperationCanceledException` is an expected outcome, not an error, so it should not be logged or reported as a failure.

In ASP.NET Core the token comes from `HttpContext.RequestAborted` and fires when the client disconnects, which is how you avoid doing work for a response nobody will read.
:::

::: checkpoint
- [ ] I can explain why cancellation is cooperative and cannot be forced
- [ ] I proved that a token not passed down does nothing
- [ ] I used `CreateLinkedTokenSource` to combine a timeout with a caller token
- [ ] I can distinguish a per-item timeout from a caller cancellation in a catch filter
- [ ] `Ctrl+C` cancels TaskFlow cleanly with exit code 130
:::

## Common mistakes

::: mistake
**Accepting a token and not passing it on.** The signature lies. `CA2016` catches it.

**Catching `OperationCanceledException` and logging it as an error.** Fills your dashboards with noise from users closing tabs.

**Returning instead of throwing on cancellation.** The caller cannot tell a cancelled result from a complete one.

**Not disposing `CancellationTokenSource`.** It holds a timer when created with a timeout. `using var`.

**Checking `IsCancellationRequested` and returning normally.** Same problem as above — use `ThrowIfCancellationRequested()`.
:::
