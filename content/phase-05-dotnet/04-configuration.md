---
title: Configuration and environments
summary: appsettings, environment variables, user secrets, the options pattern, and never committing a password.
minutes: 40
stage: Stage 2
---

## What are we learning?

.NET's configuration system: layered providers, strongly-typed options, and how secrets are handled in development versus production.

## Configuration is layered

Providers are added in order, and **later ones override earlier ones**:

```text
1. appsettings.json
2. appsettings.{Environment}.json
3. User Secrets              (Development only)
4. Environment variables
5. Command-line arguments    (highest priority)
```

So `ConnectionStrings:Default` in `appsettings.json` is overridden by the same key in `appsettings.Production.json`, which is overridden by an environment variable, which is overridden by a command-line argument. That ordering is the whole design: commit safe defaults, override per environment, never commit a secret.

## Setting it up

For a console app (a web app does this for you):

```csharp
var builder = Host.CreateApplicationBuilder(args);
// configuration, logging, DI and environment support are all wired up already

var connectionString = builder.Configuration.GetConnectionString("Default");
var pageSize = builder.Configuration.GetValue<int>("TaskFlow:DefaultPageSize", 20);
```

`Host.CreateApplicationBuilder` gives you the standard provider chain with no ceremony. Building it by hand is only worth it when you need something unusual.

## `appsettings.json`

```json
{
  "ConnectionStrings": {
    "Default": "Host=localhost;Database=taskflow;Username=taskflow"
  },
  "TaskFlow": {
    "DefaultPageSize": 20,
    "MaxPageSize": 100,
    "Features": {
      "EnableNotifications": true,
      "EnableAuditLog": false
    },
    "ReservedLabels": [ "archived", "deleted" ]
  },
  "Logging": {
    "LogLevel": { "Default": "Information", "Microsoft.AspNetCore": "Warning" }
  }
}
```

Nested keys are addressed with a colon: `TaskFlow:Features:EnableNotifications`.

In an **environment variable**, use a double underscore instead, because colons are not portable:

```bash
export TaskFlow__Features__EnableNotifications=false
export ConnectionStrings__Default="Host=db;Database=taskflow;Password=..."
```

## Environments

```bash
export DOTNET_ENVIRONMENT=Development          # console apps
export ASPNETCORE_ENVIRONMENT=Development      # web apps
```

```csharp
if (builder.Environment.IsDevelopment()) { }
if (builder.Environment.IsProduction()) { }
if (builder.Environment.IsEnvironment("Staging")) { }
```

Conventional names are `Development`, `Staging`, `Production`. You can invent others.

## The options pattern

Reading `Configuration["Some:Key"]` all over your code is the configuration equivalent of magic strings. Bind to a class instead.

```csharp
public sealed class TaskFlowOptions
{
    public const string SectionName = "TaskFlow";

    [Range(1, 100)]
    public int DefaultPageSize { get; init; } = 20;

    [Range(1, 1000)]
    public int MaxPageSize { get; init; } = 100;

    public FeatureOptions Features { get; init; } = new();
    public IReadOnlyList<string> ReservedLabels { get; init; } = [];
}

public sealed class FeatureOptions
{
    public bool EnableNotifications { get; init; }
    public bool EnableAuditLog { get; init; }
}
```

Register it:

```csharp
builder.Services
    .AddOptions<TaskFlowOptions>()
    .Bind(builder.Configuration.GetSection(TaskFlowOptions.SectionName))
    .ValidateDataAnnotations()
    .ValidateOnStart();          // fail at startup, not on the first request
```

Consume it:

```csharp
public sealed class TaskService(IOptions<TaskFlowOptions> options)
{
    private readonly TaskFlowOptions _options = options.Value;
}
```

::: design IOptions, IOptionsSnapshot or IOptionsMonitor?
| Interface | Lifetime | Reloads on file change | Use for |
|---|---|---|---|
| `IOptions<T>` | Singleton | No | Settings fixed at startup — the usual case |
| `IOptionsSnapshot<T>` | Scoped | Per request | Settings that may change while running, read per request |
| `IOptionsMonitor<T>` | Singleton | Yes, with a change callback | Singletons that must see updates |

