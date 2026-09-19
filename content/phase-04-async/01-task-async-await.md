---
title: Task, async and await
summary: What await actually does to your method, and why async is about threads you are NOT using.
minutes: 45
stage: Stage 1
---

## What are we learning?

The async model in .NET. The syntax is five minutes; the mental model is the lesson.

## The wrong mental model

"Async makes things run in parallel" — no.
"Async makes things faster" — no, individual operations get slightly slower.
"`await` starts a new thread" — no, usually the opposite.

## The right mental model

Most of what a server does is **wait**: for a database, for an HTTP call, for a disk. During that wait, a synchronous method holds onto its thread doing nothing.

Threads are expensive — roughly 1 MB of stack each, plus scheduling cost. A server with 200 threads that are all blocked waiting on the database can serve zero additional requests, even though the CPU is idle.

```text
SYNCHRONOUS
Thread 1: |--work--|########### waiting on DB ###########|--work--|
          The thread is unusable for 200ms.

ASYNCHRONOUS
Thread 1: |--work--|  (returns to the pool)      ...     |--work--|
                   ^ thread serves other requests here ^
```

**Async is about giving the thread back while you wait.** The benefit is throughput and scalability, not latency.

::: why Where async actually matters
| Work | Async helps? |
|---|---|
| Database query | **Yes** — you are waiting on the network |
| HTTP call to another service | **Yes** |
| Reading/writing a file | **Yes** |
| Computing a hash over 10 MB | No — that is CPU work, the thread is busy |
| Sorting a list in memory | No |

For CPU-bound work, async gains you nothing; what you might want there is *parallelism* (`Parallel.For`, `Task.Run`), which is a different thing and is covered in lesson 4.
:::

## `Task` and `Task<T>`

```csharp
Task            // an operation that will complete, with no result
Task<TaskItem>  // an operation that will complete, producing a TaskItem
ValueTask<T>    // like Task<T>, but avoids an allocation when it completes synchronously
```

A `Task` is a *promise* of future completion. It has a status (`WaitingForActivation`, `RanToCompletion`, `Faulted`, `Canceled`), a result, and an exception.

```csharp
Task<int> t = Task.FromResult(42);          // already complete
Task delay = Task.Delay(1000);              // completes in a second
Task<TaskItem> query = repo.GetAsync(id);   // completes when the DB replies
```

## `async` and `await`

```csharp
public async Task<TaskItem> CompleteAsync(Guid id)
{
    var task = await _repository.GetAsync(id);     // suspend here; return the thread
    task.Complete();                               // resume here when the DB replies
    await _repository.SaveAsync(task);
    return task;
}
```

What `await` does, precisely:

1. If the awaited task is **already complete**, continue synchronously — no suspension, no cost.
2. Otherwise, register the rest of the method as a *continuation*, and **return** to the caller.
3. When the task completes, the continuation is scheduled and the method resumes from that point.

The compiler rewrites the method into a state machine, exactly like `yield return` in Phase 2. Local variables become fields; each `await` is a state.

::: note `async` is an implementation detail, not part of the signature
`async` is not in the method's public contract. `Task<T> Foo()` and `async Task<T> Foo()` look identical to callers. It just tells the compiler "this body uses `await`, build the state machine".

That is why you can implement an interface method with or without `async` — and why a method that has nothing to await should not be marked `async`:
```csharp
public Task<int> GetCachedAsync() => Task.FromResult(_cached);   // no state machine, no overhead
```
:::

## The three return types

```csharp
async Task DoWorkAsync()           // ✅ no result
async Task<int> GetCountAsync()    // ✅ a result
async void FireAndForget()         // ❌ almost never
```

::: warn `async void` is a trap
`async void` exists for one reason: event handlers, whose signature you cannot change.

Everywhere else it is dangerous:
- **You cannot await it**, so you cannot know when it finished.
- **You cannot catch its exceptions.** An unhandled exception in an `async void` method is raised on the synchronization context and **crashes the process**.

