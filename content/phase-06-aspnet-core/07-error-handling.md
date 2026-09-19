---
title: Error handling and ProblemDetails
summary: One place that turns any exception into a correct, safe, useful HTTP response.
minutes: 35
stage: Stage 3
---

## What are we learning?

Global exception handling, the `ProblemDetails` standard, and the security rule about what an error response must never contain.

## The goal

Every unhandled exception, from anywhere, becomes:
- the **right status code**
- a **consistent body shape** clients can parse
- a **useful message** for the caller
- **no internal detail** leaked to the outside world
- a **full diagnostic record** in your logs

## `ProblemDetails` (RFC 9457)

```json
{
  "type": "https://taskflow.example/errors/task-not-found",
  "title": "Task not found",
  "status": 404,
  "detail": "No task exists with id 3f2a8c91-...",
  "instance": "/api/tasks/3f2a8c91-...",
  "traceId": "00-4bf92f35-00f067aa-01"
}
```

Five standard fields plus any extensions you add. The value of using the standard rather than inventing `{"error": "..."}` is that client libraries, API gateways and tooling already understand it.

## Setup

```csharp
builder.Services.AddProblemDetails(options =>
{
    options.CustomizeProblemDetails = ctx =>
    {
        ctx.ProblemDetails.Instance = $"{ctx.HttpContext.Request.Method} {ctx.HttpContext.Request.Path}";
        ctx.ProblemDetails.Extensions["traceId"] =
            Activity.Current?.Id ?? ctx.HttpContext.TraceIdentifier;
    };
});

app.UseExceptionHandler();      // first in the pipeline
app.UseStatusCodePages();       // gives 404s and 405s a ProblemDetails body too
```

## An `IExceptionHandler`

.NET 8 added a clean hook. Register several; each decides whether it handles the exception.

```csharp
public sealed class DomainExceptionHandler(ILogger<DomainExceptionHandler> logger) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext context, Exception exception, CancellationToken ct)
    {
        var problem = exception switch
        {
            TaskNotFoundException e => new ProblemDetails
            {
                Status = StatusCodes.Status404NotFound,
                Title = "Task not found",
                Detail = e.Message,
                Type = "https://taskflow.example/errors/task-not-found"
            },
            TaskStateException e => new ProblemDetails
            {
                Status = StatusCodes.Status409Conflict,
                Title = "Invalid state transition",
                Detail = e.Message
            },
            TaskValidationException e => new ProblemDetails
            {
                Status = StatusCodes.Status422UnprocessableEntity,
                Title = "The request could not be processed",
                Detail = e.Message
            },
            _ => null
        };

        if (problem is null) return false;      // not ours — the next handler gets it

        logger.LogInformation(exception, "Domain error {Status} on {Path}",
            problem.Status, context.Request.Path);

        context.Response.StatusCode = problem.Status!.Value;
        await context.Response.WriteAsJsonAsync(problem, ct);
        return true;
    }
}
```

The catch-all, registered **last**:

```csharp
public sealed class UnhandledExceptionHandler(
    ILogger<UnhandledExceptionHandler> logger, IHostEnvironment env) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext context, Exception exception, CancellationToken ct)
    {
        if (exception is OperationCanceledException && context.RequestAborted.IsCancellationRequested)
        {
            logger.LogInformation("Request cancelled by client: {Path}", context.Request.Path);
            context.Response.StatusCode = 499;          // client closed request
            return true;
        }

        logger.LogError(exception, "Unhandled exception on {Method} {Path}",
            context.Request.Method, context.Request.Path);

        context.Response.StatusCode = StatusCodes.Status500InternalServerError;
        await context.Response.WriteAsJsonAsync(new ProblemDetails
        {
            Status = 500,
            Title = "An unexpected error occurred",
            Detail = env.IsDevelopment() ? exception.ToString() : "Please contact support with the trace id.",
            Extensions = { ["traceId"] = Activity.Current?.Id ?? context.TraceIdentifier }
        }, ct);

        return true;
    }
}
```

```csharp
builder.Services.AddExceptionHandler<DomainExceptionHandler>();
builder.Services.AddExceptionHandler<UnhandledExceptionHandler>();   // order matters
```

::: warn Never return an exception message to an unauthenticated caller in production
Stack traces and exception messages leak: file paths and usernames, table and column names, connection string fragments, library versions with known CVEs, and internal service hostnames.

```json
{ "detail": "Npgsql.PostgresException: 42P01: relation \"tasks_v2\" does not exist\n   at /home/deploy/src/..." }
```

That is a gift to anyone probing your API. The rule:
- **Development:** full detail, because you are the only caller.
- **Production:** a generic message plus a trace id. The detail goes to your logs, where the trace id finds it.

The `OperationCanceledException` branch is worth copying too: it distinguishes "the client hung up" from "we broke", which otherwise fills your error dashboards with noise (Phase 4).
:::

## Mapping the whole exception vocabulary

| Exception | Status | Why |
|---|---|---|
| `TaskNotFoundException` | 404 | The resource does not exist |
| `TaskStateException` | 409 | Conflicts with current state |
| `TaskValidationException` | 422 | Understood, but unprocessable |
| `ValidationException` (FluentValidation) | 400 | Malformed input |
| `UnauthorizedAccessException` | 403 | Authenticated but not permitted |
| `OperationCanceledException` (client) | 499 | Client disconnected |
| `TimeoutException` | 504 | An upstream dependency timed out |
| `DbUpdateConcurrencyException` | 409 | Optimistic concurrency conflict (Phase 7) |
| Anything else | 500 | Unexpected — log it and investigate |

