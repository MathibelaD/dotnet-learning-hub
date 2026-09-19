---
title: Dependency injection and the generic host
summary: The container, the three lifetimes, and the mistakes that cause the weirdest bugs in .NET.
minutes: 45
stage: Stage 2
---

## What are we learning?

.NET's built-in DI container: how to register services, what the three lifetimes mean, and the captive-dependency bug that catches everyone once.

## The problem DI solves

```csharp
public class TaskService
{
    private readonly InMemoryTaskStore _store = new();        // hard-coded
    private readonly EmailNotifier _notifier = new("smtp…");  // hard-coded, needs config
}
```

This class cannot be tested without a real SMTP server, cannot switch to a database store, and knows how to construct things that are not its business.

```csharp
public class TaskService(ITaskStore store, INotifier notifier)
{
    // it asks for what it needs; someone else decides what to give it
}
```

That inversion is the whole idea. The container is just the "someone else".

## Registration

```csharp
var builder = Host.CreateApplicationBuilder(args);

builder.Services.AddSingleton<ITaskStore, InMemoryTaskStore>();
builder.Services.AddScoped<ITaskService, TaskService>();
builder.Services.AddTransient<IEmailSender, SmtpEmailSender>();

// factory — when construction needs logic
builder.Services.AddSingleton<ITaskStore>(sp =>
{
    var options = sp.GetRequiredService<IOptions<TaskFlowOptions>>().Value;
    return options.Storage switch
    {
        StorageKind.InMemory => new InMemoryTaskStore(),
        StorageKind.File => new FileTaskStore(options.Path),
        _ => throw new InvalidOperationException($"Unknown storage {options.Storage}")
    };
});

// an already-built instance
builder.Services.AddSingleton(TimeProvider.System);

// several implementations of one interface — injected as IEnumerable<T>
builder.Services.AddSingleton<ITaskObserver, AuditObserver>();
builder.Services.AddSingleton<ITaskObserver, MetricsObserver>();

// only if nothing has registered it yet — for library defaults
builder.Services.TryAddSingleton<IClock, SystemClock>();

// decorate: register the inner, then wrap it
builder.Services.AddSingleton<InMemoryTaskStore>();
builder.Services.AddSingleton<ITaskStore>(sp =>
    new LoggingTaskStore(
        sp.GetRequiredService<InMemoryTaskStore>(),
        sp.GetRequiredService<ILogger<LoggingTaskStore>>()));

var host = builder.Build();
```

That last one is your Phase 1 decorator, now assembled by the container.

## The three lifetimes

| Lifetime | One instance per | Use for |
|---|---|---|
| **Singleton** | Application | Stateless services, caches, configuration, `HttpClient` factories |
| **Scoped** | Request (web) / explicit scope | `DbContext`, anything per-request such as the current user |
| **Transient** | Every injection | Cheap, stateless, short-lived objects |

```csharp
// creating a scope by hand — in a console app or a background service
using var scope = host.Services.CreateScope();
var service = scope.ServiceProvider.GetRequiredService<ITaskService>();
```

::: warn The captive dependency
```csharp
services.AddSingleton<TaskService>();     // lives forever
services.AddScoped<TaskFlowDbContext>();  // meant to live one request
```

`TaskService` is constructed **once**, and it captures the `DbContext` it received at that moment. That context then lives for the lifetime of the application:
- it accumulates tracked entities until memory runs out
- it is used concurrently by every request, and `DbContext` is not thread-safe
- its connection eventually dies and every request fails with a stale connection error

The rule: **a service may only depend on something with an equal or longer lifetime.**

```text
Singleton  →  Singleton               ✅
Scoped     →  Singleton, Scoped       ✅
Transient  →  anything                ✅
Singleton  →  Scoped                  ❌ captive dependency
Singleton  →  Transient               ⚠️  the transient becomes a singleton in practice
```

.NET catches the obvious case for you in Development:
```csharp
builder.Host.UseDefaultServiceProvider(o =>
{
    o.ValidateScopes = true;      // throws on captive dependencies
    o.ValidateOnBuild = true;     // throws at startup for anything unresolvable
});
```
Both default to **on in Development only**. Turn them on everywhere — the startup cost is milliseconds and it converts a class of production mystery into a startup failure.
:::

### When a singleton genuinely needs a scoped service

Inject the factory, not the service:

```csharp
public sealed class TaskCleanupService(IServiceScopeFactory scopeFactory)
{
    public async Task RunAsync(CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<TaskFlowDbContext>();
        // ... use it, then the scope disposes it
    }
}
```

