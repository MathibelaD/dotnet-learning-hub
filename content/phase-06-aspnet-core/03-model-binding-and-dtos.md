---
title: Model binding and DTOs
summary: How JSON becomes a C# object, and why your API must never expose domain entities directly.
minutes: 40
stage: Stage 3
---

## What are we learning?

The binding pipeline, `System.Text.Json` configuration, and the single most important API design decision: separating your wire contract from your domain model.

## Binding sources

```text
Request  ──▶  Route values ──┐
              Query string ──┤
              Headers      ──┼──▶ Model binder ──▶ your parameter
              Body (JSON)  ──┤
              Form         ──┤
              DI container ──┘
```

With `[ApiController]`, inference handles the common cases. The explicit attributes are `[FromRoute]`, `[FromQuery]`, `[FromHeader]`, `[FromBody]`, `[FromForm]`, `[FromServices]`, and `[FromKeyedServices("name")]`.

Only **one** parameter can come from the body — there is one request body and it can only be read once.

## DTOs: the rule

::: why Never expose a domain entity over HTTP
```csharp
[HttpPost]
public async Task<TaskItem> Create(TaskItem task)   // ❌ domain entity as the contract
```

Six concrete problems:

1. **Over-posting.** A client sends `{"title":"x","id":"...","createdAt":"1999-01-01","status":"Completed"}` and the binder happily sets fields you never intended to be settable. This is a real vulnerability class, not a style issue.
2. **Over-exposure.** Add `PasswordHash` to `User` and it appears in every API response. Nothing warned you.
3. **Coupling.** Renaming a domain property becomes a breaking API change. You can no longer refactor your own code.
4. **Serialisation cycles.** `Task.Project.Tasks.Project…` — either an exception or a 40 MB response.
5. **Lazy loading.** With EF Core (Phase 7), serialising an entity can trigger unexpected database queries mid-response.
6. **No place to shape.** The API often wants a computed field (`isOverdue`), a flattened name (`assigneeName`), or fewer fields. An entity has nowhere to put them.

The rule: **every request and every response has its own type.**
:::

```csharp
// requests
public sealed record CreateTaskRequest(
    string Title,
    string? Description,
    Priority Priority,
    Guid ProjectId,
    DateOnly? DueDate,
    IReadOnlyList<string>? Labels);

public sealed record UpdateTaskRequest(
    string Title, string? Description, Priority Priority, DateOnly? DueDate);

public sealed record AssignTaskRequest(Guid AssigneeId);

// responses
public sealed record TaskResponse(
    Guid Id, string Title, string? Description,
    string Status, string Priority,
    Guid ProjectId, string ProjectName,
    Guid? AssigneeId, string? AssigneeName,
    DateOnly? DueDate, bool IsOverdue,
    IReadOnlyList<string> Labels, int CommentCount,
    DateTimeOffset CreatedAt, DateTimeOffset? CompletedAt);

public sealed record PagedResponse<T>(
    IReadOnlyList<T> Items, int Page, int PageSize, int TotalCount, int TotalPages);
```

Note what the response does that the entity cannot: it flattens `AssigneeName`, computes `IsOverdue`, counts comments instead of embedding them, and renders enums as strings.

## Mapping

Start with explicit mapping. It is boring, it is obvious, and it never surprises you.

```csharp
public static class TaskMapping
{
    public static TaskResponse ToResponse(this TaskItem task, string projectName, string? assigneeName, DateOnly today) =>
        new(task.Id, task.Title, task.Description,
            task.Status.ToString(), task.Priority.ToString(),
            task.ProjectId, projectName,
            task.AssigneeId, assigneeName,
            task.DueDate, task.IsOverdue(today),
            task.Labels, task.Comments.Count,
            task.CreatedAt, task.CompletedAt);
}
```

Mapping libraries (AutoMapper, Mapster) exist. Phase 8 discusses when they pay for themselves; the short version is that hand-written mapping is more code and fewer mysteries, and for an API of this size it is the right call.

## `System.Text.Json`

```csharp
builder.Services.ConfigureHttpJsonOptions(o =>          // minimal APIs
{
    o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    o.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
    o.SerializerOptions.Converters.Add(new JsonStringEnumConverter());
});

builder.Services.AddControllers().AddJsonOptions(o =>   // controllers
{
    o.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    o.JsonSerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
    o.JsonSerializerOptions.Converters.Add(new JsonStringEnumConverter());
    o.JsonSerializerOptions.PropertyNameCaseInsensitive = true;
});
```

The defaults you will nearly always want: camelCase property names, enums as strings, nulls omitted.

