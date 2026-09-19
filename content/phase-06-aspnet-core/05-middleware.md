---
title: Middleware and the request pipeline
summary: The chain every request passes through, why order matters more than anything, and writing your own.
minutes: 40
stage: Stage 3
---

## What are we learning?

The ASP.NET Core request pipeline: how it is built, what each built-in component does, and the ordering rules you cannot get wrong.

## The pipeline

```text
Request
   ↓
[ExceptionHandler]  ──────────────────────────────┐
   ↓                                              │
[HSTS / HttpsRedirection]                         │
   ↓                                              │
[StaticFiles]                                     │
   ↓                                              │  response
[Routing]            ← decides which endpoint     │  travels
   ↓                                              │  back up
[CORS]                                            │
   ↓                                              │
[Authentication]     ← who are you?               │
   ↓                                              │
[Authorization]      ← are you allowed?           │
   ↓                                              │
[Endpoint]           ← your controller runs here  │
   └──────────────────────────────────────────────┘
```

Each component can: act on the request, call the next one, and then act on the response on the way back out. It is a nested chain, not a list — which is why "before" and "after" both exist in one method.

## Writing one

```csharp
// inline
app.Use(async (context, next) =>
{
    var sw = Stopwatch.GetTimestamp();
    context.Response.Headers["X-Request-Id"] = context.TraceIdentifier;

    await next(context);          // everything downstream runs here

    var ms = Stopwatch.GetElapsedTime(sw).TotalMilliseconds;
    logger.LogInformation("{Method} {Path} -> {Status} in {Ms:F1}ms",
        context.Request.Method, context.Request.Path, context.Response.StatusCode, ms);
});

// terminal — does not call next
app.Run(async context => await context.Response.WriteAsync("Not found"));

// branch — only for matching paths
app.Map("/admin", admin => admin.Use(...));

// conditional branch
app.UseWhen(ctx => ctx.Request.Path.StartsWithSegments("/api"),
    api => api.UseMiddleware<ApiKeyMiddleware>());
```

As a class, which is what you should do for anything non-trivial:

```csharp
public sealed class RequestTimingMiddleware(RequestDelegate next, ILogger<RequestTimingMiddleware> logger)
{
    public async Task InvokeAsync(HttpContext context)
    {
        var sw = Stopwatch.GetTimestamp();
        try
        {
            await next(context);
        }
        finally
        {
            var ms = Stopwatch.GetElapsedTime(sw).TotalMilliseconds;
            if (ms > 500)
                logger.LogWarning("Slow request {Method} {Path} took {Ms:F0}ms",
                    context.Request.Method, context.Request.Path, ms);
        }
    }
}

app.UseMiddleware<RequestTimingMiddleware>();
```

::: warn Middleware is constructed once, for the application's lifetime
The constructor runs at startup, so constructor-injected services are effectively **singletons**. Injecting a scoped service there is the captive dependency from Phase 5.

To use a scoped service, inject it into `InvokeAsync` instead:
```csharp
public async Task InvokeAsync(HttpContext context, ITaskService service)  // resolved per request
```
The framework supports method injection specifically for this. `ILogger<T>` is fine in the constructor because it is a singleton.
:::

## Order

::: warn Order is the whole game
The canonical order, which you should copy and not improvise:

```csharp
app.UseExceptionHandler();        // first — it must wrap everything
app.UseHsts();                    // production only
app.UseHttpsRedirection();
app.UseStaticFiles();
app.UseRouting();                 // ← endpoint selection happens here
app.UseCors();                    // after routing, before auth
app.UseAuthentication();          // who are you
app.UseAuthorization();           // ← MUST be after authentication
app.UseRateLimiter();
app.UseOutputCache();
app.MapControllers();             // the endpoints
```

What goes wrong when you get it wrong:

| Mistake | Symptom |
|---|---|
| `UseAuthorization` before `UseAuthentication` | Every request is anonymous; `[Authorize]` always fails |
| `UseCors` before `UseRouting` | CORS headers missing on endpoint responses |
| `UseExceptionHandler` not first | Exceptions from other middleware escape unhandled |
| `UseStaticFiles` after routing | Static file requests go through the whole auth pipeline |
| Anything after `MapControllers` | Never runs for matched requests |

