---
title: Rate limiting and resilience
summary: Protecting yourself from callers, and from the services you depend on.
minutes: 40
---

## What are we learning?

Built-in rate limiting for inbound traffic, and resilience pipelines for outbound calls.

## Rate limiting

```csharp
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    options.OnRejected = async (context, ct) =>
    {
        if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
            context.HttpContext.Response.Headers.RetryAfter = ((int)retryAfter.TotalSeconds).ToString();

        await context.HttpContext.Response.WriteAsJsonAsync(new ProblemDetails
        {
            Status = 429,
            Title = "Too many requests",
            Detail = "Slow down and retry after the interval in the Retry-After header."
        }, ct);
    };

    // global: per authenticated user, or per IP for anonymous callers
    options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(context =>
        RateLimitPartition.GetTokenBucketLimiter(
            partitionKey: context.User.GetUserId()?.ToString()
                          ?? context.Connection.RemoteIpAddress?.ToString()
                          ?? "anonymous",
            factory: _ => new TokenBucketRateLimiterOptions
            {
                TokenLimit = 100,
                TokensPerPeriod = 100,
                ReplenishmentPeriod = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
                AutoReplenishment = true
            }));

    // stricter, named policies
    options.AddFixedWindowLimiter("auth", o =>
    {
        o.PermitLimit = 5;
        o.Window = TimeSpan.FromMinutes(1);
        o.QueueLimit = 0;
    });

    options.AddConcurrencyLimiter("export", o =>
    {
        o.PermitLimit = 3;
        o.QueueLimit = 10;
        o.QueueProcessingOrder = QueueProcessingOrder.OldestFirst;
    });
});

app.UseRateLimiter();
```

```csharp
[EnableRateLimiting("auth")]
public async Task<IActionResult> Login(LoginRequest request, CancellationToken ct) { }

[DisableRateLimiting]
public IActionResult Health() => Ok();
```

### The four algorithms

| Algorithm | Behaviour | Good for |
|---|---|---|
| **Fixed window** | N per fixed interval | Simple limits; suffers boundary bursts |
| **Sliding window** | N per rolling interval | Smoother; more memory |
| **Token bucket** | Refills at a rate, allows bursts | General API limits — **the usual choice** |
| **Concurrency** | N simultaneous, others queue | Expensive operations: exports, reports |

The fixed-window boundary problem is worth knowing: with a limit of 100 per minute, a caller can send 100 at 59 seconds and 100 at 61 seconds — 200 in two seconds, within the rules. Token bucket does not have this.

::: warn Rate limiting behind a proxy limits your proxy
Without forwarded-headers configuration, `RemoteIpAddress` is your load balancer's address, so every user shares one partition and you rate-limit your entire user base as a single client.

```csharp
app.UseForwardedHeaders(new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto,
    KnownProxies = { IPAddress.Parse("10.0.0.1") }
});
```
**First** in the pipeline, before the rate limiter. And set `KnownProxies` or `KnownNetworks` — without them the middleware ignores the header entirely by default, which is a safe default that looks like it is not working.

Also note: the built-in limiter is **per instance**. Three replicas with a 100/minute limit permit 300/minute in total. For a hard global limit you need a distributed limiter backed by Redis, or enforcement at the gateway.
:::

## Outbound resilience

```bash
dotnet add package Microsoft.Extensions.Http.Resilience
```

```csharp
builder.Services.AddHttpClient<IWebhookSender, HttpWebhookSender>(client =>
{
    client.BaseAddress = new Uri(options.WebhookBaseUrl);
    client.Timeout = TimeSpan.FromSeconds(30);
})
.AddStandardResilienceHandler(options =>
{
    options.Retry.MaxRetryAttempts = 3;
    options.Retry.BackoffType = DelayBackoffType.Exponential;
    options.Retry.UseJitter = true;

    options.CircuitBreaker.FailureRatio = 0.5;
    options.CircuitBreaker.MinimumThroughput = 10;
    options.CircuitBreaker.SamplingDuration = TimeSpan.FromSeconds(30);
    options.CircuitBreaker.BreakDuration = TimeSpan.FromSeconds(15);

    options.AttemptTimeout.Timeout = TimeSpan.FromSeconds(10);
    options.TotalRequestTimeout.Timeout = TimeSpan.FromSeconds(30);
});
```

The standard pipeline, in order: total timeout → retry → circuit breaker → per-attempt timeout → the request.

::: warn Retrying non-idempotent requests duplicates work
A retried `POST` may create two tasks. The first attempt succeeded; the response was lost.

The resilience handler retries only on transient conditions — 5xx, 408, and network errors — which reduces but does not eliminate the risk, because a 500 can be returned *after* the write committed.

Three defences:
1. **Idempotency keys** (Phase 6) — the server recognises a repeat.
2. **Do not retry unsafe methods.** Configure `ShouldHandle` to exclude `POST` and `PATCH`.
3. **Make the operation naturally idempotent** — "set status to Completed" rather than "append a status change".

The first is the strongest, and it is why that filter exists.
:::

### Timeouts everywhere

```csharp
client.Timeout = TimeSpan.FromSeconds(30);                       // HttpClient
options.AttemptTimeout.Timeout = TimeSpan.FromSeconds(10);       // per attempt
npgsqlBuilder.CommandTimeout(30);                                // database command
cts.CancelAfter(TimeSpan.FromSeconds(5));                        // your own operation
```

`HttpClient`'s default timeout is **100 seconds**. A dependency that hangs will hold your thread and your caller for a minute and forty seconds before failing — long enough for the caller to give up, retry, and multiply the load on a struggling service. Set a real timeout on every client.

## Back-pressure and shedding

Under overload, rejecting fast is better than queuing:

```csharp
options.AddConcurrencyLimiter("export", o =>
{
    o.PermitLimit = 3;
    o.QueueLimit = 10;          // a SMALL queue, then reject
});
```

A large queue turns an overload into a latency disaster: requests wait two minutes, the client has already timed out, and you do the work anyway for a response nobody reads. A small queue plus a fast 429 lets clients back off — which is what `Retry-After` is for.

::: exercise Level 1 — Guided · Protect both directions
1. A global token-bucket limiter partitioned by user or IP.
2. A strict fixed-window limiter on `/api/auth/login`.
3. A concurrency limiter on export.
4. `Retry-After` and a `ProblemDetails` body on rejection.
5. Load-test the login endpoint and confirm a 429 with the header.
6. Configure forwarded headers; verify the partition key is the client IP, not the proxy's.
7. `AddStandardResilienceHandler` on an outbound client; use a deliberately flaky test endpoint.
8. Watch the circuit open, stay open, then half-open and recover.
:::

::: challenge Level 3 · Behaviour under overload
Requirements:

1. Load-test TaskFlow at 10×, 50× and 100× normal traffic.
2. At every level: no crash, no unbounded memory growth, no timeouts on health checks.
3. Excess load is rejected with 429 quickly — p99 for rejections under 10ms.
4. Accepted requests keep their normal latency.
5. The database connection pool is never exhausted.
6. Measure and graph: accepted rate, rejected rate, p50/p99 latency, memory, connection-pool usage.
7. Tune the limits based on what you measure, and justify each number.

Point 4 is the real goal. A system that degrades by making *everyone* slow has failed; one that serves a subset well and rejects the rest has succeeded.
:::

::: solution
The finding people are surprised by: **the database connection pool, not CPU, is almost always the binding constraint.**

Npgsql defaults to a maximum pool size of 100. At 100 concurrent requests each holding a connection, the 101st waits, and after `Timeout` (default 15 seconds) it fails with "The connection pool has been exhausted". Meanwhile CPU is at 20%.

So the rate limit has to be derived from the pool, not from CPU:

```text
Max concurrent DB operations   = pool size (100)
Average DB time per request    = 5ms
Theoretical max throughput     = 100 / 0.005 = 20,000 requests/second

Apply a safety factor for variance and background jobs: limit at ~8,000/second.
```

That is a justifiable number — derived from a measured constraint — rather than a guess.

The second finding: **a queue limit above about 20 is always wrong.**

```text
QueueLimit = 1000, arrival 10x capacity:
  p99 latency 45 seconds; clients time out at 30s; the work is done anyway,
  for responses nobody reads. Effective throughput: near zero.

QueueLimit = 10, same load:
  p99 for accepted requests 25ms; 90% rejected with 429 in under 5ms;
  clients back off and retry successfully. Effective throughput: full capacity.
```

Queuing converts an overload into a *latency* failure that affects everyone. Shedding converts it into a *partial* failure that affects some callers and leaves the system healthy. The second is strictly better, and it is counter-intuitive enough that people build the first.

The third finding: **health checks must bypass rate limiting.** If `/health/ready` is rate-limited, an overload causes health checks to fail, the orchestrator removes the instance, load shifts to the remaining instances, they overload, and you have cascaded a partial overload into a total outage. `[DisableRateLimiting]` on health endpoints is not an optimisation, it is a correctness requirement.
:::

::: project Rate limiting and resilience in TaskFlow
1. Global token bucket, strict limits on auth, concurrency limits on export and import.
2. Forwarded headers configured first, with known proxies.
3. `Retry-After` and `ProblemDetails` on rejection.
4. Health checks and metrics endpoints exempt.
5. `AddStandardResilienceHandler` on every outbound client, with real timeouts.
6. `POST` excluded from retry, or idempotency keys required.
7. A load test at 10×, 50× and 100×, with results in `DECISIONS.md`.
8. Every limit justified by a measured constraint.

Commit.
:::

::: interview How would you protect an API from being overwhelmed?
Inbound, with rate limiting — .NET has it built in with four algorithms. I would use a token bucket for the general limit, because it allows short bursts while bounding the sustained rate, partitioned by authenticated user or client IP, with stricter fixed-window limits on expensive or sensitive endpoints like login, and concurrency limits on exports.

Two details that are easy to get wrong. Behind a proxy you must configure forwarded headers first, or every request appears to come from the load balancer and you rate-limit your whole user base as one client. And health check endpoints must be exempt, or an overload makes health checks fail, the orchestrator pulls instances, and a partial overload cascades into a total outage.

The counter-intuitive part is queue depth: a large queue is worse than a small one. Queuing turns overload into a latency failure for everyone — clients time out and you do the work anyway. A small queue plus a fast 429 with `Retry-After` lets clients back off and keeps the accepted traffic at normal latency.

Outbound, I use the resilience pipeline: per-attempt and total timeouts, retry with exponential backoff and jitter, and a circuit breaker so a failing dependency fails fast instead of consuming threads.
:::

::: checkpoint
- [ ] Rate limits are derived from a measured constraint, not guessed
- [ ] Forwarded headers are configured and verified
- [ ] Health checks bypass rate limiting
- [ ] Queue limits are small and I know why
- [ ] Every outbound client has a real timeout
- [ ] I watched a circuit breaker open, hold and recover
:::

## Common mistakes

::: mistake
**Rate limiting without forwarded headers.** You limit your load balancer.

**Large queue limits.** Overload becomes a latency disaster for everyone.

**Rate-limiting health checks.** A partial overload cascades into a total outage.

**`HttpClient`'s default 100-second timeout.** A hung dependency holds your threads.

**Retrying `POST` without idempotency keys.** Duplicate writes.
:::
