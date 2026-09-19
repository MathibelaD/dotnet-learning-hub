---
title: API versioning and production configuration
summary: Changing a published API without breaking clients, and the settings that differ in production.
minutes: 35
---

## What are we learning?

Versioning strategy, and the configuration and hardening that separates a development build from a deployable one.

## Versioning

```bash
dotnet add package Asp.Versioning.Mvc
dotnet add package Asp.Versioning.Mvc.ApiExplorer
```

```csharp
builder.Services.AddApiVersioning(options =>
{
    options.DefaultApiVersion = new ApiVersion(1, 0);
    options.AssumeDefaultVersionWhenUnspecified = true;
    options.ReportApiVersions = true;                    // api-supported-versions header
    options.ApiVersionReader = ApiVersionReader.Combine(
        new UrlSegmentApiVersionReader(),
        new HeaderApiVersionReader("X-Api-Version"));
})
.AddApiExplorer(options =>
{
    options.GroupNameFormat = "'v'VVV";
    options.SubstituteApiVersionInUrl = true;
});
```

```csharp
[ApiController]
[ApiVersion("1.0")]
[ApiVersion("2.0")]
[Route("api/v{version:apiVersion}/[controller]")]
public sealed class TasksController : ControllerBase
{
    [HttpGet, MapToApiVersion("1.0")]
    public async Task<ActionResult<IReadOnlyList<TaskResponseV1>>> ListV1(CancellationToken ct) { }

    [HttpGet, MapToApiVersion("2.0")]
    public async Task<ActionResult<PagedResponse<TaskResponseV2>>> ListV2(CancellationToken ct) { }

    [Obsolete("Removed in v2. Use POST /tasks/{id}/complete.")]
    [HttpPut("{id:guid}/status"), MapToApiVersion("1.0")]
    public async Task<IActionResult> SetStatusV1(Guid id, SetStatusRequest request, CancellationToken ct) { }
}
```

::: design Where to put the version
| Strategy | Example | Verdict |
|---|---|---|
| URL segment | `/api/v2/tasks` | **Most common.** Visible, cacheable, trivially testable in a browser |
| Header | `X-Api-Version: 2.0` | Cleaner URLs; harder to test and to cache |
| Query string | `/api/tasks?api-version=2.0` | Works; ugly; easy to forget |
| Media type | `Accept: application/json;v=2` | Most RESTful in theory; least used in practice |

**Use the URL segment.** It is what most public APIs do, it is visible in logs, and anyone can try it with a browser.

**Better than versioning: do not break the contract.**

| Change | Breaking? |
|---|---|
| Adding an optional field to a response | No |
| Adding an optional request field | No |
| Adding a new endpoint | No |
| Removing a response field | **Yes** |
| Renaming a field | **Yes** |
| Making an optional request field required | **Yes** |
| Narrowing a type (string → int) | **Yes** |
| Adding a new enum value | **Yes, in practice** — clients switch on it |
| Changing a status code | **Yes** |
| Changing default sort order | **Yes**, for anyone relying on it |

Most evolution is additive and needs no version at all. Reserve a new version for genuine contract breaks, support at most two at once, and publish a removal date when you introduce the successor.
:::

## Deprecation

```csharp
[ApiVersion("1.0", Deprecated = true)]
```

```text
api-supported-versions: 1.0, 2.0
api-deprecated-versions: 1.0
Sunset: Sat, 31 Jan 2026 23:59:59 GMT
Link: <https://docs.taskflow.example/migrate-v2>; rel="deprecation"
```

`Sunset` (RFC 8594) and a `Link` to migration guidance is the courteous way to remove something. Log every call to a deprecated endpoint with the caller's identity, so that when the date arrives you know exactly who is affected and can contact them rather than discovering it from an incident.

## Production configuration

```json
// appsettings.Production.json — committed, no secrets
{
  "Logging": { "LogLevel": { "Default": "Warning", "TaskFlow": "Information" } },
  "TaskFlow": { "MaxPageSize": 100, "EnableSwagger": false },
  "AllowedHosts": "api.taskflow.example"
}
```

Secrets come from the environment:

```bash
ConnectionStrings__Default=...
Jwt__SigningKey=...
Redis__Configuration=...
ASPNETCORE_ENVIRONMENT=Production
ASPNETCORE_URLS=http://+:8080
DOTNET_gcServer=1
```

### The production checklist

```csharp
if (app.Environment.IsProduction())
{
    app.UseHsts();
    app.UseHttpsRedirection();
}
else
{
    app.MapOpenApi();
    app.MapScalarApiReference();
}
```

```xml
<PropertyGroup>
  <InvariantGlobalization>true</InvariantGlobalization>   <!-- smaller image, no ICU -->
  <TieredPGO>true</TieredPGO>                             <!-- profile-guided optimisation -->
  <ServerGarbageCollection>true</ServerGarbageCollection>
  <ConcurrentGarbageCollection>true</ConcurrentGarbageCollection>
</PropertyGroup>
```

::: warn `InvariantGlobalization` changes behaviour, not just size
It removes ICU, so all culture-sensitive operations fall back to invariant rules. `string.Compare` with a culture, `ToUpper()` for Turkish, date parsing with a locale, and culture-aware sorting all change.

For an API that deals in UTC timestamps, ordinal string comparison and JSON, this is fine and saves around 30 MB in the container image. For anything doing localised formatting or culture-aware sorting, it is a bug.

Decide deliberately, and if you enable it, have a test that asserts on the behaviour you rely on.
:::

### `AllowedHosts`

```json
{ "AllowedHosts": "api.taskflow.example;*.taskflow.example" }
```

The default `*` accepts any `Host` header, which enables host-header injection — an attacker can cause your application to generate password-reset links pointing at their domain. Set it in production.

