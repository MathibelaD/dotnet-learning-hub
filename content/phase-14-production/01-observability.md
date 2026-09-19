---
title: Structured logging and observability
summary: Logs, metrics and traces — the three signals, and what each one is actually for.
minutes: 45
---

## What are we learning?

Making a running system explainable: Serilog for logs, OpenTelemetry for metrics and traces, and the judgement about which signal answers which question.

## The three signals

```text
LOGS     discrete events with context     "what happened, in detail, for this request"
METRICS  aggregated numbers over time     "how is the system behaving, in general"
TRACES   a request's path across services "where did the time go, and what called what"
```

They answer different questions, and using the wrong one is expensive:

| Question | Signal |
|---|---|
| Why did request `abc123` fail? | **Log** |
| Are we failing more than usual? | **Metric** |
| Which service made this slow? | **Trace** |
| What was the exact input? | **Log** |
| What is our p99 latency? | **Metric** |
| How many tasks were created today? | **Metric** (or a database query) |

::: warn Do not use logs as metrics
Counting log lines to produce a rate is expensive and imprecise: you pay to store and index every event to compute a number you could have incremented directly.

"Log a line per task creation, then count them in the log platform" costs perhaps £0.50 per million events. `Counter<long>.Add(1)` costs nanoseconds and produces an exact number.

**Log what you would want to read; measure what you would want to graph.**
:::

## Serilog

The built-in `ILogger` is the abstraction; you need a provider that writes structured output somewhere useful.

```bash
dotnet add package Serilog.AspNetCore
dotnet add package Serilog.Sinks.Console
dotnet add package Serilog.Sinks.Seq
```

```csharp
builder.Host.UseSerilog((context, services, configuration) => configuration
    .ReadFrom.Configuration(context.Configuration)
    .ReadFrom.Services(services)
    .Enrich.FromLogContext()
    .Enrich.WithProperty("Application", "TaskFlow.Api")
    .Enrich.WithProperty("Version", ThisAssembly.Version)
    .Enrich.WithEnvironmentName()
    .Enrich.WithMachineName());
```

```json
{
  "Serilog": {
    "MinimumLevel": {
      "Default": "Information",
      "Override": {
        "Microsoft.AspNetCore": "Warning",
        "Microsoft.EntityFrameworkCore.Database.Command": "Warning",
        "System.Net.Http.HttpClient": "Warning"
      }
    },
    "WriteTo": [
      { "Name": "Console", "Args": { "formatter": "Serilog.Formatting.Compact.CompactJsonFormatter, Serilog.Formatting.Compact" } },
      { "Name": "Seq", "Args": { "serverUrl": "http://seq:5341" } }
    ]
  }
}
```

### Request logging

```csharp
app.UseSerilogRequestLogging(options =>
{
    options.MessageTemplate = "{RequestMethod} {RequestPath} responded {StatusCode} in {Elapsed:0.0000} ms";

    options.GetLevel = (httpContext, elapsed, ex) =>
        ex is not null ? LogEventLevel.Error
        : httpContext.Response.StatusCode >= 500 ? LogEventLevel.Error
        : httpContext.Response.StatusCode >= 400 ? LogEventLevel.Warning
        : elapsed > 1000 ? LogEventLevel.Warning
        : httpContext.Request.Path.StartsWithSegments("/health") ? LogEventLevel.Verbose
        : LogEventLevel.Information;

    options.EnrichDiagnosticContext = (diagnosticContext, httpContext) =>
    {
        diagnosticContext.Set("UserId", httpContext.User.GetUserId());
        diagnosticContext.Set("CorrelationId", httpContext.TraceIdentifier);
        diagnosticContext.Set("UserAgent", httpContext.Request.Headers.UserAgent.ToString());
    };
});
```

One tidy line per request instead of the framework's default three, with the level chosen by outcome, and health checks demoted so they do not drown everything else.

## Metrics with `System.Diagnostics.Metrics`

```csharp
public sealed class TaskFlowMetrics
{
    public const string MeterName = "TaskFlow";

    private readonly Counter<long> _tasksCreated;
    private readonly Counter<long> _tasksCompleted;
    private readonly Histogram<double> _taskLifetimeDays;
    private readonly UpDownCounter<long> _openTasks;

    public TaskFlowMetrics(IMeterFactory factory)
    {
        var meter = factory.Create(MeterName);

        _tasksCreated = meter.CreateCounter<long>("taskflow.tasks.created",
            unit: "{task}", description: "Number of tasks created.");
        _taskLifetimeDays = meter.CreateHistogram<double>("taskflow.task.lifetime",
            unit: "d", description: "Days from creation to completion.");
        _openTasks = meter.CreateUpDownCounter<long>("taskflow.tasks.open");
    }

    public void TaskCreated(Priority priority) =>
        _tasksCreated.Add(1, new KeyValuePair<string, object?>("priority", priority.ToString()));

    public void TaskCompleted(TaskItem task, double lifetimeDays)
    {
        _tasksCompleted.Add(1);
        _taskLifetimeDays.Record(lifetimeDays);
        _openTasks.Add(-1);
    }
}
```

