---
title: Threading, locks and concurrent collections
summary: Shared mutable state, the bugs it causes, and the primitives that make it safe.
minutes: 45
---

## What are we learning?

Thread safety: why a correct-looking increment is not atomic, how to synchronise properly, and the collections that let you avoid locking altogether.

## The problem

```csharp
private int _count;
public void Increment() => _count++;
```

`_count++` is three operations: read, add, write. Two threads can both read `5`, both write `6`, and one increment vanishes.

```csharp
var counter = new Counter();
Parallel.For(0, 1_000_000, _ => counter.Increment());
Console.WriteLine(counter.Count);       // ~830,000. Different every run.
```

This is not theoretical — run it. It is the Phase 1 static-counter bug, now with a measurement.

## Atomic operations

```csharp
private int _count;

public void Increment() => Interlocked.Increment(ref _count);
public int Count => Volatile.Read(ref _count);

Interlocked.Add(ref _total, amount);
Interlocked.Exchange(ref _current, newValue);
Interlocked.CompareExchange(ref _state, newValue, expectedValue);   // the CAS primitive
```

`Interlocked` performs read-modify-write as a single CPU instruction. For a counter it is the whole answer, and it is far cheaper than a lock.

`Volatile.Read` prevents the compiler, the JIT and the CPU from caching or reordering the read — without it, a thread can keep reading a stale cached value indefinitely.

## `lock`

```csharp
private readonly Lock _gate = new();          // .NET 9's dedicated type
private readonly List<TaskItem> _tasks = [];

public void Add(TaskItem task)
{
    lock (_gate) { _tasks.Add(task); }
}

public IReadOnlyList<TaskItem> Snapshot()
{
    lock (_gate) { return _tasks.ToList(); }  // copy inside the lock
}
```

::: warn Four rules for locking
**1. Lock on a private, dedicated object.** Never `lock(this)`, never `lock(typeof(X))`, never lock on a string. Anything else can lock on the same object and deadlock you from code you have never seen. .NET 9 added `System.Threading.Lock` specifically so the intent is explicit.

**2. Keep the critical section tiny.** No I/O, no database call, no allocation you can avoid. A lock held for 50ms serialises every thread that wants it.

**3. Never `await` inside a `lock`.** It is a compile error, and for a good reason: a lock is owned by a *thread*, and after an `await` you may be on a different one. Use `SemaphoreSlim` when you need an async-compatible gate:
```csharp
private readonly SemaphoreSlim _gate = new(1, 1);

await _gate.WaitAsync(ct);
try { await DoSomethingAsync(ct); }
finally { _gate.Release(); }
```

**4. Always acquire multiple locks in the same order.** Thread A taking lock 1 then 2 while thread B takes 2 then 1 is the textbook deadlock, and it happens.
:::

## Concurrent collections

Usually better than locking, because they are lock-free or fine-grained internally:

```csharp
ConcurrentDictionary<Guid, TaskItem>      // the one you will use most
ConcurrentQueue<T>                        // FIFO
ConcurrentStack<T>                        // LIFO
ConcurrentBag<T>                          // unordered, fast when each thread mostly takes its own
BlockingCollection<T>                     // producer/consumer with bounding
Channel<T>                                // the modern async producer/consumer
```

```csharp
private readonly ConcurrentDictionary<Guid, TaskItem> _tasks = new();

_tasks.TryAdd(task.Id, task);
_tasks.TryGetValue(id, out var task);
_tasks.TryRemove(id, out _);
_tasks.AddOrUpdate(id, task, (_, existing) => Merge(existing, task));
var value = _tasks.GetOrAdd(id, static key => Load(key));
```

::: warn `GetOrAdd`'s factory can run more than once
```csharp
var task = _tasks.GetOrAdd(id, _ => LoadExpensive(id));     // may call LoadExpensive twice
```
`ConcurrentDictionary` does not hold a lock while running your factory — deliberately, so a slow factory cannot block the whole dictionary. Two threads racing on the same missing key can both invoke it; only one result is stored, and the other is discarded.

