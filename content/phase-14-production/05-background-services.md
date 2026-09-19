---
title: Background services
summary: Work that happens outside a request — and doing it without losing data or leaking scopes.
minutes: 40
---

## What are we learning?

`IHostedService` and `BackgroundService`, scope management, scheduling, and making background work survive a restart.

## `BackgroundService`

```csharp
public sealed class OutboxProcessor(
    IServiceScopeFactory scopeFactory,
    ILogger<OutboxProcessor> logger,
    TimeProvider clock) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Outbox processor started.");

        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5), clock);

        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                await ProcessBatchAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;                                   // shutting down — expected
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Outbox batch failed; will retry on the next tick.");
                // DO NOT rethrow — that would kill the service permanently
            }
        }

        logger.LogInformation("Outbox processor stopping.");
    }

    private async Task ProcessBatchAsync(CancellationToken ct)
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<TaskFlowDbContext>();
        // ...
    }
}

builder.Services.AddHostedService<OutboxProcessor>();
```

::: warn Three things that will bite you
**1. An unhandled exception silently stops the service.** In .NET 6+ the default `BackgroundServiceExceptionBehavior` is `StopHost`, which at least takes the process down visibly. If you change it to `Ignore`, your service dies quietly and nothing processes the outbox for three days. Always catch inside the loop and log.

**2. You cannot inject scoped services.** A hosted service is a **singleton**. Injecting `DbContext` is the captive dependency from Phase 5, with the worst consequences — one context alive for the process lifetime, accumulating tracked entities and dying with a stale connection. Always `CreateAsyncScope()` per unit of work.

**3. `ExecuteAsync` blocks startup if it does not yield.** The host awaits `StartAsync` until the first `await` in `ExecuteAsync` yields. Synchronous work before that first yield delays the whole application from accepting traffic.
```csharp
protected override async Task ExecuteAsync(CancellationToken ct)
{
    await Task.Yield();          // return to the host immediately
    // ... long setup ...
}
```
:::

## `PeriodicTimer` over `Task.Delay`

```csharp
// ❌ drifts: the period becomes 5s + however long the work took
while (!ct.IsCancellationRequested)
{
    await DoWorkAsync(ct);
    await Task.Delay(TimeSpan.FromSeconds(5), ct);
}

// ✅ fixed cadence, and no overlap
using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5), clock);
while (await timer.WaitForNextTickAsync(ct))
    await DoWorkAsync(ct);
```

`PeriodicTimer` ticks on a schedule rather than a delay, and it never overlaps — if the work takes longer than the period, the next tick is skipped rather than starting a concurrent run. Passing a `TimeProvider` makes it testable with `FakeTimeProvider` (Phase 10).

## Queued work

For work triggered by a request but not part of it:

```csharp
public sealed class BackgroundTaskQueue
{
    private readonly Channel<Func<IServiceProvider, CancellationToken, ValueTask>> _channel =
        Channel.CreateBounded<Func<IServiceProvider, CancellationToken, ValueTask>>(
            new BoundedChannelOptions(capacity: 1000) { FullMode = BoundedChannelFullMode.Wait });

    public ValueTask EnqueueAsync(Func<IServiceProvider, CancellationToken, ValueTask> work, CancellationToken ct) =>
        _channel.Writer.WriteAsync(work, ct);

    public IAsyncEnumerable<Func<IServiceProvider, CancellationToken, ValueTask>> ReadAllAsync(CancellationToken ct) =>
        _channel.Reader.ReadAllAsync(ct);
}

public sealed class QueuedHostedService(BackgroundTaskQueue queue, IServiceScopeFactory scopes, ILogger<QueuedHostedService> logger)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var work in queue.ReadAllAsync(stoppingToken))
        {
            await using var scope = scopes.CreateAsyncScope();
            try { await work(scope.ServiceProvider, stoppingToken); }
            catch (Exception ex) { logger.LogError(ex, "Queued work item failed."); }
        }
    }
}
```

::: warn In-memory queues lose work on restart
A `Channel<T>` lives in memory. A deployment, a crash or an OOM kill discards everything queued.

That is acceptable for genuinely optional work — warming a cache, sending a non-critical notification. It is not acceptable for anything a user was told would happen.

