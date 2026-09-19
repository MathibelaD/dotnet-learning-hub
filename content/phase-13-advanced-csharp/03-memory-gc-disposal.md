---
title: Memory, the GC and disposal
summary: Where objects live, how they are collected, and the deterministic cleanup the GC cannot do for you.
minutes: 45
---

## What are we learning?

The .NET memory model in enough depth to reason about allocation, plus `IDisposable`/`IAsyncDisposable` done correctly.

## Where things live

```text
STACK                            HEAP
─────                            ────
per thread, ~1 MB                 shared, gigabytes
LIFO, freed automatically         garbage collected
local value types                 all reference types
references to heap objects        boxed value types
method frames                     value types inside objects
```

```csharp
void Example()
{
    int count = 5;                       // stack
    var range = new DateRange(a, b);     // struct → stack
    var task = new TaskItem("x");        // reference → stack; OBJECT → heap
    object boxed = count;                // heap (boxing)
}
```

Note: "structs are on the stack" is a useful approximation, not a rule. A struct that is a field of a class lives on the heap inside that object; a struct captured by a lambda lives in the closure object on the heap.

## Generational collection

```text
Gen 0   new, small objects        collected often, very fast (~0.1ms)
Gen 1   survived one collection   buffer between 0 and 2
Gen 2   survived twice            collected rarely, expensive (~10-100ms)
LOH     objects ≥ 85,000 bytes    collected with gen 2, not compacted by default
```

The design rests on one empirical observation: **most objects die young.** A request's DTOs, strings and lists are garbage milliseconds after they are created, so a gen-0 collection finds almost nothing alive, copies the few survivors, and resets the allocation pointer. Allocation itself is a pointer bump — genuinely cheap.

The expensive case is an object that survives to gen 2 and then dies: it occupies memory until a full collection, and full collections are what cause latency spikes.

::: why What this means for how you write code
1. **Short-lived allocation is cheap.** Do not contort code to avoid a `List<T>` in a method that returns immediately.
2. **Long-lived allocation is expensive.** A cache that grows without bound promotes everything to gen 2 and makes every full GC slower.
3. **Large objects are special.** Anything ≥ 85 KB — a big array, a large string, a buffer — goes on the Large Object Heap, which is not compacted by default and fragments.
4. **The worst pattern is medium-lifetime objects**: live long enough to be promoted, then die. A cache with a 30-second expiry does exactly this.

`ServerGarbageCollection` (the default for ASP.NET Core) uses one heap per core and collects in parallel — higher throughput, more memory. `ConcurrentGarbageCollection` does most gen-2 work on a background thread, reducing pause times.
:::

## Measuring

```csharp
Console.WriteLine(GC.GetTotalMemory(forceFullCollection: false));
Console.WriteLine(GC.GetAllocatedBytesForCurrentThread());
Console.WriteLine($"gen0={GC.CollectionCount(0)} gen1={GC.CollectionCount(1)} gen2={GC.CollectionCount(2)}");

var info = GC.GetGCMemoryInfo();
Console.WriteLine($"heap={info.HeapSizeBytes:N0} pause={info.PauseDurations[0].TotalMilliseconds}ms");
```

```bash
dotnet-counters monitor --process-id <pid> --counters System.Runtime
```

::: warn Never call `GC.Collect()` in production code
It forces a full blocking collection, which is the single most expensive thing the runtime does, and it defeats the heuristics that are tuned far better than your intuition.

Legitimate uses: a benchmark harness measuring steady state, and a diagnostic tool. That is the list.

If you are calling it to "fix" memory growth, you have a leak — an event subscription, a static collection, an undisposed resource — and forcing collections will not reclaim anything that is still referenced.
:::

## `IDisposable`

The GC reclaims **managed memory**. It knows nothing about file handles, sockets, database connections or OS locks. Those need deterministic release.

```csharp
public sealed class TaskExporter : IDisposable
{
    private readonly FileStream _file;
    private bool _disposed;

    public TaskExporter(string path) => _file = File.Create(path);

    public void Write(TaskItem task)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        // ...
    }

    public void Dispose()
    {
        if (_disposed) return;
        _file.Dispose();
        _disposed = true;
    }
}
```

