---
title: Async all the way — and the deadlock
summary: The rules that keep async code correct, and the classic deadlock demonstrated rather than described.
minutes: 40
stage: Stage 1
---

## What are we learning?

Why you cannot mix blocking and async code, what `ConfigureAwait` is for, and how to recognise the three failure modes: deadlock, thread-pool starvation and swallowed exceptions.

## The rule

> Once a call chain is async, every level of it must be async, all the way to the entry point.

The reason is that the two worlds do not compose. Turning an async call back into a synchronous one requires blocking, and blocking on async code is where the trouble starts.

## The blocking calls to never write

```csharp
var task = repo.GetAsync(id).Result;        // ❌ blocks
repo.SaveAsync(item).Wait();                // ❌ blocks
var t = repo.GetAsync(id).GetAwaiter().GetResult();   // ❌ blocks (slightly better exceptions)
```

All three block the current thread until the task completes. Three separate things go wrong.

### Failure 1 — deadlock

This is the classic, and it is worth understanding rather than just avoiding.

```csharp
// In a context with a SynchronizationContext: old ASP.NET, WPF, WinForms
public ActionResult Index()
{
    var data = GetDataAsync().Result;      // ← deadlocks here, forever
    return View(data);
}

private async Task<string> GetDataAsync()
{
    await httpClient.GetStringAsync(url);  // captures the context
    return "done";                         // needs the context to resume
}
```

Step by step:

1. `Index` calls `GetDataAsync()` and blocks the request thread on `.Result`.
2. `GetDataAsync` awaits, capturing the current `SynchronizationContext`.
3. The HTTP call completes. The continuation is posted to that context.
4. The context has one thread — and it is blocked on `.Result`, waiting for `GetDataAsync`.
5. `GetDataAsync` is waiting for the context. Both wait forever.

::: note ASP.NET Core does not have this SynchronizationContext
Modern ASP.NET Core removed it, so this exact deadlock does not occur there. That is why the advice you read varies by age.

It **does** still occur in WPF, WinForms, MAUI, old ASP.NET (System.Web), and in some library initialisation paths. And even where it cannot deadlock, `.Result` still causes failures 2 and 3 below.

The safe rule is unchanged: **never block on async code.**
:::

### Failure 2 — thread pool starvation

Even without a deadlock, blocking is expensive at scale.

```csharp
// ASP.NET Core, 100 concurrent requests
public IActionResult Get() => Ok(_service.GetAsync().Result);
```

Each request occupies a thread pool thread that does nothing but wait. The pool grows slowly — roughly one new thread per second past its minimum — so a burst of traffic produces a queue, latency spikes and timeouts, while the CPU sits at 5%.

This is the single most common cause of "our API falls over under load but the servers look idle".

### Failure 3 — wrapped exceptions

```csharp
try { task.Wait(); }
catch (AggregateException ex) { }   // your exception is inside ex.InnerExceptions

try { await task; }
catch (TaskNotFoundException ex) { }  // the actual exception, directly
```

`.Wait()` and `.Result` wrap exceptions in `AggregateException`. `await` unwraps the first one for you. So blocking also breaks every `catch` clause you wrote for the real exception type.

## `ConfigureAwait(false)`

```csharp
await repo.GetAsync(id).ConfigureAwait(false);
```

This says "I do not need to resume on the captured context — any thread pool thread is fine". It avoids the deadlock in failure 1 and saves a small amount of overhead.

::: design Where does ConfigureAwait(false) belong?
**In library code: yes, everywhere.** A library does not know what context its caller has, and it usually has no reason to resume on a UI thread.

**In application code (ASP.NET Core): not needed.** There is no SynchronizationContext to capture, so it does nothing. Adding it to every await is noise.

**In UI application code: no.** You *want* to resume on the UI thread, because you are about to touch a control.

So: if you are writing a NuGet package, add it. If you are writing TaskFlow, do not bother. Knowing *why* is the point — plenty of codebases have it everywhere as cargo cult.
:::