```csharp
async void Bad() => throw new InvalidOperationException("boom");

try { Bad(); }
catch (Exception) { /* NEVER reached — the process dies instead */ }
```

If you need fire-and-forget, return `Task` and handle it explicitly:
```csharp
_ = DoWorkAsync().ContinueWith(t => logger.LogError(t.Exception, "background failure"),
        TaskContinuationOptions.OnlyOnFaulted);
```
Or better, use a background service (Phase 14).
:::

## Naming and conventions

```csharp
Task<TaskItem> GetAsync(Guid id)        // suffix Async
Task SaveAsync(TaskItem task)
Task<int> CountAsync(CancellationToken ct = default)   // always accept a token (lesson 3)
```

The `Async` suffix is a strong .NET convention. Follow it.

::: predict What order does this print?
```csharp
Console.WriteLine("1");
var t = WorkAsync();
Console.WriteLine("3");
await t;
Console.WriteLine("5");

async Task WorkAsync()
{
    Console.WriteLine("2");
    await Task.Delay(100);
    Console.WriteLine("4");
}
```
:::

::: solution
```text
1
2
3
4
5
```

The surprising part for most people is that **"2" prints before "3"**. Calling an async method runs its body **synchronously** until the first `await` that actually suspends. Only at `await Task.Delay(100)` does control return to the caller, which then prints "3".

This matters in practice: expensive setup code at the top of an async method runs on the caller's thread, before the caller gets control back. If you want the whole thing off the caller's thread, that is `Task.Run`, not `async`.

Change `Task.Delay(100)` to `Task.CompletedTask` and the output becomes `1 2 4 3 5` — the await never suspends, so the method runs to completion synchronously.
:::

::: exercise Level 1 — Guided · Make the store async
1. In your scratch project, write a fake repository that simulates latency:
   ```csharp
   public async Task<TaskItem?> GetAsync(Guid id)
   {
       await Task.Delay(50);                  // pretend this is a database
       return _tasks.GetValueOrDefault(id);
   }
   ```
2. Add `ListAsync`, `AddAsync`, `SaveAsync`, all with a delay.
3. Write an async `Main` that calls them in sequence and times the whole thing with `Stopwatch`.
4. Now add a method that fetches three tasks by id, one after another with `await` each time. Time it. (Should be ~150ms.)
5. Print `Environment.CurrentManagedThreadId` before and after an `await`. Run it several times. Sometimes it is the same thread, sometimes not — and that unpredictability is the point.
:::

::: challenge Level 3 · A retry helper, properly async
In Phase 2 you wrote a synchronous `Retry` with `Thread.Sleep`. Rewrite it:

```csharp
static async Task<T> RetryAsync<T>(
    Func<Task<T>> operation,
    int maxAttempts = 3,
    Func<int, Exception, Task>? onRetry = null)
```

Requirements:
- `await Task.Delay(...)` for the backoff, not `Thread.Sleep`.
- Exponential backoff with **jitter** — a random 0–100ms added to each delay.
- Do not retry `ArgumentException`.
- On final failure, the original exception propagates with its stack trace intact.
- Add an overload for `Func<Task>` (no result) without duplicating the logic.

Then explain in one sentence why `Thread.Sleep` inside an async method is a bug even though it "works".
:::

::: solution
```csharp
static async Task<T> RetryAsync<T>(
    Func<Task<T>> operation, int maxAttempts = 3, Func<int, Exception, Task>? onRetry = null)
{
    ArgumentOutOfRangeException.ThrowIfLessThan(maxAttempts, 1);

    for (var attempt = 1; ; attempt++)
    {
        try
        {
            return await operation();
        }
        catch (ArgumentException)
        {
            throw;
        }
        catch (Exception ex) when (attempt < maxAttempts)
        {
            if (onRetry is not null) await onRetry(attempt, ex);

            var backoff = TimeSpan.FromMilliseconds(
                100 * Math.Pow(2, attempt - 1) + Random.Shared.Next(0, 100));
            await Task.Delay(backoff);
        }
    }
}

// no-result overload, built on the generic one — no duplication
static Task RetryAsync(Func<Task> operation, int maxAttempts = 3, Func<int, Exception, Task>? onRetry = null) =>
    RetryAsync<object?>(async () => { await operation(); return null; }, maxAttempts, onRetry);
```