This is exactly what a background service does, and Phase 14 uses it verbatim.

## Resolution

```csharp
sp.GetRequiredService<ITaskStore>();      // throws with a clear message if unregistered
sp.GetService<ITaskStore>();              // returns null if unregistered
sp.GetServices<ITaskObserver>();          // all registrations of that type
```

Prefer `GetRequiredService`. `GetService` returns null and you get a `NullReferenceException` later, far from the missing registration.

::: warn Do not inject IServiceProvider
```csharp
public class TaskService(IServiceProvider services)     // ❌ service locator
{
    public void Do() => services.GetRequiredService<ITaskStore>().Add(...);
}
```
The constructor no longer tells you what the class depends on. You cannot see it in a test, you cannot see it in code review, and a missing registration fails at call time rather than at startup.

Legitimate exceptions: `IServiceScopeFactory` in a singleton that manages scopes; a genuine factory type; framework infrastructure. Everywhere else, list your dependencies in the constructor.
:::

## Registration extension methods

As registrations grow, group them:

```csharp
// in TaskFlow.Application
public static class ApplicationServiceCollectionExtensions
{
    public static IServiceCollection AddTaskFlowApplication(
        this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<TaskFlowOptions>()
            .Bind(configuration.GetSection(TaskFlowOptions.SectionName))
            .ValidateDataAnnotations()
            .ValidateOnStart();

        services.AddScoped<ITaskService, TaskService>();
        services.AddSingleton<ITaskStore, InMemoryTaskStore>();
        services.AddSingleton(TimeProvider.System);

        return services;                     // return it, so calls chain
    }
}

// in Program.cs
builder.Services.AddTaskFlowApplication(builder.Configuration);
```

Every library in the .NET ecosystem follows this convention. Follow it too: each layer owns its registrations, and `Program.cs` stays readable.

::: exercise Level 1 — Guided · Feel the lifetimes
1. Create `IGuidProvider` with `Guid Value { get; }` implemented by a class that generates a Guid in its constructor.
2. Register it three times under three interfaces — `ISingletonGuid`, `IScopedGuid`, `ITransientGuid` — with the matching lifetimes.
3. Write a consumer that takes all three and prints them.
4. Resolve the consumer twice **inside one scope**, and twice across **two scopes**. Print every value.
5. Predict the pattern first, then check: which values repeat, and where?
6. Now register a singleton that depends on a scoped service and turn on `ValidateScopes`. Read the exception carefully — it names both services.
:::

::: solution
Within one scope, resolved twice:
```text
singleton  A A
scoped     B B
transient  C D     ← new every time
```
Across two scopes:
```text
singleton  A A     ← same for the whole application
scoped     B E     ← new per scope
transient  C D
```

The captive dependency error reads:

```text
System.InvalidOperationException: Cannot consume scoped service
'IScopedGuid' from singleton 'MyConsumer'.
```

That message names both ends of the problem. When you see it, the fix is one of: make the consumer scoped, make the dependency singleton, or inject `IServiceScopeFactory` and create a scope.
:::

::: challenge Level 3 · A pluggable notification system
Requirements:

1. `INotificationChannel` with `Name` and `SendAsync`.
2. Three implementations: console, file, and a null channel.
3. Which channels are enabled comes from configuration: `"TaskFlow:Notifications:Channels": ["console", "file"]`.
4. A `NotificationDispatcher` that injects **all** registered channels and sends to only the enabled ones.
5. One channel throwing does not stop the others; failures are logged and aggregated.
6. Adding a fourth channel requires **no change** to the dispatcher or to `Program.cs` — only a new class and a configuration entry.
7. Channels are resolved lazily, so a channel that is never used is never constructed.

Requirement 6 is the real test. If you have to edit two files to add a channel, the design is not finished.
:::