Default to `IOptions<T>`. Reach for `IOptionsMonitor<T>` when a singleton needs live updates (a feature flag read by a background service). `IOptionsSnapshot<T>` cannot be injected into a singleton and will throw if you try.

`ValidateOnStart()` is the important one and it is off by default. Without it, a typo in your configuration surfaces on the first request that touches that option — possibly at 3am, possibly in a code path nobody exercises until Friday. With it, the application refuses to start and tells you which key is wrong.
:::

## Secrets

::: warn Never commit a secret. Ever.
Not in `appsettings.json`, not in `appsettings.Development.json`, not "temporarily". Git history is forever, and secret-scanning bots watch public repositories within seconds of a push.

**In development** — user secrets, stored outside the repository:
```bash
cd src/TaskFlow.Api
dotnet user-secrets init
dotnet user-secrets set "ConnectionStrings:Default" "Host=localhost;Password=devpassword"
dotnet user-secrets list
```
They live in `~/.microsoft/usersecrets/<id>/secrets.json` and are loaded automatically in the Development environment only.

**In production** — environment variables, or a secret manager: Azure Key Vault, AWS Secrets Manager, HashiCorp Vault, or Docker/Kubernetes secrets. All of them plug in as configuration providers.

**If you do commit one:** rotate it. Removing the commit is not enough — assume it is compromised the moment it is pushed.
:::

::: exercise Level 1 — Guided · Layer the configuration
In TaskFlow:

1. Add `appsettings.json` to `TaskFlow.Console` with a `TaskFlow` section. Set `CopyToOutputDirectory`:
   ```xml
   <None Update="appsettings*.json" CopyToOutputDirectory="PreserveNewest" />
   ```
2. Add `appsettings.Development.json` overriding `DefaultPageSize` to 5.
3. Switch to `Host.CreateApplicationBuilder(args)` in `Program.cs`.
4. Print the effective `DefaultPageSize`. Run with and without `DOTNET_ENVIRONMENT=Development` and confirm it changes.
5. Override it again with an environment variable: `TaskFlow__DefaultPageSize=50`. Confirm the environment variable wins.
6. Override it once more on the command line: `dotnet run -- --TaskFlow:DefaultPageSize=99`. Confirm that wins.
7. Set a value with user secrets and confirm it is picked up in Development and ignored in Production.

Write the precedence order down from memory afterwards.
:::

::: challenge Level 3 · Options with real validation
Requirements:

1. `TaskFlowOptions` with `DefaultPageSize`, `MaxPageSize`, `Features`, `ReservedLabels`, `Storage` (an enum: `InMemory`, `File`, `Postgres`) and `ConnectionString`.
2. Validation that data annotations cannot express: `DefaultPageSize` must be ≤ `MaxPageSize`, and `ConnectionString` is required **only** when `Storage` is `Postgres`.
3. `ValidateOnStart` — a bad configuration must prevent startup with a message naming the exact problem.
4. A feature flag that can change at runtime, read via `IOptionsMonitor`, with a callback that logs when it changes. Prove it by editing `appsettings.json` while the app runs.
5. A `config` CLI command that prints the effective configuration with any secret-looking values redacted.
:::

::: solution
```csharp
public sealed class TaskFlowOptionsValidator : IValidateOptions<TaskFlowOptions>
{
    public ValidateOptionsResult Validate(string? name, TaskFlowOptions options)
    {
        var failures = new List<string>();

        if (options.DefaultPageSize > options.MaxPageSize)
            failures.Add($"TaskFlow:DefaultPageSize ({options.DefaultPageSize}) must not exceed " +
                         $"TaskFlow:MaxPageSize ({options.MaxPageSize}).");

        if (options.Storage is StorageKind.Postgres && string.IsNullOrWhiteSpace(options.ConnectionString))
            failures.Add("TaskFlow:ConnectionString is required when TaskFlow:Storage is Postgres. " +
                         "Set it with: dotnet user-secrets set \"TaskFlow:ConnectionString\" \"...\"");

        return failures.Count == 0
            ? ValidateOptionsResult.Success
            : ValidateOptionsResult.Fail(failures);
    }
}
```