**Why `Thread.Sleep` is a bug here:** it blocks the thread for the duration instead of releasing it, which defeats the entire purpose of the async method — under load, every retrying request holds a thread pool thread hostage, and the pool starves. `Task.Delay` sets a timer and releases the thread.

**Why jitter matters:** without it, a hundred clients that all failed at the same moment all retry at exactly 100ms, then exactly 200ms — a synchronised stampede that re-breaks the service just as it recovers. Random jitter spreads them out. This is a real production pattern, not a nicety.

`Random.Shared` is the thread-safe shared instance added in .NET 6. Creating `new Random()` per call in a tight loop gives you the same seed and identical "random" numbers.
:::

::: project Make TaskFlow async end to end
Convert your store to async. This is a bigger change than it looks, and doing it manually once teaches you why "async all the way" is a rule.

1. `ITaskStore` becomes:
   ```csharp
   Task<TaskItem?> GetAsync(Guid id, CancellationToken ct = default);
   Task<IReadOnlyList<TaskItem>> ListAsync(CancellationToken ct = default);
   Task AddAsync(TaskItem task, CancellationToken ct = default);
   Task<bool> RemoveAsync(Guid id, CancellationToken ct = default);
   Task<Page<TaskSummary>> SearchAsync(TaskQuery query, CancellationToken ct = default);
   ```
   (The `CancellationToken` parameters do nothing yet — lesson 3 fills them in. Add them now so you do not have to change every signature twice.)
2. The in-memory implementation has nothing to await. Use `Task.FromResult(...)` and **do not** mark those methods `async` — there is no reason to build a state machine.
3. Add an artificial delay behind a flag so you can feel the difference:
   ```csharp
   public sealed class SlowStore(ITaskStore inner, TimeSpan latency) : ITaskStore
   ```
   Another decorator. Your Phase 1 design is still paying off.
4. `Main` becomes `static async Task<int> Main(string[] args)`.
5. Every call site gets an `await`. Count how many files you had to touch and note the number in `DECISIONS.md`.

Commit.
:::

::: interview What happens when you await a Task?
If the task is already complete, execution continues synchronously. Otherwise the compiler-generated state machine registers the remainder of the method as a continuation and returns control to the caller — releasing the thread rather than blocking it. When the task completes, the continuation is scheduled and the method resumes at that point, with its local variables restored from the state machine's fields.

The key points to land: `await` does not create a thread, the method body runs synchronously up to the first suspending await, and the purpose is throughput — freeing threads during I/O waits — not making any individual operation faster.
:::

::: checkpoint
- [ ] I can explain why async improves throughput but not latency
- [ ] I predicted the `1 2 3 4 5` ordering correctly
- [ ] I know why `async void` can crash a process
- [ ] I wrote an async retry with exponential backoff and jitter
- [ ] TaskFlow's store is async, with `CancellationToken` parameters already in place
:::

## Common mistakes

::: mistake
**`async void` on anything but an event handler.** Uncatchable exceptions, unobservable completion.

**Marking a method `async` with nothing to await.** You pay for a state machine and get a compiler warning (`CS1998`). Return the task directly.

**Thinking `await` runs things in parallel.** Two sequential `await`s are sequential. Lesson 4 covers doing them at once.

**`Thread.Sleep` in async code.** Blocks the thread you were trying to free.

**Forgetting the `Async` suffix.** Minor, but every .NET developer reads the suffix as "this returns a Task".
:::