::: solution
```csharp
public static IServiceCollection AddNotifications(this IServiceCollection services, IConfiguration config)
{
    services.Configure<NotificationOptions>(config.GetSection("TaskFlow:Notifications"));

    // discover every channel in the assembly — no manual list to keep in sync
    foreach (var type in typeof(INotificationChannel).Assembly.GetTypes()
                 .Where(t => t is { IsAbstract: false, IsInterface: false }
                             && typeof(INotificationChannel).IsAssignableFrom(t)))
    {
        services.AddSingleton(typeof(INotificationChannel), type);
    }

    services.AddSingleton<NotificationDispatcher>();
    return services;
}

public sealed class NotificationDispatcher(
    IEnumerable<INotificationChannel> channels,
    IOptionsMonitor<NotificationOptions> options,
    ILogger<NotificationDispatcher> logger)
{
    public async Task DispatchAsync(Notification n, CancellationToken ct = default)
    {
        var enabled = options.CurrentValue.Channels.ToHashSet(StringComparer.OrdinalIgnoreCase);
        var failures = new List<Exception>();

        foreach (var channel in channels.Where(c => enabled.Contains(c.Name)))
        {
            try
            {
                await channel.SendAsync(n, ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogError(ex, "Channel {Channel} failed", channel.Name);
                failures.Add(ex);
            }
        }

        if (failures.Count == channels.Count() && failures.Count > 0)
            throw new AggregateException("All notification channels failed.", failures);
    }
}
```

Three design points worth arguing about, because an interviewer will:

**Assembly scanning versus explicit registration.** Scanning satisfies requirement 6 but makes registrations invisible — you cannot find them by searching, and a stray class can be registered accidentally. Explicit registration is clearer but means editing `Program.cs` for each channel. For a plugin system, scanning is right. For twelve services, it is over-engineering. Say which one you chose and why.

**Lazy construction.** `IEnumerable<INotificationChannel>` is resolved eagerly when the dispatcher is constructed — every channel is built whether or not it is enabled. To make it genuinely lazy, inject `IEnumerable<Lazy<INotificationChannel>>` or resolve through a factory keyed by name. .NET 8 added **keyed services** (`AddKeyedSingleton`, `[FromKeyedServices("console")]`) which is the cleanest option now.

**Failing when all channels fail.** Throwing only when *every* channel failed is a judgement call: a notification that reached one of three destinations mostly worked. Document it, because the opposite choice is equally defensible.
:::

::: project Wire TaskFlow through the container
1. Add `Microsoft.Extensions.Hosting` to `TaskFlow.Console`.
2. `Program.cs` becomes `Host.CreateApplicationBuilder(args)`, with `ValidateScopes` and `ValidateOnBuild` on in **all** environments.
3. Add `AddTaskFlowApplication(...)` to `TaskFlow.Application` registering the store, the service, options and `TimeProvider.System`.
4. Replace every `new` of a service with constructor injection. After this step, `Program.cs` should contain no `new` except for the host builder.
5. Register `LoggingTaskStore` as a decorator around `InMemoryTaskStore`.
6. Replace `DateTime.UtcNow` throughout the domain with an injected `TimeProvider`:
   ```csharp
   public sealed class TaskItem(string title, TimeProvider clock) { ... clock.GetUtcNow() ... }
   ```
   This is the fix promised back in Phase 1. Note in `DECISIONS.md` how it changes testability — in Phase 10 you use `FakeTimeProvider` to write a test that asserts on "three days later" without waiting three days.
7. Prove the container is right: deliberately create a captive dependency, watch it fail at startup, then fix it.

Commit.
:::

::: interview What is dependency injection?
A class declares what it needs through its constructor rather than constructing its collaborators itself, and a container supplies them. That inverts the dependency: the class depends on an abstraction, and composition happens in one place at startup.

Concretely it buys testability — you pass a fake in a test — and substitutability, since swapping an implementation is a registration change rather than an edit to every consumer.

.NET has a container built in with three lifetimes: singleton (one per application), scoped (one per request or explicit scope), and transient (one per injection). The trap worth mentioning is the **captive dependency**: injecting a scoped service such as a `DbContext` into a singleton makes it live for the application's lifetime, which leaks memory and breaks thread safety. `ValidateScopes` catches it at startup.
:::

::: checkpoint
- [ ] I predicted the singleton/scoped/transient output before running it
- [ ] I triggered a captive-dependency error and read the message
- [ ] `ValidateScopes` and `ValidateOnBuild` are on in every environment
- [ ] I registered a decorator through the container
- [ ] `DateTime.UtcNow` no longer appears in TaskFlow's domain
:::

## Common mistakes

::: mistake
**Injecting a scoped service into a singleton.** The captive dependency. Turn on `ValidateScopes`.

**Injecting `IServiceProvider`.** A service locator in disguise; hides dependencies from the constructor.

**Registering `DbContext` as a singleton "for performance".** It is not thread-safe and it never releases tracked entities.

**`GetService` instead of `GetRequiredService`.** A null far from the missing registration.

**All registrations in `Program.cs`.** Two hundred lines that nobody reads. One extension method per layer.
:::