For work that must not be lost, the queue must be **durable**: the outbox table from Phase 7, or a real broker (RabbitMQ, Azure Service Bus, SQS). The rule is simple: **if losing it would require an apology, it goes in the database, not in memory.**
:::

## Several instances

```text
1 instance   → the timer fires once per period. Fine.
3 instances  → the timer fires three times per period. Every job runs three times.
```

Three ways to handle it:

**1. Leader election.** One instance holds a lease and does the work.
```csharp
var acquired = await db.Database.ExecuteSqlAsync(
    $"SELECT pg_try_advisory_lock({LockId})");     // PostgreSQL advisory lock
```

**2. Claim rows atomically.** The `FOR UPDATE SKIP LOCKED` pattern from Phase 7 — every instance processes a disjoint subset, and it scales rather than idling two thirds of your capacity.

**3. A separate worker deployment.** Run the background service as its own single-replica deployment, and keep the API stateless. Cleanest for anything substantial.

**Option 2 is usually best** for queue-shaped work: no coordination, no single point of failure, and throughput that scales with replicas.

## Scheduling

`PeriodicTimer` handles "every N minutes". For "every weekday at 09:00", use Quartz.NET or Hangfire:

```bash
dotnet add package Quartz.Extensions.Hosting
```

```csharp
builder.Services.AddQuartz(q =>
{
    q.UseDefaultThreadPool(tp => tp.MaxConcurrency = 5);

    q.AddJob<OverdueNotificationJob>(j => j.WithIdentity("overdue-notifications"));
    q.AddTrigger(t => t
        .ForJob("overdue-notifications")
        .WithCronSchedule("0 0 9 ? * MON-FRI", x => x.InTimeZone(TimeZoneInfo.Utc)));
});
builder.Services.AddQuartzHostedService(o => o.WaitForJobsToComplete = true);
```

With a persistent job store, Quartz also handles clustering and missed executions — a job that should have run while the process was down is not silently skipped.

::: exercise Level 1 — Guided · Three background services
1. `OutboxProcessor` with `PeriodicTimer`, claiming rows with `FOR UPDATE SKIP LOCKED`.
2. `OverdueNotificationService` running daily, scoped correctly.
3. A queued service for optional work, with a bounded channel.
4. Prove point 2 of the warning box: inject `DbContext` directly and watch `ValidateScopes` reject it at startup.
5. Prove point 1: throw from the loop without catching, and observe what happens to the service.
6. Test with `FakeTimeProvider`: advance the clock and assert the work ran, with no waiting.
7. Run three instances and confirm each job runs once in total.
:::

::: challenge Level 3 · A background system that survives anything
Requirements:

1. The outbox is processed by all instances, with no duplicates and no coordination service.
2. A crash mid-processing leaves no message lost and none double-delivered — or, if exactly-once is impossible, document precisely which guarantee you provide.
3. Failed messages retry with backoff; after five attempts they move to a dead-letter state with the error recorded.
4. A poison message cannot block the queue.
5. Graceful shutdown finishes the current batch and stops cleanly within the shutdown timeout.
6. Metrics: queue depth, processing rate, failure rate, dead-letter count, oldest unprocessed age.
7. A health check reporting `Degraded` when the queue is backing up.
8. A test that kills the process mid-batch and asserts recovery on restart.
:::

::: solution
**Requirement 2 deserves an honest answer rather than a claim.**

You cannot have exactly-once delivery across a database and an external system. The unavoidable window: the external call succeeds, then the process dies before marking the message processed. On restart, the message is redelivered.

What you *can* guarantee is **at-least-once**, and then make consumers idempotent — which is why Phase 6 built idempotency keys. Say this explicitly:

```csharp
/// <summary>
/// Delivery guarantee: AT-LEAST-ONCE.
/// A message may be delivered more than once if the process fails between the
/// external call succeeding and the transaction committing. Consumers must be
/// idempotent — every outbound call carries the message id as an idempotency key.
/// </summary>
```

Claiming exactly-once when you have at-least-once is how downstream systems end up with duplicate charges.

**Requirement 5** needs care, because `stoppingToken` fires immediately on shutdown:

```csharp
protected override async Task ExecuteAsync(CancellationToken stoppingToken)
{
    using var timer = new PeriodicTimer(_interval, clock);

    while (await timer.WaitForNextTickAsync(stoppingToken))
    {
        // A batch gets its own token so it can finish cleanly during shutdown,
        // bounded by the host's shutdown timeout.
        using var batchCts = new CancellationTokenSource(TimeSpan.FromSeconds(25));
        await ProcessBatchAsync(batchCts.Token);
    }

    // Once the loop exits, drain whatever is in flight.
    using var drainCts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
    await ProcessBatchAsync(drainCts.Token);
}
```

Passing `stoppingToken` straight into the batch would abandon in-flight work mid-transaction on every deployment. Configure `HostOptions.ShutdownTimeout` to exceed the batch budget, or the host kills you anyway.

**Requirement 4, the poison message**, is the attempts counter plus the dead-letter state — but the subtle part is that `FOR UPDATE SKIP LOCKED` already prevents blocking: a message another worker is processing is skipped, not waited on. A message that repeatedly fails is retried on a backoff schedule via `next_attempt_at`, so it never occupies a worker continuously.

**Requirement 7's health check** is the best operational signal in this lesson:
```csharp
var oldest = await db.OutboxMessages
    .Where(m => m.ProcessedAt == null)
    .MinAsync(m => (DateTimeOffset?)m.CreatedAt, ct);

var age = oldest is null ? TimeSpan.Zero : clock.GetUtcNow() - oldest.Value;

return age switch
{
    { TotalMinutes: > 15 } => HealthCheckResult.Unhealthy($"Oldest unprocessed message is {age.TotalMinutes:F0} minutes old."),
    { TotalMinutes: > 5 }  => HealthCheckResult.Degraded($"Outbox is falling behind: {age.TotalMinutes:F0} minutes."),
    _ => HealthCheckResult.Healthy()
};
```
**Age of the oldest unprocessed item** beats queue depth as a signal, because depth tells you how much work there is and age tells you whether you are keeping up. A depth of 10,000 processed in 30 seconds is fine; a depth of 5 that has not moved in an hour is an incident.
:::

::: project Background services for TaskFlow
1. `OutboxProcessor` with claim-based concurrency, retry, backoff and dead-lettering.
2. `OverdueNotificationJob` on a schedule.
3. A queued service for optional work.
4. Correct scoping everywhere; `ValidateScopes` on.
5. Graceful shutdown that drains.
6. Metrics and a health check based on oldest-message age.
7. Tests using `FakeTimeProvider`, plus the kill-and-restart test.
8. `DECISIONS.md`: your delivery guarantee, stated precisely.

Commit.
:::

::: interview How do you run background work in ASP.NET Core?
With `IHostedService`, usually via the `BackgroundService` base class, registered with `AddHostedService`. It runs alongside the web host and gets a `stoppingToken` for graceful shutdown.

Three things matter. A hosted service is a singleton, so you cannot inject scoped services like `DbContext` — you inject `IServiceScopeFactory` and create a scope per unit of work. An unhandled exception in the loop stops the service, so you catch and log inside the loop rather than letting it escape. And `PeriodicTimer` is better than `await Task.Delay` in a loop, because it keeps a fixed cadence rather than drifting and does not overlap runs.

For work that must not be lost I use a durable queue — an outbox table or a broker — rather than an in-memory channel, because a channel is discarded on restart. With multiple instances, I claim rows atomically using `FOR UPDATE SKIP LOCKED` so every replica processes a disjoint subset without any leader election.

And I would be precise about the guarantee: this gives at-least-once delivery, not exactly-once, so consumers need to be idempotent.
:::

::: checkpoint
- [ ] Every background service creates its own scope
- [ ] Exceptions are caught inside the loop
- [ ] `PeriodicTimer` with an injected `TimeProvider`, tested without waiting
- [ ] Three instances process each job exactly once in total
- [ ] I can state my delivery guarantee precisely
- [ ] My health check uses oldest-message age, not just depth
:::

## Common mistakes

::: mistake
**Injecting a scoped service into a hosted service.** Captive dependency.

**Letting an exception escape the loop.** The service stops, silently or otherwise.

**`Task.Delay` in a loop.** Drift, and overlapping runs.

**In-memory queues for work that matters.** Lost on every deployment.

**Passing `stoppingToken` into a batch.** In-flight work is abandoned mid-transaction on every deploy.

**Claiming exactly-once delivery.** You have at-least-once. Say so.
:::