That is fine for a pure lookup and wrong for anything with side effects or real expense. For those, store a `Lazy<T>`:
```csharp
private readonly ConcurrentDictionary<Guid, Lazy<TaskItem>> _cache = new();

var task = _cache.GetOrAdd(id, key => new Lazy<TaskItem>(() => LoadExpensive(key))).Value;
```
Both threads get the same `Lazy<T>`; `Lazy<T>` guarantees the factory runs once. The `Lazy` object may be created twice, but it is cheap and the expensive work is not duplicated.
:::

## `Channel<T>`

The modern producer/consumer primitive, and the right answer for most background pipelines:

```csharp
var channel = Channel.CreateBounded<TaskItem>(new BoundedChannelOptions(1000)
{
    FullMode = BoundedChannelFullMode.Wait          // back-pressure
});

// producer
await channel.Writer.WriteAsync(task, ct);
channel.Writer.Complete();

// consumer
await foreach (var task in channel.Reader.ReadAllAsync(ct))
    await ProcessAsync(task, ct);
```

**Bounded, not unbounded.** An unbounded channel with a producer faster than its consumer is a memory leak with a queue in front of it. `FullMode.Wait` makes the producer slow down, which is back-pressure, and back-pressure is how you keep a system stable under overload.

## Thread safety in a web application

::: design What actually needs synchronising in ASP.NET Core
Each request runs concurrently with every other. So:

**Needs care:**
- **Singleton services with mutable state.** This is the main one.
- **Static fields.** All of them.
- **Caches.**
- **Anything captured in a closure and shared.**

**Does not need care:**
- **Scoped and transient services.** One instance per request; no sharing.
- **`DbContext`.** Scoped, so per request — and it is *not* thread-safe, which is why you must never run two queries on it concurrently even within one request.
- **Local variables.**
- **Immutable objects.** This is the most underrated tool here: a `record` with `init` properties needs no synchronisation at all, ever.

**The best strategy is to avoid shared mutable state.** Immutability, per-request scope and message passing through channels eliminate whole categories of bug that no amount of careful locking can fully prevent.
:::

::: exercise Level 1 — Guided · Break it, then fix it
1. Write the naive counter and run `Parallel.For` a million times. Record the wrong answers across several runs.
2. Fix with `lock`. Measure.
3. Fix with `Interlocked`. Measure. Compare.
4. Add to a `List<T>` from 100 concurrent tasks; observe corruption, exceptions and lost items.
5. Fix with a `lock`, then with `ConcurrentBag<T>`. Measure both.
6. Prove `GetOrAdd` can call its factory twice: increment a counter inside it and race 100 threads on one missing key.
7. Fix with `Lazy<T>` and confirm the counter is 1.
8. Build a bounded `Channel<T>` with a fast producer and slow consumer; observe back-pressure.
:::

::: challenge Level 3 · A thread-safe cache
Build a cache for TaskFlow that is correct under concurrency and does not stampede.

Requirements:
1. `GetOrCreateAsync<T>(string key, Func<CancellationToken, Task<T>> factory, TimeSpan expiry, CancellationToken ct)`.
2. Concurrent misses on the same key run the factory **once**; the others await the same result.
3. A factory failure is not cached, and the next caller retries.
4. Expiry per entry; expired entries are evicted.
5. Bounded size with LRU eviction.
6. Metrics: hits, misses, evictions, stampedes prevented.
7. Cancellation of one waiter does not cancel the shared factory for the others.
8. A test with 1,000 concurrent requests for one missing key proving the factory ran once.

Point 7 is the one almost every hand-rolled cache gets wrong.
:::

::: solution
```csharp
public sealed class StampedeProtectedCache(IMemoryCache cache, ILogger<StampedeProtectedCache> logger)
{
    private readonly ConcurrentDictionary<string, Lazy<Task<object?>>> _inFlight = new();

    public async Task<T> GetOrCreateAsync<T>(
        string key, Func<CancellationToken, Task<T>> factory, TimeSpan expiry, CancellationToken ct)
    {
        if (cache.TryGetValue(key, out T? cached)) return cached!;

        var lazy = _inFlight.GetOrAdd(key, k => new Lazy<Task<object?>>(async () =>
        {
            try
            {
                // CancellationToken.None: one waiter cancelling must NOT cancel the shared work.
                var value = await factory(CancellationToken.None);
                cache.Set(k, value, expiry);
                return value;
            }
            finally
            {
                _inFlight.TryRemove(k, out _);      // not cached on failure — next caller retries
            }
        }));

        // Each waiter observes its OWN cancellation without affecting the shared task.
        return (T)(await lazy.Value.WaitAsync(ct))!;
    }
}
```