::: exercise Level 1 — Guided · Version and harden
1. Add API versioning with the URL segment, defaulting to 1.0.
2. Add a v2 of your list endpoint with a genuinely different response shape.
3. Mark v1 deprecated with a `Sunset` header.
4. Log every v1 call with the caller's identity.
5. Confirm OpenAPI shows both versions, grouped.
6. `appsettings.Production.json` with no secrets.
7. Run with `ASPNETCORE_ENVIRONMENT=Production` and verify: no OpenAPI UI, no stack traces, HSTS present, `AllowedHosts` enforced.
8. Enable `InvariantGlobalization` and run your tests. Record anything that changes.
:::

::: challenge Level 3 · Ship a breaking change without breaking anyone
Requirement: `TaskResponse.status` changes from a string (`"InProgress"`) to an object (`{ "code": "in_progress", "label": "In progress", "isTerminal": false }`).

Requirements:
1. Existing v1 clients see no change at all.
2. v2 clients get the new shape.
3. One domain model serves both — no duplicated business logic.
4. Both versions are in OpenAPI, with accurate schemas.
5. Integration tests for both.
6. Deprecation headers and a migration guide for v1.
7. Metrics showing v1 versus v2 usage, so you know when v1 can go.
8. A plan to remove v1, with the decision criterion written down.
:::

::: solution
The structure that satisfies requirement 3:

```text
Domain          TaskItem with a TaskStatus enum — unchanged, unaware of versions
Application     returns domain objects or version-neutral DTOs
API/V1          TaskResponseV1  + mapping
API/V2          TaskResponseV2  + mapping
```

Versioning lives **entirely in the API layer**. The moment a version number appears in the application or domain layer, you have two implementations of the same business rule and they will diverge.

```csharp
// Api/Contracts/V1/TaskResponseV1.cs
public sealed record TaskResponseV1(Guid Id, string Title, string Status, string Priority);

// Api/Contracts/V2/TaskResponseV2.cs
public sealed record TaskResponseV2(Guid Id, string Title, StatusInfo Status, string Priority);
public sealed record StatusInfo(string Code, string Label, bool IsTerminal);

// mapping — two small functions over one domain type
public static TaskResponseV1 ToV1(this TaskItem t) => new(t.Id, t.Title, t.Status.ToString(), t.Priority.ToString());
public static TaskResponseV2 ToV2(this TaskItem t) => new(t.Id, t.Title, StatusInfo.From(t.Status), t.Priority.ToString());
```

Requirement 7's metric is what makes requirement 8 possible:

```csharp
_versionUsage.Add(1,
    new KeyValuePair<string, object?>("version", version),
    new KeyValuePair<string, object?>("client", clientId));    // low cardinality: a client id, NOT a user id
```

And the removal criterion, written down in advance:

```text
v1 is removed when BOTH are true for 30 consecutive days:
  - v1 traffic is under 0.1% of total requests
  - no client in the registered-client list has used v1

The sunset date is announced at least 90 days ahead and repeated at 30 and 7 days.
```

**Writing the criterion before you need it is the point.** Without it, "can we remove v1 yet?" is answered by whoever is most nervous, and the answer is always no — which is why APIs accumulate versions nobody uses but everyone is afraid to delete. A criterion converts a political question into a measurement.

Note the tag choice in the metric: `client` is a registered application identifier (low cardinality), not a user id (unbounded). The Phase 14 lesson on metrics applies here too.
:::

::: project Version and harden TaskFlow
1. URL-segment versioning, v1 as default.
2. A v2 with at least one genuine contract change.
3. Deprecation and `Sunset` headers on v1, plus usage logging.
4. Version-usage metrics with a low-cardinality client tag.
5. `appsettings.Production.json`, secrets from the environment only.
6. `AllowedHosts` set; HSTS, HTTPS redirection and no OpenAPI UI in production.
7. Production-mode settings in the `.csproj`, with `InvariantGlobalization` decided deliberately.
8. A test asserting production behaviour: no stack traces, no OpenAPI, security headers present.
9. `API.md` with the versioning policy and the removal criterion.

Commit. **Phase 14 is complete.**
:::

::: interview How do you version an API?
Preferably by not needing to. Most evolution is additive — new endpoints, new optional fields — and additive changes do not break clients, so they need no version.

When a genuine contract break is required, I use a URL segment: `/api/v2/tasks`. It is visible in logs, cacheable, and anyone can try it in a browser, which makes it easier to support than header-based versioning.

The important structural rule is that versioning lives entirely in the API layer. Different response DTOs and different mapping functions over one domain model — the moment a version appears in the application or domain layer you have two implementations of the same rule and they drift.

For removal: deprecate with `api-deprecated-versions` and a `Sunset` header per RFC 8594, log every call to the old version with the caller's identity, and track usage as a metric. And write the removal criterion down in advance — "under 0.1% of traffic for 30 days and no registered client using it" — because without one, "can we delete v1?" never gets a yes.
:::

::: checkpoint Phase 14 complete
- [ ] Both API versions work and appear in OpenAPI
- [ ] Versioning exists only in the API layer
- [ ] Production mode exposes no stack traces and no OpenAPI UI
- [ ] `AllowedHosts` is set
- [ ] I decided about `InvariantGlobalization` and tested the consequences
- [ ] The v1 removal criterion is written down
:::

## Common mistakes

::: mistake
**Versioning in the domain or application layer.** Two implementations of one rule.

**A new version for an additive change.** Version proliferation for nothing.

**Removing a version with no notice or usage data.** You find out who used it from the incident.

**`AllowedHosts: "*"` in production.** Host-header injection.

**Swagger UI in production.** A map of your attack surface.

**`InvariantGlobalization` without checking.** Culture-sensitive behaviour changes silently.
:::