::: warn Enums as numbers are a trap
Without `JsonStringEnumConverter`, `"priority": 2` is what clients see and send. Then someone inserts a new enum member in the middle (Phase 1's warning) and every existing client's data silently changes meaning.

`"priority": "High"` is self-documenting, survives reordering, and shows up sensibly in logs and in OpenAPI docs. The cost is a few bytes.
:::

Per-property control:

```csharp
public sealed record TaskResponse
{
    [JsonPropertyName("task_id")] public Guid Id { get; init; }
    [JsonIgnore] public string InternalNote { get; init; } = "";
    [JsonPropertyOrder(-1)] public string Type { get; init; } = "task";
}
```

## Custom binding

For a type the binder does not know — say `DateOnly` from a non-standard format, or a comma-separated list:

```csharp
public sealed class CommaSeparatedBinder : IModelBinder
{
    public Task BindModelAsync(ModelBindingContext context)
    {
        var value = context.ValueProvider.GetValue(context.ModelName).FirstValue;
        var parts = value?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries) ?? [];
        context.Result = ModelBindingResult.Success(parts);
        return Task.CompletedTask;
    }
}

// usage
[ModelBinder(typeof(CommaSeparatedBinder))] string[] labels
```

For minimal APIs the equivalent is a static `TryParse` or `BindAsync` on the type itself, which the framework discovers automatically.

::: exercise Level 1 — Guided · Build the contract
1. Create `Contracts/` in `TaskFlow.Api` with `CreateTaskRequest`, `UpdateTaskRequest`, `TaskResponse`, `TaskSummaryResponse`, `PagedResponse<T>`.
2. Write explicit mapping extension methods.
3. Configure JSON: camelCase, string enums, omit nulls.
4. Change every controller action to accept and return DTOs. No `TaskItem` may appear in any signature.
5. Prove over-posting is now impossible: `POST` a body containing `"id"` and `"createdAt"` and confirm they are ignored.
6. Add a computed `isOverdue` to the response and confirm it appears.
7. `curl` a response and check the JSON shape is what you designed — camelCase, `"status": "Todo"` not `"status": 0`.
:::

::: debug Level 4 · Four binding bugs
Each of these fails in a different way. Diagnose and fix each.

```csharp
// A — the body is always null
[HttpPost]
public IActionResult Create([FromQuery] CreateTaskRequest request) => Ok();

// B — works in Postman, fails from the JavaScript client
public sealed record CreateTaskRequest
{
    public string Title { get; set; } = "";
}

// C — 400 with "The JSON value could not be converted to Priority"
public sealed record CreateTaskRequest(string Title, Priority Priority);
// client sends: { "title": "x", "priority": "high" }

// D — response is {} for every task
public sealed class TaskResponse
{
    public Guid Id;
    public string Title = "";
}
```
:::

::: solution
**A — wrong binding source.** `[FromQuery]` on a complex type binds each property from the query string, so the JSON body is never read and every property is default. Remove the attribute (with `[ApiController]`, complex types bind from the body) or write `[FromBody]`.

**B — case sensitivity, probably.** If `PropertyNameCaseInsensitive` is false and the client sends `Title` vs `title`, binding silently produces the default. The fix is `PropertyNamingPolicy = CamelCase` plus `PropertyNameCaseInsensitive = true`. Note the failure mode: no error, just an empty string, which then fails validation with a confusing message.

**C — enum casing.** `JsonStringEnumConverter` is case-**sensitive** by default, so `"high"` does not match `High`. Fix: `new JsonStringEnumConverter(JsonNamingPolicy.CamelCase, allowIntegerValues: false)`, or use `JsonStringEnumConverter<Priority>` with a naming policy. Being lenient on input and consistent on output is the right posture here.

**D — fields, not properties.** `System.Text.Json` serialises **public properties** by default, not fields. `public Guid Id;` is a field. Change to `public Guid Id { get; init; }` — or set `IncludeFields = true`, which you should not, because it is surprising to every reader.

D is the one that wastes the most time, because the object is clearly populated in the debugger and clearly empty on the wire.
:::

::: challenge Level 3 · PATCH done properly
Implement `PATCH /api/tasks/{id}` supporting partial updates.

The hard part: how do you distinguish "the client did not send `description`" from "the client sent `description: null` to clear it"? A nullable property cannot express both.

Requirements:
1. Both cases are distinguishable and behave differently.
2. An unknown property in the body is rejected with a 400.
3. Only `title`, `description`, `priority` and `dueDate` are patchable; sending `status` gets a clear error directing the caller to `POST /tasks/{id}/complete`.
4. It works from a plain `curl` with a JSON body — no special content type.
5. OpenAPI documents it accurately (lesson 8).
:::

::: solution
Two viable designs.

**Option 1 — JSON Patch (RFC 6902).** The standard answer, with `Microsoft.AspNetCore.JsonPatch`:
```json
[ { "op": "replace", "path": "/description", "value": null } ]
```
Unambiguous by construction, but an unusual content type (`application/json-patch+json`), awkward to hand-write, and it pulls in Newtonsoft.Json.

**Option 2 — an optional wrapper.** Better for a typical API:

```csharp
public readonly struct Optional<T>
{
    private Optional(T? value, bool set) { Value = value; IsSet = set; }
    public T? Value { get; }
    public bool IsSet { get; }
    public static Optional<T> Unset => default;
    public static implicit operator Optional<T>(T? value) => new(value, true);
}

public sealed record PatchTaskRequest
{
    public Optional<string> Title { get; init; }
    public Optional<string?> Description { get; init; }
    public Optional<Priority> Priority { get; init; }
    public Optional<DateOnly?> DueDate { get; init; }
}
```

With a converter that only ever constructs a *set* `Optional<T>` when the property is present in the JSON:

```csharp
public sealed class OptionalConverter<T> : JsonConverter<Optional<T>>
{
    public override Optional<T> Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options) =>
        JsonSerializer.Deserialize<T>(ref reader, options);          // implicit conversion marks it set

    public override void Write(Utf8JsonWriter writer, Optional<T> value, JsonSerializerOptions options)
    {
        if (value.IsSet) JsonSerializer.Serialize(writer, value.Value, options);
    }
}
```

Because `Read` is only called when the property **exists** in the payload, `IsSet` is true exactly when the client sent it — including when they sent `null`. Absent properties keep `default`, which is `Unset`.

Applying it:
```csharp
if (request.Title.IsSet) task.Rename(request.Title.Value!);
if (request.Description.IsSet) task.Describe(request.Description.Value);   // null clears it
```

For requirement 2, `JsonSerializerOptions.UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow` (from .NET 8) rejects unknown properties with a clear error — no custom code needed.

For requirement 3, a `status` property declared on the DTO whose presence produces a targeted 400:
```csharp
public Optional<string> Status { get; init; }
// in the handler:
if (request.Status.IsSet)
    return Problem(statusCode: 400,
        title: "Status cannot be patched",
        detail: "Use POST /api/tasks/{id}/complete, /start, /block or /cancel to change status.");
```
Refusing with a pointer to the right endpoint is far kinder than refusing with "unknown property".
:::

::: project DTOs throughout TaskFlow
1. Full `Contracts/` folder, requests and responses.
2. No domain type in any controller signature. Verify with a grep.
3. Explicit mapping extensions.
4. JSON configured: camelCase, string enums (case-insensitive input), omit nulls, `UnmappedMemberHandling.Disallow`.
5. `PATCH` with `Optional<T>`.
6. Update `.http` and `API.md` with the exact request and response shapes.
7. Add to `DECISIONS.md`: why DTOs, and what you would lose by returning entities.

Commit.
:::

::: interview Why use DTOs instead of returning your domain entities?
To decouple the wire contract from the internal model. Concretely: it prevents over-posting, where a client sets properties you never intended to expose; it prevents over-exposure, where adding a field to an entity silently leaks it through every endpoint; it stops a domain rename from being a breaking API change; and it gives you somewhere to put computed or flattened fields that do not belong on the entity.

With an ORM there are two more reasons: serialising an entity graph can cause cycles, and it can trigger lazy-loaded queries during response writing.

The cost is mapping code, which for a service of moderate size is worth paying explicitly rather than hiding behind a mapping library.
:::

::: checkpoint
- [ ] No domain type appears in any controller signature
- [ ] I proved over-posting no longer works
- [ ] Enums serialise as strings in responses and accept any casing on input
- [ ] I found all four binding bugs, including the fields one
- [ ] `PATCH` distinguishes "absent" from "explicitly null"
:::

## Common mistakes

::: mistake
**Binding straight to entities.** Over-posting, over-exposure, and a contract you cannot refactor.

**Fields instead of properties on a DTO.** Serialises as `{}`.

**Enums as integers.** Reordering the enum silently changes every client's meaning.

**Two `[FromBody]` parameters.** The body can be read once. The second is always null.

**Ignoring unknown properties in a request.** The client thinks the field was applied. `UnmappedMemberHandling.Disallow`.
:::
