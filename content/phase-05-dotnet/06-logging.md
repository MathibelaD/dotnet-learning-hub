---
title: Logging
summary: ILogger, structured logging and log levels — writing logs someone can actually query.
minutes: 35
stage: Stage 2
---

## What are we learning?

.NET's logging abstraction, why structured logging is different from string formatting, and what to log at which level.

## `ILogger<T>`

```csharp
public sealed class TaskService(ITaskStore store, ILogger<TaskService> logger)
{
    public async Task<TaskItem> CompleteAsync(Guid id, CancellationToken ct)
    {
        logger.LogInformation("Completing task {TaskId}", id);

        var task = await store.GetAsync(id, ct)
            ?? throw new TaskNotFoundException(id);

        task.Complete();
        logger.LogInformation("Completed task {TaskId} titled {Title}", id, task.Title);
        return task;
    }
}
```

`ILogger<T>` is registered automatically by the host — you just inject it. The `T` becomes the log **category**, which is how you filter by namespace.

## Structured logging

This is the part that matters, and the part people get wrong.

```csharp
logger.LogInformation("Completing task " + id);           // ❌ string concatenation
logger.LogInformation($"Completing task {id}");           // ❌ interpolation
logger.LogInformation("Completing task {TaskId}", id);    // ✅ structured
```

The first two produce a formatted string and nothing else. The third produces a string **and** a key-value pair `TaskId = <guid>`, which a log system stores as a searchable field.

The practical difference:

```text
❌  "Completing task 3f2a-..."   → you can only grep for substrings
✅  { message: "Completing task {TaskId}",
      TaskId: "3f2a-...",
      SourceContext: "TaskFlow.TaskService" }
    → SELECT * FROM logs WHERE TaskId = '3f2a-...'
```

Rules:
- Placeholders are **named**, not positional: `{TaskId}`, not `{0}`.
- The order of arguments must match the order of placeholders.
- Use PascalCase for names. It is a convention every .NET log tool assumes.
- Prefix with `@` to serialise an object's structure rather than calling `ToString()`: `logger.LogInformation("Created {@Task}", task)`.

::: warn Never interpolate into a log message
An interpolated string is evaluated **before** the call, so:
- The formatting cost is paid even when the level is disabled.
- The structured fields are lost.
- Analyser `CA2254` flags it. Turn it on.

There is one nuance: `LogInformation($"...")` looks like it must allocate, but .NET 6+ uses an interpolated-string handler that checks `IsEnabled` first for some overloads. Do not rely on it — the structured data is still lost, which is the bigger loss.
:::

## Levels

| Level | Meaning | Example |
|---|---|---|
| `Trace` | Extremely detailed; may contain sensitive data | Every SQL parameter |
| `Debug` | Diagnostic detail for developers | "Cache miss for key X" |
| `Information` | Normal, significant events | "Task completed", "Application started" |
| `Warning` | Something unexpected but handled | "Retry 2 of 3", "Deprecated endpoint used" |
| `Error` | An operation failed | "Could not save task" |
| `Critical` | The application cannot continue | "Database unreachable at startup" |

Practical guidance:
- **Production default: `Information`.** `Debug` in production is expensive and noisy.
- **An expected business outcome is not an error.** "User entered an invalid email" is `Information` at most. Reserve `Error` for things a human should look at.
- **`Warning` should be actionable.** If nobody will ever act on it, it is `Information`.

## Configuring levels

```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore": "Warning",
      "Microsoft.EntityFrameworkCore.Database.Command": "Information",
      "TaskFlow": "Debug"
    }
  }
}
```

Categories match by prefix, longest match wins. That EF Core line is worth remembering — it is how you see the SQL your queries generate (Phase 7).

## Scopes

```csharp
using (logger.BeginScope("Processing import {ImportId}", importId))
{
    foreach (var line in lines)
    {
        using var itemScope = logger.BeginScope(new Dictionary<string, object>
        {
            ["LineNumber"] = lineNumber
        });

        logger.LogInformation("Imported {Title}", task.Title);
        // every log inside carries ImportId and LineNumber automatically
    }
}
```