In .NET 6+ many of these are added automatically if you omit them, which hides the problem until you add one manually and disturb the order. Write them explicitly.
:::

## Reading and rewriting the body

The request body is a forward-only stream, readable once. Middleware that needs to read it must enable buffering:

```csharp
public async Task InvokeAsync(HttpContext context)
{
    context.Request.EnableBuffering();

    using var reader = new StreamReader(context.Request.Body, leaveOpen: true);
    var body = await reader.ReadToEndAsync();
    context.Request.Body.Position = 0;          // ← rewind, or model binding gets nothing

    logger.LogDebug("Body: {Body}", body);
    await next(context);
}
```

Forgetting `Position = 0` gives you an API where every request body is empty and nothing indicates why. And note: buffering the body costs memory per request — do it selectively, never for file uploads.

## Short-circuiting

```csharp
if (!context.Request.Headers.TryGetValue("X-Api-Key", out var key) || !IsValid(key))
{
    context.Response.StatusCode = StatusCodes.Status401Unauthorized;
    await context.Response.WriteAsJsonAsync(new ProblemDetails { Title = "Invalid API key" });
    return;                        // do NOT call next
}
await next(context);
```

::: warn You cannot change the status code after the response has started
Once any byte of the body is written, headers are flushed and `Response.StatusCode` throws. `context.Response.HasStarted` tells you. This is why exception-handling middleware must be **first**: by the time an endpoint has started writing, it is too late to turn the response into a 500.
:::

::: exercise Level 1 — Guided · Build a pipeline
1. Add inline middleware that logs `method path -> status in Xms` for every request.
2. Add a class-based `CorrelationIdMiddleware`: read `X-Correlation-Id` from the request or generate one, put it in a logging scope, and echo it on the response.
3. Add `app.UseWhen` so an API-key check applies only to `/api/**`.
4. Deliberately put `UseAuthorization()` before `UseAuthentication()`, add `[Authorize]` to an endpoint, and observe the 401. Then fix the order.
5. Write middleware that reads and logs the request body; forget `Position = 0` first and watch every POST fail with an empty model; then fix it.
6. Print the pipeline order by adding `Console.WriteLine` before and after `await next()` in three middlewares. Confirm the nesting: `1→2→3→endpoint→3→2→1`.
:::

::: challenge Level 3 · A request/response logging middleware
Build one that is actually safe to run in production.

Requirements:
1. Logs method, path, query, status and duration for every request.
2. Logs the request body **only** for 4xx/5xx responses — you cannot know the status until after, so you must buffer selectively.
3. Never logs bodies over 4 KB; truncates with a marker.
4. Never logs `Authorization`, `Cookie`, or any header or JSON field that looks like a secret.
5. Never logs bodies for `multipart/form-data` or non-JSON content types.
6. Adds under 1 ms of overhead when nothing is logged.
7. Correlation id propagated into every log line via a scope.
8. Configurable on and off, and configurable per path prefix.

Requirement 6 is the design constraint that makes this interesting: you cannot buffer every response body just in case.
:::