::: exercise Level 1 — Guided · One handler for everything
1. Add `AddProblemDetails` and `UseExceptionHandler`.
2. Write `DomainExceptionHandler` covering your Phase 1 exception hierarchy.
3. Write `UnhandledExceptionHandler` with environment-dependent detail.
4. Register both, in the right order.
5. Remove **every** try/catch from your controllers. They should be free of error handling entirely.
6. Test each case with curl: a missing id, an already-completed task, an invalid body, and a deliberately thrown `NotImplementedException`.
7. Run in Production mode and confirm no stack trace appears in any response, and that the full detail is in the log.
:::

::: challenge Level 3 · Error responses a client can program against
Requirements:

1. A stable, documented `type` URI per error class — a client can branch on it without parsing prose.
2. Machine-readable extensions: `TaskNotFound` includes `taskId`; validation errors include per-field `errors`.
3. Correct `Content-Type: application/problem+json`.
4. Correlation via `traceId`, and the same id appears in the logs.
5. A `/errors/{code}` endpoint serving human documentation for each `type`.
6. Localised `title` based on `Accept-Language`, falling back to English.
7. Nothing internal leaks in Production — verified by a test that asserts on the response body for a deliberately thrown exception.

Point 7 should be an actual test, not a manual check. It is the kind of thing that regresses silently.
:::

::: solution
```csharp
public static class ErrorTypes
{
    private const string Base = "https://taskflow.example/errors/";
    public const string TaskNotFound      = Base + "task-not-found";
    public const string InvalidTransition = Base + "invalid-transition";
    public const string ValidationFailed  = Base + "validation-failed";
    public const string Conflict          = Base + "conflict";
}

// TaskNotFoundException handling, with machine-readable data
new ProblemDetails
{
    Type = ErrorTypes.TaskNotFound,
    Title = localizer["TaskNotFound"],
    Status = 404,
    Detail = $"No task exists with id {e.TaskId}.",
    Extensions =
    {
        ["taskId"] = e.TaskId,
        ["documentation"] = "/errors/task-not-found"
    }
}
```

`Content-Type` is set for you by `WriteAsJsonAsync` when the object is a `ProblemDetails` — but only if you do not override it. Verify with `curl -i`.

The test for point 7:

```csharp
[Fact]
public async Task Production_errors_leak_nothing_internal()
{
    var factory = new WebApplicationFactory<Program>()
        .WithWebHostBuilder(b => b.UseEnvironment("Production"));
    var client = factory.CreateClient();

    var response = await client.GetAsync("/api/test/throw");   // a test-only endpoint that throws
    var body = await response.Content.ReadAsStringAsync();

    Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
    Assert.DoesNotContain("Exception", body);
    Assert.DoesNotContain("at TaskFlow.", body);       // no stack frames
    Assert.DoesNotContain("/home/", body);             // no file paths
    Assert.DoesNotContain("Npgsql", body);             // no library names
    Assert.Contains("traceId", body);                  // but the correlation id IS there
}
```

That is a Phase 10 technique used a phase early, deliberately: **security properties should be asserted, not reviewed.** A code review catches a leak once; a test catches it every time someone changes the handler.

Guard the test-only throwing endpoint behind a compilation symbol or an environment check so it cannot exist in a real production build.
:::

::: project Global error handling for TaskFlow
1. `AddProblemDetails` + `UseExceptionHandler` + `UseStatusCodePages`.
2. `DomainExceptionHandler` and `UnhandledExceptionHandler`.
3. Stable `type` URIs in an `ErrorTypes` class.
4. `traceId` on every error, matching the logs.
5. Zero try/catch blocks in controllers — verify with a grep.
6. The no-leak test.
7. `API.md` documenting every error `type` your API can produce.

Commit.
:::

::: interview How do you handle errors in an ASP.NET Core API?
With a single global handler rather than try/catch in every controller. `UseExceptionHandler` middleware sits first in the pipeline, and `IExceptionHandler` implementations map exception types to status codes: domain "not found" to 404, invalid state transitions to 409, validation failures to 400 or 422, and anything unrecognised to 500.

The response body follows RFC 9457 `ProblemDetails`, so it has a consistent shape with `type`, `title`, `status`, `detail` and extensions, plus a trace id that correlates to the logs.

The rule that matters for security: in production the response carries a generic message and the trace id, never the exception message or stack trace, because those leak table names, file paths and library versions. The full detail goes to the logs, and the trace id is how support finds it.
:::

::: checkpoint
- [ ] There is no try/catch in any controller
- [ ] Every exception type maps to a deliberate status code
- [ ] Production responses contain no stack trace — and a test proves it
- [ ] Every error response carries a trace id that I can find in the logs
- [ ] Client cancellation is logged as information, not as an error
:::

## Common mistakes

::: mistake
**Returning `ex.Message` in production.** Information disclosure, and it is the single most common .NET API security finding.

**try/catch in every controller.** Duplicated, inconsistent, and it hides the exceptions you did not anticipate.

**Everything is 500.** Clients cannot distinguish "you sent something wrong" from "we are broken", so they retry things that will never succeed.

**Exception handler not first in the pipeline.** Exceptions from other middleware escape.

**Logging cancellations as errors.** Your error rate becomes meaningless.
:::