Scopes attach context to every log written inside them, without threading it through every call. In a web API you get a request id in scope automatically, which is what lets you pull every log line for one request.

## Exceptions

```csharp
try { await store.SaveAsync(task, ct); }
catch (Exception ex)
{
    logger.LogError(ex, "Failed to save task {TaskId}", task.Id);   // exception FIRST
    throw;
}
```

The exception goes in the **first parameter**, not in the message. That is what preserves the stack trace, the exception type and the inner exceptions as structured data.

```csharp
logger.LogError("Failed: " + ex.Message);    // ❌ you have thrown away everything useful
```

## High-performance logging

For hot paths, the source-generated approach avoids boxing and allocation entirely:

```csharp
public static partial class Log
{
    [LoggerMessage(Level = LogLevel.Information,
        Message = "Completing task {taskId} in project {projectId}")]
    public static partial void CompletingTask(ILogger logger, Guid taskId, Guid projectId);
}

Log.CompletingTask(logger, task.Id, task.ProjectId);
```

The source generator writes an implementation that checks `IsEnabled` first and does no allocation when the level is off. Use it where logging is frequent; `logger.LogInformation(...)` is fine elsewhere.

::: exercise Level 1 — Guided · Log properly
In TaskFlow:

1. Inject `ILogger<T>` into your store decorator and your service.
2. Convert every `Console.WriteLine` used for diagnostics into a structured log call. Leave genuine user-facing CLI output as `Console.WriteLine` — that distinction matters.
3. Set the console log format to see structured fields:
   ```csharp
   builder.Logging.AddSimpleConsole(o => { o.SingleLine = true; o.TimestampFormat = "HH:mm:ss "; });
   ```
4. Add `"TaskFlow": "Debug"` to configuration and confirm the extra output appears; change it to `"Warning"` and confirm it disappears — with no code change.
5. Wrap your import in a `BeginScope` and confirm the import id appears on every line inside.
6. Turn on `dotnet_diagnostic.CA2254.severity = error` and fix everything it finds.
:::

::: challenge Level 3 · JSON logs and a correlation id
Requirements:

1. Console output is JSON in Production, human-readable in Development.
2. Every log line carries a correlation id that is stable for one CLI invocation.
3. A `--verbose` flag raises the minimum level to `Debug` at runtime, overriding configuration.
4. No secret, password, connection string or token can ever reach a log — enforced by something, not by discipline.
5. Requests to the store log their duration, and anything over 100ms logs at `Warning`.

Point 4 is the interesting one. Think about where to put the enforcement so that a future developer cannot bypass it by accident.
:::

::: solution
For point 1:
```csharp
if (builder.Environment.IsProduction())
    builder.Logging.AddJsonConsole(o => o.IncludeScopes = true);
else
    builder.Logging.AddSimpleConsole(o => { o.SingleLine = true; o.IncludeScopes = true; });
```

For points 2 and 5, a decorator — the same shape you have used since Phase 1:

```csharp
public sealed class TimingTaskStore(ITaskStore inner, ILogger<TimingTaskStore> logger) : ITaskStore
{
    public async Task<TaskItem?> GetAsync(Guid id, CancellationToken ct = default)
    {
        var sw = Stopwatch.GetTimestamp();
        try
        {
            return await inner.GetAsync(id, ct);
        }
        finally
        {
            var ms = Stopwatch.GetElapsedTime(sw).TotalMilliseconds;
            if (ms > 100)
                logger.LogWarning("Slow store operation {Operation} took {Ms:F1}ms", nameof(GetAsync), ms);
            else
                logger.LogDebug("{Operation} took {Ms:F1}ms", nameof(GetAsync), ms);
        }
    }
}
```

`Stopwatch.GetTimestamp()` / `GetElapsedTime()` avoids allocating a `Stopwatch` object — worth it in a decorator that wraps every call.