| Instrument | For |
|---|---|
| `Counter<T>` | Something that only increases — requests, errors, tasks created |
| `UpDownCounter<T>` | Something that goes both ways — open connections, queue depth |
| `Histogram<T>` | A distribution you want percentiles of — latency, payload size |
| `ObservableGauge<T>` | A current value sampled on demand — memory, cache size |

::: warn Tag cardinality will bankrupt you
```csharp
_tasksCreated.Add(1, new KeyValuePair<string, object?>("task_id", task.Id));   // ❌
```
Every distinct tag value creates a separate time series. A `Guid` tag means one series per task — millions of series, each stored forever. Metric backends charge by series, and this is the single most common way to produce an unexpected five-figure bill.

**Tags must be low cardinality**: status, priority, HTTP method, route template, environment. Never an id, a user id, an email or a raw URL with parameters.

If you need per-entity detail, that is a **log** or a **trace**, both of which are designed for high-cardinality data.
:::

## Traces

```csharp
builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r.AddService("TaskFlow.Api", serviceVersion: ThisAssembly.Version))
    .WithMetrics(metrics => metrics
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddRuntimeInstrumentation()
        .AddMeter(TaskFlowMetrics.MeterName)
        .AddPrometheusExporter())
    .WithTracing(tracing => tracing
        .AddAspNetCoreInstrumentation(o => o.Filter = ctx => !ctx.Request.Path.StartsWithSegments("/health"))
        .AddHttpClientInstrumentation()
        .AddEntityFrameworkCoreInstrumentation(o => o.SetDbStatementForText = true)
        .AddSource(TaskFlowActivitySource.Name)
        .AddOtlpExporter());

app.MapPrometheusScrapingEndpoint();
```

Custom spans where the automatic instrumentation cannot see:

```csharp
public static class TaskFlowActivitySource
{
    public const string Name = "TaskFlow";
    public static readonly ActivitySource Source = new(Name);
}

using var activity = TaskFlowActivitySource.Source.StartActivity("ImportTasks");
activity?.SetTag("import.rows", rowCount);
activity?.SetTag("import.format", format);
// ...
activity?.SetStatus(ActivityStatusCode.Ok);
```

::: note The trace id ties all three signals together
`Activity.Current?.Id` is the W3C trace id. It is:
- in every log line, via `Enrich.FromLogContext` and the `TraceId` property
- in the `traceId` of your `ProblemDetails` error responses (Phase 6)
- the identifier of the trace in your tracing backend
- propagated automatically to downstream services through the `traceparent` header

So a user quoting a trace id from an error response lets you pull the full request trace **and** every log line for it, in seconds. That single correlation is the highest-value thing in this lesson, and it costs about four lines of configuration.
:::

::: exercise Level 1 — Guided · Wire up all three signals
1. Serilog with compact JSON to the console and a Seq sink. Run Seq locally:
   ```bash
   docker run -d --name seq -e ACCEPT_EULA=Y -p 5341:80 datalust/seq
   ```
2. `UseSerilogRequestLogging` with level selection and enrichment.
3. `TaskFlowMetrics` with counters, a histogram and an up-down counter.
4. OpenTelemetry with ASP.NET Core, HttpClient, EF Core and runtime instrumentation.
5. The Prometheus scraping endpoint; check `/metrics`.
6. A custom `Activity` around your import.
7. Make a request that fails, take the `traceId` from the response, and find both the trace and every log line for it.

Step 7 is the whole point. Do it until it is fast.
:::

::: challenge Level 3 · An incident you can actually diagnose
Requirements:

1. Seed enough traffic that the signals are realistic.
2. Introduce a fault: a slow database query on one endpoint under specific conditions.
3. Detect it from **metrics** alone: which endpoint, how much slower, since when.
4. Locate it from **traces**: which span consumed the time.
5. Confirm it from **logs**: the exact query and parameters.
6. Write a runbook entry: symptom → dashboard → trace → log → fix.
7. Add an alert that would have caught it, with a threshold you can justify.