## The exception to the rule: `Main`

```csharp
static async Task<int> Main(string[] args)    // the compiler handles the blocking for you
{
    await RunAsync();
    return 0;
}
```

This is the one legitimate place the async chain terminates.

::: debug Level 4 · Make a deadlock happen
You cannot reproduce the classic deadlock in a console app by default — console apps have no SynchronizationContext. So install one.

```csharp
// Paste this and run it. It will hang. Then fix it.
SynchronizationContext.SetSynchronizationContext(new SingleThreadContext());

Console.WriteLine("before");
var result = GetAsync().Result;          // hangs here
Console.WriteLine(result);

static async Task<string> GetAsync()
{
    await Task.Delay(100);
    return "done";
}
```

You will need a minimal `SingleThreadContext` — a `SynchronizationContext` whose `Post` queues work to a single thread that is currently blocked. Write it, watch it hang, then apply `ConfigureAwait(false)` and watch it complete.

Take the extra ten minutes on this. Reading about the deadlock and *causing* one are different levels of understanding.
:::

::: solution
```csharp
sealed class SingleThreadContext : SynchronizationContext
{
    private readonly BlockingCollection<(SendOrPostCallback cb, object? state)> _queue = new();

    public SingleThreadContext()
    {
        var thread = new Thread(() =>
        {
            SetSynchronizationContext(this);
            foreach (var (cb, state) in _queue.GetConsumingEnumerable()) cb(state);
        }) { IsBackground = true };
        thread.Start();
    }

    public override void Post(SendOrPostCallback d, object? state) => _queue.Add((d, state));
}
```

Run the original code from that context's thread and `.Result` blocks it; the continuation from `await Task.Delay(100)` is posted to the same queue, which nobody is draining. Deadlock.

Two fixes, both of which work:

```csharp
await Task.Delay(100).ConfigureAwait(false);   // continuation runs on the thread pool
```
```csharp
var result = await GetAsync();                  // do not block at all — the real fix
```

The second is the one to internalise. `ConfigureAwait(false)` makes the deadlock less likely; *not blocking* makes it impossible.
:::

::: exercise Level 2 — Independent · Find the async smells
Here are six snippets. For each: name the problem, describe the symptom in production, and write the fix.

```csharp
// A
public List<TaskItem> GetAll() => _repo.ListAsync().Result.ToList();

// B
public async Task ProcessAllAsync(IEnumerable<Guid> ids)
{
    foreach (var id in ids)
        await ProcessAsync(id);
}

// C
public async void OnTaskCompleted(TaskItem task) => await _notifier.SendAsync(task);

// D
public async Task<int> CountAsync()
{
    return await Task.Run(() => _tasks.Count);
}

// E
public async Task SaveAsync(TaskItem task)
{
    await _repo.SaveAsync(task);
}

// F
public Task<TaskItem> GetAsync(Guid id)
{
    using var context = new TaskFlowDbContext();
    return context.Tasks.FirstAsync(t => t.Id == id);
}
```
:::

::: solution
**A — blocking on async.** Symptom: thread pool starvation under load; deadlock in a UI or legacy ASP.NET context; exceptions wrapped in `AggregateException`. Fix: make the method `async Task<List<TaskItem>>` and await. If a synchronous API is genuinely required, that is a design problem to solve at a higher level, not here.

**B — sequential awaits in a loop.** Not always wrong! If the operations must be ordered, or if they hit a resource with limited concurrency, this is correct. But if they are independent, you are doing ten 100ms calls in 1000ms instead of 100ms. Fix (lesson 4): `await Task.WhenAll(ids.Select(ProcessAsync))` — with a concurrency limit.

**C — `async void`.** Symptom: an exception in `SendAsync` crashes the process instead of being caught; nothing can await completion. Fix: return `Task`, or if the caller's signature is fixed, wrap the whole body in try/catch.

