---
title: Filters and cross-cutting concerns
summary: MVC's interception points — and knowing when a filter is right and when middleware is.
minutes: 30
stage: Stage 3
---

## What are we learning?

Action filters, exception filters and endpoint filters: hooks that run around your endpoint with knowledge of the action, the model and the result — which middleware does not have.

## The filter pipeline

```text
Middleware
  └─ Routing selects the endpoint
      └─ Authorization filters
          └─ Resource filters       (before model binding — caching lives here)
              └─ MODEL BINDING
                  └─ Action filters      ← sees the bound arguments
                      └─ YOUR ACTION
                  └─ Action filters (after) ← sees the result
              └─ Result filters
          └─ Exception filters       (only for exceptions from actions)
```

The difference from middleware in one sentence: **middleware sees an HTTP request; a filter sees which action is about to run, with which bound arguments, and what it returned.**

## Action filters

```csharp
public sealed class ValidationFilter<T>(IValidator<T> validator) : IAsyncActionFilter
{
    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        var model = context.ActionArguments.Values.OfType<T>().FirstOrDefault();

        if (model is not null)
        {
            var result = await validator.ValidateAsync(model, context.HttpContext.RequestAborted);
            if (!result.IsValid)
            {
                context.Result = new BadRequestObjectResult(
                    new ValidationProblemDetails(result.ToDictionary()));
                return;                          // short-circuit — the action never runs
            }
        }

        var executed = await next();             // run the action
        // 'executed.Result' is available here
    }
}
```

Registering:

```csharp
// globally
builder.Services.AddControllers(o => o.Filters.Add<AuditFilter>());

// per controller or action
[ServiceFilter(typeof(ValidationFilter<CreateTaskRequest>))]   // DI-resolved
[TypeFilter(typeof(AuditFilter), Arguments = ["tasks"])]       // DI + constructor args
[MyAttributeFilter]                                            // no dependencies
```

`[ServiceFilter]` and `[TypeFilter]` exist because plain attributes cannot take constructor-injected services — attribute arguments must be compile-time constants (Phase 2). Those two resolve the filter through the container instead.

## Exception filters

```csharp
public sealed class DomainExceptionFilter(ILogger<DomainExceptionFilter> logger) : IExceptionFilter
{
    public void OnException(ExceptionContext context)
    {
        var (status, title) = context.Exception switch
        {
            TaskNotFoundException      => (404, "Task not found"),
            TaskStateException         => (409, "Invalid state transition"),
            TaskValidationException    => (422, "Validation failed"),
            UnauthorizedAccessException=> (403, "Forbidden"),
            _ => (0, "")
        };

        if (status == 0) return;                 // not ours — let it propagate

        logger.LogInformation(context.Exception, "Domain exception -> {Status}", status);
        context.Result = new ObjectResult(new ProblemDetails
        {
            Status = status,
            Title = title,
            Detail = context.Exception.Message
        }) { StatusCode = status };

        context.ExceptionHandled = true;
    }
}
```

::: design Filter or middleware?
| Need | Use |
|---|---|
| Runs for every request including static files and 404s | **Middleware** |
| Needs the bound model or the action's metadata | **Filter** |
| Must run before routing | **Middleware** |
| Should short-circuit with an `IActionResult` | **Filter** |
| Applies to some controllers or actions only | **Filter** (attributes) |
| Response compression, HTTPS redirect, CORS | **Middleware** |
| Validation, auditing, per-action caching | **Filter** |

A practical note on exception handling: a *filter* only catches exceptions from actions and other filters. Exceptions from middleware, model binding or routing bypass it entirely. So use `UseExceptionHandler` middleware as the safety net (next lesson) and use an exception filter only where you specifically want action-level behaviour. In practice, most applications should use the middleware and skip the filter.
:::

## Endpoint filters (minimal APIs)

```csharp
public sealed class LoggingEndpointFilter(ILogger<LoggingEndpointFilter> logger) : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext ctx, EndpointFilterDelegate next)
    {
        logger.LogDebug("Calling {Endpoint}", ctx.HttpContext.GetEndpoint()?.DisplayName);
        var result = await next(ctx);
        return result;
    }
}

app.MapPost("/api/tasks", Handler)
   .AddEndpointFilter<ValidationFilter<CreateTaskRequest>>();

// or on a whole group
var group = app.MapGroup("/api/tasks").AddEndpointFilter<LoggingEndpointFilter>();
```

Simpler than MVC filters — one method, one delegate — and the equivalent tool for minimal APIs.

## Filter order

Filters run in order of `Order` (ascending), then by scope: **global → controller → action** on the way in, and the reverse on the way out.

```csharp
public sealed class AuditAttribute : ActionFilterAttribute
{
    public AuditAttribute() => Order = 10;      // higher runs later (inbound)
}
```

::: exercise Level 1 — Guided · Three useful filters
1. `ValidationFilter<T>` running FluentValidation, applied to your create and update actions.
2. `AuditFilter` logging who called which action with which arguments — and confirm that it sees the *bound model*, which middleware could not.
3. `ResponseTimeFilter` adding an `X-Response-Time-Ms` header.
4. Apply one globally, one per controller and one per action. Add logging to each and confirm the in/out ordering.
5. Make `ValidationFilter` short-circuit and confirm the action never runs (put a log line in the action).
6. Now write the same audit logic as middleware and observe what you cannot get — the action name and the bound arguments.
:::

::: challenge Level 3 · An idempotency filter
Duplicate `POST` requests are a real problem: a client times out, retries, and you create two tasks.

Implement an `[Idempotent]` filter:

1. The client sends an `Idempotency-Key` header on `POST`.
2. The first request with a given key executes normally, and the response is cached against that key.
3. Any repeat with the same key returns the **cached response** without executing the action.
4. Keys expire after 24 hours.
5. A repeat with the same key but a **different request body** returns 422 — that is a client bug, not a retry.
6. Concurrent requests with the same key: exactly one executes; the other waits and returns the same response.
7. `POST` without the header still works (the filter is opt-in per endpoint).

Point 6 is the one that separates a toy implementation from a correct one.
:::

::: solution
```csharp
public sealed class IdempotencyFilter(IDistributedCache cache, ILogger<IdempotencyFilter> logger)
    : IAsyncActionFilter
{
    public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
    {
        var request = context.HttpContext.Request;
        if (!request.Headers.TryGetValue("Idempotency-Key", out var keyHeader) ||
            string.IsNullOrWhiteSpace(keyHeader))
        {
            await next();
            return;
        }

        var key = $"idem:{keyHeader}";
        var bodyHash = await HashBodyAsync(request);

        if (await cache.GetStringAsync(key) is { } cached)
        {
            var entry = JsonSerializer.Deserialize<IdempotencyEntry>(cached)!;

            if (entry.BodyHash != bodyHash)
            {
                context.Result = new ObjectResult(new ProblemDetails
                {
                    Status = 422,
                    Title = "Idempotency key reuse",
                    Detail = "This Idempotency-Key was already used with a different request body."
                }) { StatusCode = 422 };
                return;
            }

            if (entry.Status is null)         // in flight
            {
                context.Result = new ObjectResult(new ProblemDetails
                {
                    Status = 409, Title = "Request in progress",
                    Detail = "A request with this Idempotency-Key is still being processed."
                }) { StatusCode = 409 };
                return;
            }

            context.Result = new ContentResult
            {
                StatusCode = entry.Status, Content = entry.Body, ContentType = "application/json"
            };
            return;
        }

        // Claim the key BEFORE executing. Not perfectly atomic with IDistributedCache —
        // Redis SETNX or a unique database constraint is the correct primitive.
        await cache.SetStringAsync(key,
            JsonSerializer.Serialize(new IdempotencyEntry(bodyHash, null, null)),
            new DistributedCacheEntryOptions { AbsoluteExpirationRelativeToNow = TimeSpan.FromHours(24) });

        var executed = await next();

        if (executed.Result is ObjectResult { StatusCode: >= 200 and < 300 } ok)
        {
            await cache.SetStringAsync(key, JsonSerializer.Serialize(
                new IdempotencyEntry(bodyHash, ok.StatusCode, JsonSerializer.Serialize(ok.Value))),
                new DistributedCacheEntryOptions { AbsoluteExpirationRelativeToNow = TimeSpan.FromHours(24) });
        }
        else
        {
            await cache.RemoveAsync(key);     // let the client legitimately retry a failure
        }
    }
}
```

Three things worth understanding rather than copying:

**The in-flight marker.** Storing an entry with a null status *before* calling the action is what makes requirement 6 work at all. Without it, two concurrent requests both see a cache miss and both execute.

**It is still not fully atomic.** `IDistributedCache` has no compare-and-set. A correct implementation uses Redis `SET key value NX` (set if not exists, atomically) or a unique constraint on an `idempotency_keys` table, where the second insert fails and tells you to wait. Knowing that your implementation has this gap — and being able to say so — is more valuable than pretending it does not.

**Failures clear the key.** If the action returned a 500, the client should be allowed to retry. Caching a failure would permanently poison that key.

This is a real production pattern. Stripe's API works exactly this way, and if you can explain it you will stand out.
:::

::: project Filters in TaskFlow
1. `ValidationFilter<T>` wired for every request DTO.
2. `AuditFilter` logging action, arguments (redacted) and duration.
3. `X-Response-Time-Ms` on every response.
4. `[Idempotent]` on `POST /api/tasks` — an in-memory cache is fine for now; note in `DECISIONS.md` what changes when you run more than one instance.
5. Order the global filters explicitly and document why.

Commit.
:::

::: interview What is the difference between middleware and a filter?
Middleware runs for every request in the pipeline and knows only about `HttpContext` — it sits before routing and endpoint selection, so it applies to static files and unmatched requests too. Filters run inside MVC, after an endpoint has been selected, so they have access to the action, its bound arguments and its result, and they can be applied selectively with attributes on a controller or action.

So: response compression, HTTPS redirection, CORS and correlation ids are middleware. Validation, auditing, idempotency and per-action caching are filters.

One trap worth mentioning: an exception *filter* only catches exceptions thrown by actions and other filters — anything from middleware, routing or model binding bypasses it. So the global safety net should be `UseExceptionHandler` middleware.
:::

::: checkpoint
- [ ] I can state three things a filter can do that middleware cannot
- [ ] I applied filters globally, per controller and per action, and observed the ordering
- [ ] I made a filter short-circuit and confirmed the action never ran
- [ ] I know why `[ServiceFilter]` exists
- [ ] TaskFlow has validation, audit and idempotency filters
:::

## Common mistakes

::: mistake
**Putting a plain attribute filter's dependencies in its constructor.** Attribute arguments must be constants. Use `[ServiceFilter]` or `[TypeFilter]`.

**Relying on an exception filter as the global safety net.** It misses everything outside MVC.

**Forgetting to `return` after setting `context.Result`.** The action runs anyway and overwrites your result.

**Doing expensive work in a global filter.** It runs on every action, including health checks.

**Idempotency without an in-flight marker.** Concurrent retries both execute.
:::