::: solution
```csharp
public sealed class RequestLoggingMiddleware(
    RequestDelegate next,
    ILogger<RequestLoggingMiddleware> logger,
    IOptionsMonitor<RequestLoggingOptions> options)
{
    private static readonly string[] SensitiveHeaders = ["authorization", "cookie", "x-api-key"];

    public async Task InvokeAsync(HttpContext context)
    {
        var opts = options.CurrentValue;
        if (!opts.Enabled || !opts.AppliesTo(context.Request.Path))
        {
            await next(context);
            return;
        }

        var correlationId = context.Request.Headers["X-Correlation-Id"].FirstOrDefault()
                            ?? context.TraceIdentifier;
        context.Response.Headers["X-Correlation-Id"] = correlationId;

        using var scope = logger.BeginScope(new Dictionary<string, object>
        {
            ["CorrelationId"] = correlationId,
            ["RequestPath"] = context.Request.Path.Value ?? "/"
        });

        // Buffer the request body only if it could ever be needed AND is small and JSON.
        var mightLogBody = opts.LogBodiesOnError
            && context.Request.ContentLength is > 0 and <= 4096
            && context.Request.ContentType?.StartsWith("application/json", StringComparison.OrdinalIgnoreCase) == true;

        string? body = null;
        if (mightLogBody)
        {
            context.Request.EnableBuffering();
            using var reader = new StreamReader(context.Request.Body, leaveOpen: true);
            body = await reader.ReadToEndAsync(context.RequestAborted);
            context.Request.Body.Position = 0;
        }

        var start = Stopwatch.GetTimestamp();
        try
        {
            await next(context);
        }
        finally
        {
            var ms = Stopwatch.GetElapsedTime(start).TotalMilliseconds;
            var status = context.Response.StatusCode;

            if (status >= 400 && body is not null)
                logger.LogWarning("{Method} {Path} -> {Status} in {Ms:F1}ms body={Body}",
                    context.Request.Method, context.Request.Path, status, ms, Redact(body));
            else if (status >= 400)
                logger.LogWarning("{Method} {Path} -> {Status} in {Ms:F1}ms",
                    context.Request.Method, context.Request.Path, status, ms);
            else
                logger.LogInformation("{Method} {Path} -> {Status} in {Ms:F1}ms",
                    context.Request.Method, context.Request.Path, status, ms);
        }
    }
}
```

The key design decision is **buffering the request on the way in based on a cheap heuristic**, rather than buffering the *response* on the way out. Response buffering means replacing `Response.Body` with a `MemoryStream`, which allocates per request and breaks streaming responses — unacceptable for requirement 6. Request bodies are already bounded by `ContentLength`, so a size check is free.

Note also that `ILogger`'s own `IsEnabled` check means the `LogInformation` call on the success path costs almost nothing when the level is off.

For redaction, reuse the approach from Phase 5's logging lesson.

**What you should actually use in production:** ASP.NET Core has `app.UseHttpLogging()` built in, with `HttpLoggingOptions` covering most of this including header redaction. Build yours once to understand the mechanics, then use the built-in one — and be able to say why.
:::

::: project TaskFlow's pipeline
1. Explicit pipeline in `Program.cs`, in the canonical order, with a comment explaining why each component is where it is.
2. `CorrelationIdMiddleware` — accept or generate, scope it, echo it.
3. `RequestTimingMiddleware` warning on anything over 500ms.
4. Security headers middleware: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
5. `UseWhen` so `/health` skips the heavier middleware.
6. Prove the ordering with the three-middleware nesting experiment, and paste the output into `DECISIONS.md`.

Commit.
:::

::: interview What is middleware in ASP.NET Core?
A component in the request pipeline. Each one receives the `HttpContext` and a delegate to the next component, so it can inspect or modify the request, decide whether to continue, and then act on the response as the call unwinds. The pipeline is assembled in `Program.cs` with `app.Use...` calls, and the order of those calls is the order of execution.

Order is the thing that matters most: `UseAuthentication` must come before `UseAuthorization` or every request is anonymous; `UseCors` must come after `UseRouting`; exception-handling middleware must be first so it wraps everything, because once a response has started writing you can no longer change the status code.

Middleware is constructed once for the application's lifetime, so scoped services must be injected into `InvokeAsync` rather than the constructor.
:::

::: checkpoint
- [ ] I can draw the standard pipeline order from memory
- [ ] I broke the auth ordering deliberately and saw the symptom
- [ ] I know why a scoped service cannot go in a middleware constructor
- [ ] I hit the "body is empty" bug from a missing `Position = 0`
- [ ] TaskFlow's pipeline is explicit and commented
:::

## Common mistakes

::: mistake
**`UseAuthorization` before `UseAuthentication`.** Everything is 401 and nothing explains why.

**Scoped service in a middleware constructor.** Captive dependency.

**Reading the body without `EnableBuffering` and rewinding.** Model binding silently receives nothing.

**Changing the status code after writing to the response.** `InvalidOperationException: headers are read-only`.

**Middleware registered after `MapControllers`.** It never runs.
:::