Three details carry the whole design:

**`Lazy<Task<T>>` rather than `Task<T>`.** `GetOrAdd`'s factory can run more than once, so storing a `Task` directly could start the work twice. `Lazy<T>` guarantees its own factory runs once, so only one task is ever started — requirement 2.

**`CancellationToken.None` inside the factory, `WaitAsync(ct)` outside.** If the shared factory took the first caller's token, that caller navigating away would cancel the work that 999 other callers are waiting on. Instead the shared work is uncancellable and each waiter applies its own token to *its own wait* — requirement 7. This is the detail that separates a working cache from one that produces baffling intermittent cancellations under load.

**`TryRemove` in the `finally`, and `cache.Set` only on success.** A failed factory leaves nothing cached, so the next caller genuinely retries rather than receiving a cached exception for the next five minutes — requirement 3.

The test:
```csharp
[Fact]
public async Task A_thousand_concurrent_misses_run_the_factory_once()
{
    var calls = 0;
    var tasks = Enumerable.Range(0, 1000).Select(_ => cache.GetOrCreateAsync("key",
        async ct => { Interlocked.Increment(ref calls); await Task.Delay(50, ct); return "value"; },
        TimeSpan.FromMinutes(1), default));

    var results = await Task.WhenAll(tasks);

    calls.ShouldBe(1);
    results.ShouldAllBe(r => r == "value");
}
```

**And then the production answer:** use `HybridCache` (.NET 9), which does all of this — stampede protection, two-level L1/L2 caching, tag-based invalidation, serialisation — and is maintained by people who have thought about the edge cases longer than you have. Build this once to understand what it is doing; ship that.
:::

::: project Concurrency in TaskFlow
1. Audit every singleton and static for mutable state.
2. Make each one immutable, or `ConcurrentDictionary`, or properly locked — in that order of preference.
3. Any counter uses `Interlocked`.
4. `HybridCache` (or your cache) for expensive lookups.
5. A bounded `Channel<T>` for your notification pipeline.
6. A stress test: 1,000 concurrent requests, asserting correctness of every counter and cache.
7. `DECISIONS.md`: every piece of shared mutable state and how it is protected.

Commit. **Phase 13 is complete.**
:::

::: interview How do you make code thread-safe in .NET?
In order of preference: avoid shared mutable state, then use a lock-free primitive, then use a concurrent collection, then lock.

Avoiding it is the most effective — immutable objects and per-request scoped services need no synchronisation at all. In ASP.NET Core, scoped and transient services are per request and need nothing; the risks are singletons with mutable state, statics, and caches.

For counters, `Interlocked` performs the read-modify-write atomically and is far cheaper than a lock — `count++` is three operations and loses increments under concurrency. For collections, `ConcurrentDictionary` and friends use fine-grained or lock-free strategies internally.

When you do lock, the rules are: a private dedicated object — `System.Threading.Lock` in .NET 9 — the smallest possible critical section, no I/O inside, never `await` inside because a lock is thread-owned, and consistent acquisition order across multiple locks.

The gotcha worth mentioning is that `ConcurrentDictionary.GetOrAdd` can run its factory more than once for the same key, because it deliberately does not hold a lock during the call. For an expensive factory you store a `Lazy<T>` instead.
:::

::: checkpoint Phase 13 complete
- [ ] I measured lost increments with my own eyes
- [ ] I compared `lock` and `Interlocked` performance
- [ ] I proved `GetOrAdd` can call its factory twice
- [ ] I understand why one waiter's cancellation must not cancel shared work
- [ ] Every singleton in TaskFlow has documented thread-safety
:::

## Common mistakes

::: mistake
**`count++` on a shared field.** Lost increments, non-deterministically.

**`lock(this)` or `lock(typeof(X))`.** Code you have never seen can deadlock you.

**I/O inside a lock.** Serialises every thread for the duration of a network call.

**`GetOrAdd` with an expensive factory.** It can run more than once.

**Unbounded channels and queues.** A memory leak with a queue in front of it.

**Passing a caller's cancellation token into shared work.** One caller cancels everyone.
:::