`sealed` lets you write the simple version. The full Dispose pattern with `protected virtual void Dispose(bool)` and a finalizer is only needed when the class is **unsealed** or holds an **unmanaged** resource directly (a raw handle from P/Invoke).

::: warn Do not write a finalizer
```csharp
~TaskExporter() { Dispose(false); }         // almost always wrong
```
A finalizer:
- promotes the object to at least gen 1 (it must survive to be finalized), then requires another collection to actually free it
- runs on a single finalizer thread, so a slow one blocks every other finalizer in the process
- runs at an unpredictable time, possibly never at shutdown
- cannot safely touch other managed objects, which may already be finalized

If you hold a raw OS handle, use `SafeHandle`, which has a correct finalizer written by people who do this for a living. Otherwise, no finalizer.
:::

## `IAsyncDisposable`

```csharp
public sealed class TaskStreamWriter : IAsyncDisposable
{
    private readonly StreamWriter _writer;

    public async ValueTask DisposeAsync()
    {
        await _writer.FlushAsync();
        await _writer.DisposeAsync();
    }
}

await using var writer = new TaskStreamWriter(path);
```

Use it whenever disposal does I/O — flushing a buffer, closing a connection, sending a final frame. The synchronous `Dispose` on those types blocks a thread, which is the Phase 4 problem.

If a type implements both, `await using` picks `DisposeAsync`.

## `using` and lifetime

```csharp
using var file = File.OpenRead(path);              // disposed at end of scope
using (var file = File.OpenRead(path)) { }         // disposed at end of block

await using var connection = new NpgsqlConnection(cs);
```

With DI, the container disposes what it created, at the end of the scope, for services registered as scoped or transient — **if** the container created them. An instance you register with `AddSingleton(myInstance)` is **not** disposed by the container, because it did not own its creation.

::: exercise Level 1 — Guided · Watch the GC work
1. Allocate one million small objects in a loop and print `CollectionCount(0/1/2)` before and after.
2. Allocate one million objects but keep every one in a `List<T>`. Compare the gen-2 count.
3. Allocate a 100 KB array in a loop; confirm it goes to the LOH (`GC.GetGeneration(array)` returns 2).
4. Write a class holding a `FileStream` and forget to dispose it. Open the same file exclusively and watch it fail.
5. Fix it with `using` and confirm.
6. Write a type implementing both `IDisposable` and `IAsyncDisposable`; log from each; confirm `await using` calls the async one.
7. Reproduce the Phase 2 event leak: a long-lived publisher retaining 100,000 subscribers. Watch memory with `dotnet-counters`, then fix it with `Dispose`.
:::

::: challenge Level 3 · Find and fix a memory leak
Build a deliberately leaky version of TaskFlow, confirm the leak with tooling, then fix it.

Requirements:
1. Introduce three distinct leaks: a static collection that grows, an event subscription never removed, and an undisposed `HttpClient` per request.
2. Reproduce each under load and observe the symptom.
3. Diagnose each with `dotnet-counters` and `dotnet-gcdump`.
4. Fix each, and prove the fix with a measurement.
5. Add a test that fails if memory grows past a threshold over 10,000 operations.
6. Document the symptom, the diagnosis and the fix for each.
:::

::: solution
```bash
dotnet tool install -g dotnet-counters
dotnet tool install -g dotnet-gcdump

dotnet-counters monitor -p <pid> --counters System.Runtime
dotnet-gcdump collect -p <pid> -o before.gcdump
# ... run load ...
dotnet-gcdump collect -p <pid> -o after.gcdump
```

Open both in Visual Studio or PerfView and compare object counts. A type whose instance count grows with load and never falls is your leak.

**Leak 1 — the static collection.** Symptom: `gen2-gc-count` climbs, `gc-heap-size` never falls after collections. Diagnosis: the gcdump shows `TaskItem` instances rooted by a static field. Fix: bound it (`MemoryCache` with a size limit and expiry) or remove it.

**Leak 2 — the event subscription.** Symptom: the same, but the retaining path in the dump is a delegate's invocation list. Fix: `-=` in `Dispose`, and implement `IDisposable` on the subscriber.