**D — `Task.Run` around synchronous work.** `_tasks.Count` is instant. You have added a thread pool dispatch, a state machine and a context switch to save zero time. Symptom: slower, and on ASP.NET Core it takes a thread from the pool that was serving requests. Fix: `public Task<int> CountAsync() => Task.FromResult(_tasks.Count);`

**E — a pointless async wrapper.** The method awaits one call and returns. The `async` adds a state machine for nothing. Fix: `public Task SaveAsync(TaskItem task) => _repo.SaveAsync(task);` — *with one caveat*: eliding `async` also changes exception timing (exceptions surface when awaited rather than when called) and, with `using`, breaks entirely — which is exactly F.

**F — disposing before the task completes.** `return` without `await` means the method returns the *unfinished* task, and `using` disposes the context immediately. Symptom: `ObjectDisposedException`, intermittently — it works when the query happens to complete synchronously from cache. Fix: `await` it so the `using` block spans the whole operation:
```csharp
public async Task<TaskItem> GetAsync(Guid id)
{
    using var context = new TaskFlowDbContext();
    return await context.Tasks.FirstAsync(t => t.Id == id);
}
```

E and F together are the rule: **elide `async`/`await` only in a method that does nothing but forward the call, with no `using`, no `try`, and nothing after the await.**
:::

::: project Audit TaskFlow
Search your codebase for every one of these and fix what you find:

```bash
cd ~/taskflow
grep -rn "\.Result" --include=*.cs src/
grep -rn "\.Wait()" --include=*.cs src/
grep -rn "async void" --include=*.cs src/
grep -rn "Task\.Run" --include=*.cs src/
grep -rn "Thread\.Sleep" --include=*.cs src/
```

Then add an analyser so the compiler catches them for you in future. Create `.editorconfig` at the repo root:

```ini
root = true

[*.cs]
# Blocking on async
dotnet_diagnostic.CA1849.severity = error   # call async methods when in an async method
dotnet_diagnostic.CA2007.severity = none    # ConfigureAwait — not needed in an app
dotnet_diagnostic.VSTHRD002.severity = error
dotnet_diagnostic.CS1998.severity = error   # async method lacks await
dotnet_diagnostic.CS4014.severity = error   # unawaited task
```

and in `TaskFlow.Console.csproj`:
```xml
<EnableNETAnalyzers>true</EnableNETAnalyzers>
<AnalysisLevel>latest-recommended</AnalysisLevel>
```

Build, fix everything it reports, commit. Carry this `.editorconfig` into every project in this course — `CS4014` alone (an async call whose task you forgot to await) catches a genuinely nasty class of bug.
:::

::: interview Why should you avoid calling `.Result` on a Task?
Three reasons. It blocks the calling thread, so under load you exhaust the thread pool while the CPU is idle — the classic "slow API on an idle server". In any context with a `SynchronizationContext` — WPF, WinForms, legacy ASP.NET — it can deadlock, because the continuation needs the very thread you are blocking. And it wraps exceptions in `AggregateException`, so the `catch` clauses you wrote for the real exception type stop matching.

The rule is async all the way to the entry point, with `async Task Main` as the only place the chain terminates.
:::

::: checkpoint
- [ ] I caused a real deadlock and then fixed it
- [ ] I can explain thread pool starvation to someone who has not heard of it
- [ ] I know when `ConfigureAwait(false)` is and is not needed
- [ ] I identified all six async smells before reading the solutions
- [ ] TaskFlow has an `.editorconfig` with async analysers at error level
:::

## Common mistakes

::: mistake
**`.Result` / `.Wait()` "just this once".** It works in your test and starves the pool in production.

**`async` + `using` + no `await`.** The resource is disposed before the task completes.

**`Task.Run` to "make it async".** Wrapping CPU work in `Task.Run` inside a web request moves the work to another thread pool thread and helps nothing.

**Fire-and-forget without handling faults.** `_ = DoAsync();` swallows the exception silently. At minimum, attach a continuation that logs.

**`ConfigureAwait(false)` everywhere in an ASP.NET Core app.** Harmless but pointless, and it signals that the author copied it without knowing why.
:::