**Point 4 — enforcing redaction rather than trusting it.** Discipline fails. Put the enforcement in the pipeline:

```csharp
public sealed class RedactingLoggerProvider(ILoggerProvider inner) : ILoggerProvider
{
    public ILogger CreateLogger(string categoryName) => new RedactingLogger(inner.CreateLogger(categoryName));
    public void Dispose() => inner.Dispose();
}

sealed class RedactingLogger(ILogger inner) : ILogger
{
    private static readonly Regex Secrets = new(
        @"(?i)\b(password|pwd|secret|token|api[-_]?key|authorization)\s*[=:]\s*\S+",
        RegexOptions.Compiled);

    public void Log<TState>(LogLevel level, EventId id, TState state, Exception? ex,
        Func<TState, Exception?, string> formatter) =>
        inner.Log(level, id, state, ex, (s, e) => Secrets.Replace(formatter(s, e), "$1=***"));

    public bool IsEnabled(LogLevel level) => inner.IsEnabled(level);
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => inner.BeginScope(state);
}
```

This is a last line of defence, not a first. The real defences are: never put a secret in a domain object that gets logged with `{@Object}`, mark sensitive properties (Phase 2's `[Sensitive]` attribute), and review what you log. But a regex at the boundary catches the case where someone logs a whole connection string in a hurry, and that case happens.

.NET 8 also added `Microsoft.Extensions.Compliance.Redaction`, a first-class API for exactly this. Worth knowing it exists.
:::

::: project Logging throughout TaskFlow
1. Structured logging everywhere, with `CA2254` at error level.
2. A `TimingTaskStore` decorator, composed with `LoggingTaskStore`.
3. Correlation id scope for every CLI invocation.
4. JSON console in Production, readable in Development.
5. `--verbose` raising the level at runtime.
6. Log levels configured per category in `appsettings.json`.

Then answer in `DECISIONS.md`: what is the difference between a log, a metric and a trace, and which of your current log lines should actually be metrics? (Phase 14 answers this properly — write your guess now and compare later.)

Commit. **Phase 5 is done.** TaskFlow is a proper .NET solution: multiple projects, central packages, layered configuration, DI and structured logging. It is ready to become a web API.
:::

::: interview How does logging work in .NET?
You inject `ILogger<T>`, where `T` sets the log category used for filtering. The abstraction sits in `Microsoft.Extensions.Logging` and providers — console, file, Serilog, Application Insights — plug in behind it, so application code never depends on a specific logging library.

The important practice is **structured logging**: `logger.LogInformation("Completing task {TaskId}", id)` rather than string interpolation. The message template and the values are kept separate, so the log system stores `TaskId` as a queryable field instead of a substring. Interpolating loses that, and pays the formatting cost even when the level is disabled.

Beyond that: exceptions go in the first parameter so the stack trace is preserved as structured data; scopes attach context such as a request or correlation id to everything logged inside them; and levels are configured per category with longest-prefix matching, so you can raise EF Core to `Information` to see SQL without turning on `Debug` for everything.
:::

::: checkpoint Phase 5 complete
- [ ] Every log call uses named placeholders, never interpolation
- [ ] `CA2254` is an error and the build is clean
- [ ] Exceptions are passed as the first argument
- [ ] I can change log verbosity per category with no code change
- [ ] TaskFlow is a multi-project solution with DI, configuration and logging
- [ ] I can build, configure, run and publish it entirely from the terminal
:::

## Common mistakes

::: mistake
**`LogInformation($"...")`.** Loses all structured data. The single most common logging mistake in .NET.

**Logging `ex.Message` instead of `ex`.** No stack trace, no inner exceptions, no type.

**Everything at `Information`, or everything at `Error`.** Levels exist so that production can be quiet and diagnosis can be loud. Use them.

**Logging inside a tight loop at `Information`.** Gigabytes of logs, and your logging bill exceeds your compute bill.

**Logging secrets.** `LogDebug("Connecting with {ConnectionString}", cs)` puts a password in your log aggregator, which is usually less protected than your database.
:::