**Leak 3 — `new HttpClient()` per request.** This one is different and worth understanding, because it is not a managed-memory leak at all.

```csharp
public async Task<string> FetchAsync()
{
    using var client = new HttpClient();        // ❌ disposed correctly, still broken
    return await client.GetStringAsync(url);
}
```

Disposing `HttpClient` closes the underlying socket, and the socket enters `TIME_WAIT` for up to four minutes. Under load you exhaust the ephemeral port range and every outbound call fails with `SocketException: address already in use` — while the managed heap looks perfectly healthy. That is why it is so confusing.

Diagnosis: `netstat -an | grep TIME_WAIT | wc -l` climbing into the thousands.

Fix: `IHttpClientFactory`.
```csharp
builder.Services.AddHttpClient<IWebhookSender, HttpWebhookSender>();
```
It pools the handlers (and rotates them so DNS changes are picked up), which is the specific problem a long-lived static `HttpClient` has.

**The test for requirement 5:**
```csharp
[Fact]
public async Task Repeated_operations_do_not_grow_the_heap()
{
    for (var i = 0; i < 1000; i++) await service.CreateAsync(command, default);   // warm up
    GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
    var before = GC.GetTotalMemory(true);

    for (var i = 0; i < 10_000; i++) await service.CreateAsync(command, default);
    GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
    var after = GC.GetTotalMemory(true);

    (after - before).ShouldBeLessThan(10 * 1024 * 1024);
}
```
The warm-up matters: the first thousand operations populate caches and JIT the code paths, and counting that as growth makes the test flaky. This is one of the two places `GC.Collect()` is legitimate.
:::

::: project Memory hygiene in TaskFlow
1. Audit every `IDisposable` — is it disposed, by whom?
2. Every type owning a resource implements `IDisposable` or `IAsyncDisposable`.
3. No finalizers; `SafeHandle` if you ever hold a raw handle.
4. `IHttpClientFactory` for every outbound call.
5. Every cache bounded with a size limit and expiry.
6. Every event subscription unsubscribed in `Dispose`.
7. The memory-growth test.
8. Run under load with `dotnet-counters` and record heap size, gen-2 count and pause durations.

Commit.
:::

::: interview How does garbage collection work in .NET, and what is IDisposable for?
The GC is generational. New objects go to gen 0, which is collected frequently and cheaply because most objects die young; survivors are promoted to gen 1 and then gen 2, which is collected rarely and expensively. Objects of 85KB or more go on the Large Object Heap, which is not compacted by default. Allocation is a pointer bump, so short-lived allocation is cheap; the costly pattern is objects that live long enough to be promoted and then die.

`IDisposable` exists because the GC manages *memory*, not other resources. File handles, sockets, database connections and OS locks need deterministic release, which is what `Dispose` and `using` provide. `IAsyncDisposable` is for cleanup that does I/O, like flushing a buffer, so it does not block a thread.

I would avoid writing finalizers — they promote the object a generation, run on a single thread at an unpredictable time, and `SafeHandle` already does it correctly for raw handles. And the classic .NET leak worth mentioning is not really a memory leak: `new HttpClient()` per request exhausts sockets through `TIME_WAIT` while the managed heap looks fine. `IHttpClientFactory` is the fix.
:::

::: checkpoint
- [ ] I watched gen 0/1/2 collection counts change under different allocation patterns
- [ ] I confirmed an 85KB array lands on the LOH
- [ ] I reproduced and fixed all three leak types
- [ ] No finalizers in my code
- [ ] Every outbound HTTP call goes through `IHttpClientFactory`
- [ ] I have a test that fails on unbounded memory growth
:::

## Common mistakes

::: mistake
**`GC.Collect()` to fix memory growth.** It cannot reclaim anything still referenced.

**`new HttpClient()` per request.** Socket exhaustion that looks nothing like a leak.

**Writing a finalizer.** Almost always wrong; `SafeHandle` instead.

**Unbounded caches.** Everything promotes to gen 2 and full collections get slower forever.

**Not disposing what you created.** Connections, streams and locks are not the GC's problem.

**Micro-optimising short-lived allocations.** Gen 0 is nearly free; optimise what you measured.
:::