Requirement 7 is harder than it sounds. A threshold you cannot justify becomes an alert people ignore.
:::

::: solution
The alert threshold is the interesting part, and the usual answers are wrong.

**"Alert if p99 > 500ms"** — an arbitrary number. It fires during every traffic spike and gets muted within a fortnight.

**"Alert if p99 doubles week over week"** — better, but noisy on a system with weekly seasonality.

**The defensible approach is to alert on an error budget.** Define an SLO: "99% of `GET /api/tasks` requests complete in under 300ms over a rolling 28 days." That gives an error budget of 1% of requests. Then alert on **burn rate**: how fast you are consuming the budget.

```text
Fast burn:  14.4x budget rate over 1 hour   → page someone now
Slow burn:  6x budget rate over 6 hours     → a ticket, look at it today
```

Those multipliers are the standard ones from Google's SRE practice, and they have a real derivation: 14.4× for one hour consumes 2% of a 28-day budget, which is worth waking someone for. 6× over six hours consumes 5%, which is worth a ticket.

The value of this framing is that the threshold is **derived from a commitment you made to users**, not chosen because it looked reasonable. When someone asks "why 300ms?", the answer is "that is the SLO we agreed", and when someone asks "why page at 14.4×?", the answer is "because at that rate we exhaust a month's budget in two days".

The runbook entry:
```text
SYMPTOM   p99 latency on GET /api/tasks above 300ms; burn-rate alert firing
DASHBOARD grafana.example/d/taskflow → "Endpoint latency" panel
TRACE     Find a slow trace: filter by duration > 1s, service = TaskFlow.Api
          Look for the longest span. If it is "EF Core: SELECT tasks", go to logs.
LOGS      Seq: TraceId = <id>, look for Microsoft.EntityFrameworkCore.Database.Command
          The statement and its parameters are in the event.
CHECK     Run EXPLAIN ANALYZE on that statement. Look for Seq Scan and
          "Rows Removed by Filter".
FIX       Usually a missing index, or a filter that stopped being selective
          as the table grew. Add the index in a migration with the EXPLAIN
          output in the commit message.
```

A runbook that names the specific dashboard, the specific filter and the specific thing to look for is worth ten pages of prose about observability philosophy.
:::

::: project Observability for TaskFlow
1. Serilog with JSON output and Seq in development.
2. Request logging with outcome-based levels and health checks demoted.
3. `TaskFlowMetrics` with at least six instruments, all low-cardinality.
4. OpenTelemetry traces and metrics, with a Prometheus endpoint.
5. Custom activities around import, export and search.
6. `traceId` in error responses, matching logs and traces.
7. A `RUNBOOK.md` with at least three entries.
8. A test asserting no metric uses a high-cardinality tag.

Commit.
:::

::: interview What is observability and how do you implement it in .NET?
It is the ability to explain what a running system is doing from its outputs, and it has three signals. Logs are discrete events with full context — they answer "why did this specific request fail". Metrics are aggregated numbers — they answer "is this getting worse". Traces show a request's path and where the time went across services.

In .NET the logging abstraction is `ILogger` with a provider like Serilog writing structured JSON; metrics use `System.Diagnostics.Metrics` with counters, histograms and up-down counters; and traces use `ActivitySource`. OpenTelemetry collects all of it and exports to whatever backend you use, with automatic instrumentation for ASP.NET Core, HttpClient and EF Core.

The detail that makes it usable is correlation: `Activity.Current.Id` is the W3C trace id, and putting it in log lines and in error responses means a user quoting an error id gets you the whole trace and every log line for that request.

The mistake I would call out is using logs as metrics — counting log lines to get a rate is orders of magnitude more expensive than a counter — and high-cardinality metric tags, where putting an id in a tag creates one time series per entity and produces an enormous bill.
:::

::: checkpoint
- [ ] I can state which signal answers which question
- [ ] A trace id from an error response finds both the trace and the logs
- [ ] No metric tag has high cardinality
- [ ] Health check requests do not flood my logs
- [ ] I have a runbook with specific dashboards and filters
- [ ] My alert threshold is derived from an SLO, not chosen arbitrarily
:::

## Common mistakes

::: mistake
**Logs as metrics.** Orders of magnitude more expensive for a number you could increment.

**High-cardinality metric tags.** An id per series, and a bill that grows without bound.

**Logging every health check at `Information`.** Your real logs are buried.

**No correlation id.** Every investigation starts from nothing.

**Alert thresholds chosen by feel.** They fire spuriously and get muted.
:::
