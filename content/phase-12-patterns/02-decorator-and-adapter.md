---
title: Decorator and Adapter
summary: Adding behaviour without changing a class, and making an incompatible interface fit.
minutes: 35
---

## What are we learning?

Two structural patterns you have already used in this course, named and sharpened.

## The problem shapes

```text
DECORATOR   "I want to add behaviour to an existing implementation without modifying it."
ADAPTER     "I have something that does the job but the wrong shape."
```

Both wrap an object. The difference is intent: a decorator **keeps the same interface** and adds behaviour; an adapter **changes the interface**.

## Decorator

You built one in Phase 1 without knowing its name:

```csharp
public sealed class LoggingTaskStore(ITaskStore inner, ILogger<LoggingTaskStore> logger) : ITaskStore
{
    public async Task<TaskItem?> GetAsync(Guid id, CancellationToken ct = default)
    {
        logger.LogDebug("Getting task {TaskId}", id);
        var task = await inner.GetAsync(id, ct);
        logger.LogDebug("Task {TaskId} was {Result}", id, task is null ? "not found" : "found");
        return task;
    }
}
```

They compose, in any order:

```csharp
ITaskStore store =
    new LoggingTaskStore(
        new TimingTaskStore(
            new CachingTaskStore(
                new RetryingTaskStore(
                    new EfTaskStore(db))))); 
```

Each layer knows nothing about the others. Removing caching is deleting one line.

::: design Decorator order matters, and the choice is meaningful
```text
Logging → Timing → Caching → Retry → EF Core
```
- **Logging outermost**: logs every call, including cache hits — so you see the real call rate.
- **Timing next**: measures the whole operation as the caller experiences it.
- **Caching before retry**: a cache hit never reaches the retry logic, which is the point.
- **Retry innermost**: retries only the actual I/O.

Swap caching and retry and you would retry a cache lookup, which cannot fail transiently — pointless. Move timing inside caching and your metrics would report only cache misses, making the system look slower than it is.

State the order and the reason in `DECISIONS.md`. It is one of those decisions that looks arbitrary and is not.
:::

### Registering decorators

The built-in container has no `Decorate` method, so you compose manually:

```csharp
services.AddScoped<EfTaskStore>();
services.AddScoped<ITaskStore>(sp =>
    new LoggingTaskStore(
        new CachingTaskStore(
            sp.GetRequiredService<EfTaskStore>(),
            sp.GetRequiredService<IMemoryCache>()),
        sp.GetRequiredService<ILogger<LoggingTaskStore>>()));
```

Or use **Scrutor**, which adds the missing method:

```bash
dotnet add package Scrutor
```
```csharp
services.AddScoped<ITaskStore, EfTaskStore>();
services.Decorate<ITaskStore, CachingTaskStore>();
services.Decorate<ITaskStore, LoggingTaskStore>();     // applied last = outermost
```

Much more readable, and the order is explicit in the registration order.

## Adapter

```csharp
// A third-party client with a shape you did not choose
public sealed class SendGridClient
{
    public Task<SendGridResponse> SendEmailAsync(SendGridMessage message, CancellationToken ct);
}

// Your contract, in your vocabulary
public interface IEmailSender
{
    Task SendAsync(EmailMessage message, CancellationToken ct = default);
}

// The adapter
public sealed class SendGridEmailSender(SendGridClient client, IOptions<EmailOptions> options) : IEmailSender
{
    public async Task SendAsync(EmailMessage message, CancellationToken ct = default)
    {
        var sendGridMessage = new SendGridMessage
        {
            From = new EmailAddress(options.Value.FromAddress, options.Value.FromName),
            Subject = message.Subject,
            PlainTextContent = message.Body,
            HtmlContent = message.HtmlBody
        };
        sendGridMessage.AddTo(message.To);

        var response = await client.SendEmailAsync(sendGridMessage, ct);

        if (!response.IsSuccessStatusCode)
            throw new EmailDeliveryException(
                $"SendGrid returned {(int)response.StatusCode}", message.To);
    }
}
```

::: why Why the adapter earns its place
1. **Your code depends on your contract**, so swapping SendGrid for Postmark changes one class.
2. **Third-party exceptions are translated** into your vocabulary, so the application layer never catches `SendGridException`.
3. **It is mockable.** `SendGridClient` is a sealed class with no interface — as third-party clients often are — so without the adapter your service is untestable.
4. **Configuration lives in one place**, not at every call site.

This is exactly the Dependency Inversion pattern from Phase 11, applied to an external dependency. **Every third-party client should be behind an adapter you own.**
:::

## Decorator vs. middleware vs. filter vs. AOP

| Mechanism | Scope | Best for |
|---|---|---|
| Middleware | Every HTTP request | Transport concerns: correlation ids, headers, compression |
| Filter | Every action | HTTP-aware concerns: validation, idempotency |
| Decorator | Every call to one interface | Service concerns: caching, retry, logging, timing |
| Interceptor (Castle.DynamicProxy) | Every call to anything | Cross-cutting at scale — powerful, and opaque |

A decorator is explicit and debuggable: you can step into it. An interceptor generates a proxy at runtime, so the call stack is full of generated frames and "why is this happening" becomes hard to answer. Prefer decorators until you have dozens of them.