```csharp
builder.Services.AddOptions<TaskFlowOptions>()
    .Bind(builder.Configuration.GetSection(TaskFlowOptions.SectionName))
    .ValidateDataAnnotations()
    .ValidateOnStart();

builder.Services.AddSingleton<IValidateOptions<TaskFlowOptions>, TaskFlowOptionsValidator>();
```

For live reload:

```csharp
public sealed class FeatureWatcher(IOptionsMonitor<TaskFlowOptions> monitor, ILogger<FeatureWatcher> logger)
{
    private IDisposable? _subscription;

    public void Start() => _subscription = monitor.OnChange((opts, _) =>
        logger.LogInformation("Configuration reloaded: notifications={Enabled}",
            opts.Features.EnableNotifications));

    public void Stop() => _subscription?.Dispose();
}
```

`OnChange` returns an `IDisposable` — **dispose it**, or you have registered a callback that keeps the watcher alive forever. Exactly the event-leak shape from Phase 2, in different clothing.

Redaction for the `config` command:

```csharp
static string Redact(string key, string? value) =>
    key.Contains("password", StringComparison.OrdinalIgnoreCase) ||
    key.Contains("secret", StringComparison.OrdinalIgnoreCase) ||
    key.Contains("key", StringComparison.OrdinalIgnoreCase) ||
    key.Contains("connectionstring", StringComparison.OrdinalIgnoreCase)
        ? "***"
        : value ?? "(null)";

foreach (var kv in configuration.AsEnumerable().OrderBy(k => k.Key))
    Console.WriteLine($"{kv.Key,-50} {Redact(kv.Key, kv.Value)}");
```

That command is genuinely useful in production diagnosis — "which value is this environment actually using" is a question you will ask often, and guessing is worse than printing.
:::

::: project Configure TaskFlow properly
1. `TaskFlowOptions` bound, validated and validated-on-start.
2. `appsettings.json`, `appsettings.Development.json`, both committed; no secrets in either.
3. User secrets configured for anything sensitive.
4. `TaskRules` constants from Phase 1 become configurable options — and note in `DECISIONS.md` which ones should *not* be configurable and why. (Not everything belongs in configuration. A domain invariant that must always hold is not a setting.)
5. A `config` command with redaction.
6. `.gitignore` covers `appsettings.Local.json`.

Commit.
:::

::: interview How does configuration work in .NET?
It is a layered key-value system. Providers are registered in order — `appsettings.json`, then `appsettings.{Environment}.json`, then user secrets in Development, then environment variables, then command-line arguments — and later providers override earlier ones for the same key. Nested keys use `:` in code and `__` in environment variables.

Rather than reading string keys throughout the code, you bind a section to a strongly-typed class and inject `IOptions<T>`. `ValidateDataAnnotations()` plus `ValidateOnStart()` means a misconfiguration fails at startup with a clear message instead of at the first request that touches it.

For secrets: user secrets in development, environment variables or a secret manager in production. Nothing sensitive goes in a committed file.
:::

::: checkpoint
- [ ] I can state the provider precedence order from memory
- [ ] I proved each layer overriding the one below it
- [ ] I use `IOptions<T>` rather than reading string keys
- [ ] `ValidateOnStart` is on and I have seen it refuse to start
- [ ] No secret exists anywhere in my git history
:::

## Common mistakes

::: mistake
**Secrets in `appsettings.json`.** The most common security failure in .NET repositories.

**Using `:` in an environment variable name.** Use `__`. On Linux, `:` is not even legal in a variable name.

**Forgetting `CopyToOutputDirectory` on `appsettings.json`.** It works in the IDE and the published app cannot find its configuration.

**Injecting `IOptionsSnapshot<T>` into a singleton.** Throws at resolution — a scoped service cannot live inside a singleton.

**No `ValidateOnStart`.** A typo in a key surfaces as a default value silently taking effect.
:::
