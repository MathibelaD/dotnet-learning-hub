---
title: Health checks and diagnostics
summary: Telling an orchestrator whether you are alive, ready, and healthy — three different questions.
minutes: 30
---

## What are we learning?

Health checks that mean something, and the distinction between liveness and readiness that decides whether a deployment works.

## Three questions

```text
LIVENESS    "Is this process functioning, or should it be restarted?"
READINESS   "Can this instance serve traffic right now?"
HEALTH      "Is everything this service depends on working?"
```

They need different answers, and conflating them causes outages.

::: warn The classic mistake: a liveness probe that checks the database
```csharp
app.MapHealthChecks("/health");        // includes a database check
// Kubernetes liveness probe → /health
```

The database goes down. Every instance reports unhealthy. Kubernetes restarts them all. They come back, still cannot reach the database, and are killed again — a crash loop. Now when the database recovers, you have no warm instances, no caches, and a thundering herd of restarts.

**Liveness must only check whether the process itself is stuck.** A dead database is not a reason to restart your application; it is a reason to stop accepting traffic and report the problem.

```text
Liveness  → is the process responsive?           → restart if not
Readiness → can I serve a request successfully?  → remove from the load balancer if not
```

Getting this wrong turns a dependency outage into a total outage.
:::

## Setting them up

```bash
dotnet add package AspNetCore.HealthChecks.NpgSql
dotnet add package AspNetCore.HealthChecks.UI.Client
```

```csharp
builder.Services.AddHealthChecks()
    // liveness: nothing external
    .AddCheck("self", () => HealthCheckResult.Healthy(), tags: ["live"])

    // readiness: the things needed to serve a request
    .AddNpgSql(connectionString, name: "database", tags: ["ready"],
               timeout: TimeSpan.FromSeconds(3))
    .AddCheck<MigrationsHealthCheck>("migrations", tags: ["ready"])

    // health: everything, including non-critical dependencies
    .AddUrlGroup(new Uri(smtpHealthUrl), name: "email", tags: ["health"],
                 failureStatus: HealthStatus.Degraded)
    .AddCheck<DiskSpaceHealthCheck>("disk", tags: ["health"]);
```

```csharp
app.MapHealthChecks("/health/live", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("live")
});

app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("ready"),
    ResponseWriter = UIResponseWriter.WriteHealthCheckUIResponse
});

app.MapHealthChecks("/health", new HealthCheckOptions
{
    ResponseWriter = UIResponseWriter.WriteHealthCheckUIResponse
}).RequireAuthorization("Admin");      // the detailed one is not public
```

The detailed endpoint exposes your dependency topology, versions and error messages — useful to you, and to anyone probing you. Keep it authenticated.

## A custom check

```csharp
public sealed class MigrationsHealthCheck(TaskFlowDbContext db) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context, CancellationToken ct = default)
    {
        try
        {
            var pending = (await db.Database.GetPendingMigrationsAsync(ct)).ToList();

            return pending.Count == 0
                ? HealthCheckResult.Healthy("Schema is up to date.")
                : HealthCheckResult.Unhealthy(
                    $"{pending.Count} migration(s) pending: {string.Join(", ", pending)}",
                    data: new Dictionary<string, object> { ["pending"] = pending });
        }
        catch (Exception ex)
        {
            return HealthCheckResult.Unhealthy("Cannot reach the database.", ex);
        }
    }
}
```

Three results, and the middle one matters:

| Result | Meaning | Orchestrator action |
|---|---|---|
| `Healthy` | Working | Serve traffic |
| `Degraded` | Working, but something is wrong | **Still serves traffic** — alert someone |
| `Unhealthy` | Cannot serve | Remove from the load balancer |

`Degraded` is for non-critical dependencies. If email is down, TaskFlow can still create and complete tasks — so it is degraded, not unhealthy. Marking it unhealthy would take the whole service offline because notifications are broken.

## Startup probes

An application that takes 40 seconds to start — warming caches, running migrations, JIT-ing — will be killed by a liveness probe with a 30-second threshold, forever.

```yaml
startupProbe:
  httpGet: { path: /health/live, port: 8080 }
  failureThreshold: 30
  periodSeconds: 2          # allows up to 60s to start

livenessProbe:
  httpGet: { path: /health/live, port: 8080 }
  periodSeconds: 10
  failureThreshold: 3       # only begins after the startup probe passes

readinessProbe:
  httpGet: { path: /health/ready, port: 8080 }
  periodSeconds: 5
  failureThreshold: 2
```

The startup probe suspends the liveness probe until the application has started once. Without it you either set the liveness threshold absurdly high (and a genuinely stuck process takes minutes to be restarted) or you crash-loop on every deployment.

## Graceful shutdown

```csharp
builder.Services.Configure<HostOptions>(o =>
{
    o.ShutdownTimeout = TimeSpan.FromSeconds(30);
});

app.Lifetime.ApplicationStopping.Register(() =>
{
    // Report not-ready FIRST, so the load balancer stops sending new requests,
    // then keep serving in-flight ones until they finish.
    healthState.MarkNotReady();
});
```

The sequence that avoids dropped requests on every deployment:

```text
1. Readiness starts failing         → the load balancer stops sending new requests
2. Wait for the LB's check interval → typically 5-15 seconds
3. Finish in-flight requests
4. Stop background services
5. Flush logs and telemetry
6. Exit
```

Skipping step 2 is the most common cause of "we see a burst of 502s on every deploy": the process exits while the load balancer still believes it is healthy.

::: exercise Level 1 — Guided · Three endpoints
1. Add health checks with `live`, `ready` and `health` tags.
2. Map three endpoints; secure the detailed one.
3. A custom check for pending migrations.
4. A custom check for the outbox depth, returning `Degraded` above 1,000 and `Unhealthy` above 10,000.
5. Stop PostgreSQL (`docker compose stop db`) and check each endpoint. Liveness must still pass.
6. Restart it and confirm readiness recovers with no restart.
7. Add a slow check and confirm the timeout works.
8. Implement graceful shutdown and confirm in-flight requests complete.
:::

::: challenge Level 3 · Deployment without dropped requests
Requirements:

1. A load generator sending 100 requests per second at TaskFlow.
2. Deploy a new version while it runs.
3. **Zero** failed requests during the rollover.
4. Measure and prove it — count non-2xx responses across the deployment.
5. Then remove the readiness delay and measure again; quantify how many requests are lost.
6. Do the same with the database down: the service must report not-ready, not restart, and recover automatically.
7. Document the shutdown sequence and its timings.
:::

::: solution
```csharp
public sealed class ReadinessState
{
    private volatile bool _ready = true;
    public bool IsReady => _ready;
    public void MarkNotReady() => _ready = false;
}

builder.Services.AddSingleton<ReadinessState>();
builder.Services.AddHealthChecks()
    .AddCheck<ReadinessCheck>("readiness-gate", tags: ["ready"]);

app.Lifetime.ApplicationStopping.Register(() =>
{
    var state = app.Services.GetRequiredService<ReadinessState>();
    state.MarkNotReady();

    // Give the load balancer time to notice. This Thread.Sleep is correct:
    // ApplicationStopping is synchronous, and we WANT to block shutdown here.
    Thread.Sleep(TimeSpan.FromSeconds(15));
});
```

`volatile` on the flag matters (Phase 13): without it, the health-check thread can read a cached `true` indefinitely.

The blocking sleep is one of the very few places blocking is correct — the entire purpose is to delay shutdown, and `ApplicationStopping` callbacks are synchronous by design.

Typical measurements for 100 rps through a 30-second deployment:

```text
With readiness delay:      0 failed / 3,000 requests
Without readiness delay:  47 failed / 3,000 requests   (~1.6%)
```

Forty-seven 502s. Not enough to trigger most alerts, and enough to be noticed by users — and it happens on **every** deployment. If you deploy ten times a day, that is 470 failed requests daily from a configuration detail.

For requirement 6, with the database stopped:
```text
/health/live   → 200  (the process is fine)
/health/ready  → 503  (cannot serve)
/health        → 503 with details naming the database
```
Kubernetes removes the pod from the service and does **not** restart it. When the database returns, readiness passes and traffic resumes with warm caches and no restart storm. That is the entire payoff of separating liveness from readiness, and it is the difference between a five-minute database blip and a thirty-minute outage.
:::

::: project Health checks for TaskFlow
1. Three endpoints with correct tags.
2. Custom checks for migrations and outbox depth.
3. `Degraded` for non-critical dependencies.
4. The detailed endpoint authenticated.
5. Graceful shutdown with a readiness delay.
6. Zero dropped requests during a deployment — measured.
7. `RUNBOOK.md` entries for "database down" and "outbox backing up".

Commit.
:::

::: interview What is the difference between a liveness and a readiness probe?
Liveness answers "is this process stuck and should it be restarted". Readiness answers "can this instance serve a request right now".

The distinction matters because a liveness probe that checks the database turns a database outage into a crash loop — every instance reports unhealthy, gets restarted, comes back, still cannot reach the database, and is killed again. You lose warm caches and add a restart storm to an existing incident.

So liveness checks only the process itself, readiness checks the dependencies needed to serve, and a non-critical dependency like email returns `Degraded` rather than `Unhealthy` so the service keeps serving while someone is alerted.

The related detail is graceful shutdown: on stop, report not-ready first, wait for the load balancer's check interval — ten or fifteen seconds — and only then finish in-flight requests and exit. Without that wait you drop a percentage of requests on every single deployment.
:::

::: checkpoint
- [ ] Liveness passes with the database down
- [ ] Readiness fails and recovers with no restart
- [ ] Non-critical dependencies report `Degraded`
- [ ] The detailed endpoint requires authentication
- [ ] I measured dropped requests with and without the readiness delay
:::

## Common mistakes

::: mistake
**A liveness probe that checks external dependencies.** A dependency outage becomes a crash loop.

**One `/health` endpoint used for everything.** You cannot express the three different questions.

**A public detailed health endpoint.** It maps your dependencies for anyone who asks.

**No startup probe.** Slow-starting applications are killed before they finish starting.

**Exiting immediately on shutdown.** Dropped requests on every deployment.
:::