::: exercise Level 1 — Guided · Build a decorator stack
1. `CachingTaskStore` — cache by id with a short expiry, invalidating on write.
2. `RetryingTaskStore` — retry transient failures with backoff.
3. `TimingTaskStore` — record duration, warn over 100ms.
4. `LoggingTaskStore` — structured logs.
5. Compose them in the order from the design box.
6. Prove each works: a cache hit skips the inner store; a transient failure is retried; a slow call warns.
7. Reorder caching and retry, and explain what changes.
8. Register them with Scrutor and compare readability.
:::

::: challenge Level 3 · A resilient outbound adapter
Build an adapter for an external service with everything a production integration needs.

Requirements:
1. `IWebhookSender` in your vocabulary; the HTTP details hidden.
2. Retry with exponential backoff and jitter on transient failures only.
3. A circuit breaker: after 5 consecutive failures, fail fast for 30 seconds.
4. A per-request timeout.
5. Metrics: attempts, successes, failures, circuit state.
6. Third-party and HTTP exceptions translated to your own type.
7. Fully testable without any network.
8. Implemented as decorators so each concern is separately testable.

Then rewrite it using `Microsoft.Extensions.Http.Resilience` and compare.
:::

::: solution
The hand-built version, one decorator per concern:

```csharp
public sealed class CircuitBreakerWebhookSender(IWebhookSender inner, TimeProvider clock) : IWebhookSender
{
    private int _consecutiveFailures;
    private DateTimeOffset _openUntil = DateTimeOffset.MinValue;

    public async Task SendAsync(WebhookMessage message, CancellationToken ct = default)
    {
        if (clock.GetUtcNow() < _openUntil)
            throw new CircuitOpenException($"Circuit open until {_openUntil:O}.");

        try
        {
            await inner.SendAsync(message, ct);
            Interlocked.Exchange(ref _consecutiveFailures, 0);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            if (Interlocked.Increment(ref _consecutiveFailures) >= 5)
                _openUntil = clock.GetUtcNow().AddSeconds(30);
            throw;
        }
    }
}
```

Testing the circuit is now trivial with `FakeTimeProvider`:
```csharp
for (var i = 0; i < 5; i++) await Try(() => sender.SendAsync(message));
await Should.ThrowAsync<CircuitOpenException>(() => sender.SendAsync(message));

clock.Advance(TimeSpan.FromSeconds(31));
await sender.SendAsync(message);       // half-open, tries again
```

**And then the honest conclusion:** you should not ship this. Use the built-in resilience pipeline:

```csharp
builder.Services.AddHttpClient<IWebhookSender, HttpWebhookSender>()
    .AddStandardResilienceHandler(options =>
    {
        options.Retry.MaxRetryAttempts = 3;
        options.Retry.UseJitter = true;
        options.CircuitBreaker.FailureRatio = 0.5;
        options.CircuitBreaker.SamplingDuration = TimeSpan.FromSeconds(30);
        options.AttemptTimeout.Timeout = TimeSpan.FromSeconds(10);
        options.TotalRequestTimeout.Timeout = TimeSpan.FromSeconds(30);
    });
```

Five lines, built on Polly, with metrics, telemetry and correct handling of concurrency, half-open state and the thundering-herd problem — all of which the hand-rolled version above gets subtly wrong. (`_openUntil` written from multiple threads without synchronisation, for one; and a simple consecutive-failure count rather than a failure *ratio*, which misbehaves under mixed traffic.)

**Why build it first anyway?** Because now you know what `AddStandardResilienceHandler` is doing, you can configure it deliberately, and you can debug it when the circuit opens unexpectedly. That is the difference between using a library and depending on one.
:::

::: project Decorators in TaskFlow
1. A decorator stack over `ITaskStore`: logging, timing, caching, retry.
2. Registered with Scrutor, in a documented order.
3. Adapters for every third-party client, with exceptions translated.
4. `AddStandardResilienceHandler` on outbound HTTP.
5. Each decorator tested in isolation with a substitute inner.
6. `DECISIONS.md`: the decorator order, with reasons.

Commit.
:::

::: interview What is the Decorator pattern and where have you used it?
A decorator implements the same interface as the thing it wraps and adds behaviour around it, so you can compose concerns without modifying the original class or the callers.

I use it for cross-cutting concerns on services: caching, retry, timing and logging around a repository. Each is a separate class implementing the same interface, composed in a deliberate order — logging outermost so it sees every call, caching before retry so a cache hit never enters the retry logic, retry innermost so it only wraps the real I/O.

The related pattern is Adapter, which also wraps but changes the interface — that is how I put every third-party client behind a contract I own, which makes it substitutable and testable and stops the vendor's exception types leaking into the application layer.

ASP.NET Core middleware is the same idea applied to the request pipeline.
:::

::: checkpoint
- [ ] I can state the difference between Decorator and Adapter
- [ ] My decorator order is deliberate and documented
- [ ] I proved a cache hit never reaches the inner store
- [ ] Every third-party client sits behind an adapter I own
- [ ] I built resilience by hand and then replaced it with the library
:::

## Common mistakes

::: mistake
**Decorators that know about each other.** They must be independently composable.

**Wrong decorator order.** Metrics that only measure cache misses; retries of cache lookups.

**No adapter around a third-party client.** Untestable, and the vendor's types spread through your codebase.

**Hand-rolled circuit breakers in production.** The concurrency and half-open logic is easy to get subtly wrong.

**Decorating everything.** Five layers of indirection for a call that never needed any.
:::
