---
title: Routing and HTTP semantics
summary: Route templates, constraints, and designing URLs that do not embarrass you in six months.
minutes: 35
stage: Stage 3
---

## What are we learning?

How ASP.NET Core matches a request to an endpoint, and how to design a REST API that behaves the way clients expect.

## Route templates

```csharp
[HttpGet("{id:guid}")]                              // /api/tasks/3f2a-...
[HttpGet("{id:int:min(1)}")]                        // integer, at least 1
[HttpGet("{slug:regex(^[a-z0-9-]+$)}")]
[HttpGet("{year:int}/{month:int:range(1,12)}")]
[HttpGet("{*path}")]                                // catch-all, including slashes
[HttpGet("search/{term?}")]                         // optional
[HttpGet("page/{number:int=1}")]                    // default value
```

Common constraints: `int`, `long`, `guid`, `bool`, `datetime`, `decimal`, `alpha`, `length(n)`, `minlength(n)`, `maxlength(n)`, `min(n)`, `max(n)`, `range(a,b)`, `regex(...)`, `required`.

Constraints are not validation — they are **matching**. A request that fails a constraint does not match that route, so you get a 404 from routing rather than a 400 from your code. They exist to disambiguate routes, and to keep obviously wrong input away from your handler.

## Where values come from

```csharp
[HttpGet("{id:guid}/comments")]
public async Task<IActionResult> Comments(
    Guid id,                                  // route
    [FromQuery] int page = 1,                 // ?page=2
    [FromQuery(Name = "q")] string? search,   // ?q=text
    [FromHeader(Name = "X-Request-Id")] string? requestId,
    [FromServices] ITaskService service,      // DI
    CancellationToken ct)                     // DI (the request abort token)
```

With `[ApiController]`, the defaults are inferred: simple types from the route or query string, complex types from the body, and known service types from DI. You rarely need the attributes — write them only where the inference would be wrong.

## Designing the URLs

::: design REST URL design in ten rules
1. **Nouns, not verbs.** `/api/tasks`, not `/api/getTasks`. The verb is the HTTP method.
2. **Plural collections.** `/api/tasks/{id}`, not `/api/task/{id}`.
3. **Lowercase, hyphenated.** `/api/task-templates`, not `/api/TaskTemplates`.
4. **Nest only to express ownership.** `/api/projects/{id}/tasks` is good when tasks belong to a project. Do not nest three levels deep — `/api/tasks/{id}` should still work directly.
5. **Filtering, sorting and paging are query strings, not paths.** `/api/tasks?status=open&sort=-priority&page=2`.
6. **Actions that are not CRUD get a sub-resource.** `POST /api/tasks/{id}/complete` is better than `PUT /api/tasks/{id}` with a magic body, and much better than `POST /api/completeTask`.
7. **Version in the URL or a header, decided up front.** `/api/v1/tasks`. Phase 14 covers this properly; deciding later is expensive.
8. **Return the resource on create**, with a `Location` header.
9. **Do not leak your database.** URLs are a contract; table names and column names are not.
10. **Be consistent.** An inconsistent API is worse than a consistently odd one.

Applied to TaskFlow:
```text
GET    /api/tasks                       list + filter + page
POST   /api/tasks                       create
GET    /api/tasks/{id}                  read
PUT    /api/tasks/{id}                  full replace
PATCH  /api/tasks/{id}                  partial update
DELETE /api/tasks/{id}                  delete
POST   /api/tasks/{id}/complete         state transition
POST   /api/tasks/{id}/assign           state transition
GET    /api/tasks/{id}/comments         sub-collection
POST   /api/tasks/{id}/comments         add to sub-collection
GET    /api/projects/{id}/tasks         ownership
```
:::

## HTTP method semantics

| Method | Safe | Idempotent | Body | Meaning |
|---|---|---|---|---|
| `GET` | Yes | Yes | No | Read. Must not change anything. |
| `HEAD` | Yes | Yes | No | Headers only |
| `POST` | No | **No** | Yes | Create, or a non-idempotent action |
| `PUT` | No | Yes | Yes | Replace the whole resource |
| `PATCH` | No | No | Yes | Partial update |
| `DELETE` | No | Yes | No | Remove |

**Safe** means no observable change. **Idempotent** means doing it twice has the same effect as doing it once.

These are not pedantry. Proxies, CDNs and client libraries rely on them: a client that retries a failed request will happily retry a `PUT` and will refuse to retry a `POST`, because the spec says `PUT` is safe to repeat. Get it wrong and you get duplicate records after a network blip.

::: warn `GET` must never mutate
`GET /api/tasks/{id}/complete` is a real thing people build, and it is broken in several ways: a browser prefetch completes the task, a crawler completes every task it can find, a proxy caches the response, and a retry does it again.

If it changes state, it is not a `GET`.
:::

## Route matching order

ASP.NET Core picks the **most specific** match, not the first declared:

```csharp
[HttpGet("{id:guid}")]     // /api/tasks/3f2a...
[HttpGet("search")]        // /api/tasks/search  ← literal beats parameter
```

Precedence: literal segments > constrained parameters > unconstrained parameters > catch-all. An ambiguous match throws `AmbiguousMatchException` at request time, which is a clear error rather than a silent wrong-endpoint bug.

## Generating URLs

```csharp
// in a controller
var url = Url.Action(nameof(Get), new { id = task.Id });
return CreatedAtAction(nameof(Get), new { id = task.Id }, response);

// named minimal API routes
app.MapGet("/api/tasks/{id:guid}", ...).WithName("GetTask");
var url = linkGenerator.GetPathByName("GetTask", new { id });
```

Always generate, never concatenate. Hard-coded URL strings break silently when a route changes; `CreatedAtAction` fails loudly at the point of change.

::: exercise Level 1 — Guided · Routing practice
1. Add `GET /api/tasks/search?q=term` and confirm it is matched before `{id:guid}`.
2. Add `GET /api/tasks/{id:guid}/comments` and `POST` to the same URL.
3. Add `POST /api/tasks/{id:guid}/complete`.
4. Add `GET /api/projects/{projectId:guid}/tasks`.
5. Request `/api/tasks/not-a-guid` and observe the 404 from route matching.
6. Deliberately create an ambiguous route pair and read the exception.
7. Replace a hard-coded `$"/api/tasks/{id}"` in a `Created(...)` call with `CreatedAtAction`. Then rename the action method and confirm the build or the test catches it.
:::

::: challenge Level 3 · A filtering contract
Design and implement the query-string contract for `GET /api/tasks`. It must support everything your Phase 3 `TaskQuery` does.

Requirements:
1. Repeated parameters for multi-value filters: `?status=todo&status=blocked`.
2. Sorting with a direction prefix: `?sort=-priority,dueDate` (minus means descending, multiple keys).
3. Paging: `?page=2&pageSize=50`, clamped, with the real values echoed in the response.
4. An unknown query parameter is **rejected** with a 400 naming it — not silently ignored.
5. Everything bound into a single `TaskQueryParameters` record, not fifteen method parameters.
6. Documented in the `.http` file with a worked example of each.

Requirement 4 is the one people skip, and it is the one that saves your users hours: silently ignoring `?stauts=open` means they think the filter worked.
:::

::: solution
```csharp
public sealed record TaskQueryParameters
{
    [FromQuery(Name = "q")]        public string? Search { get; init; }
    [FromQuery(Name = "status")]   public string[]? Statuses { get; init; }
    [FromQuery(Name = "label")]    public string[]? Labels { get; init; }
    [FromQuery(Name = "assignee")] public Guid? AssigneeId { get; init; }
    [FromQuery(Name = "overdue")]  public bool? Overdue { get; init; }
    [FromQuery(Name = "sort")]     public string? Sort { get; init; }
    [FromQuery(Name = "page")]     public int Page { get; init; } = 1;
    [FromQuery(Name = "pageSize")] public int PageSize { get; init; } = 20;
}

[HttpGet]
public async Task<ActionResult<PagedResponse<TaskResponse>>> List(
    [FromQuery] TaskQueryParameters parameters, CancellationToken ct)
```

An array-typed property binds repeated parameters automatically — `?status=todo&status=blocked` gives a two-element array. No custom binder needed.

Sort parsing:
```csharp
public IEnumerable<(string Field, bool Descending)> ParseSort() =>
    (Sort ?? "-createdAt")
        .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .Select(s => s.StartsWith('-') ? (s[1..], true) : (s, false));
```

Rejecting unknown parameters — an action filter (lesson 6) is the right home, so it applies everywhere without being repeated:

```csharp
public sealed class RejectUnknownQueryParametersAttribute : ActionFilterAttribute
{
    public override void OnActionExecuting(ActionExecutingContext context)
    {
        var known = context.ActionDescriptor.Parameters
            .SelectMany(Expand)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        var unknown = context.HttpContext.Request.Query.Keys
            .Where(k => !known.Contains(k))
            .ToList();

        if (unknown.Count > 0)
            context.Result = new BadRequestObjectResult(new ProblemDetails
            {
                Title = "Unknown query parameters",
                Detail = $"Not recognised: {string.Join(", ", unknown)}. " +
                         $"Valid parameters: {string.Join(", ", known.Order())}.",
                Status = StatusCodes.Status400BadRequest
            });
    }
}
```

Listing the valid parameters in the error is the detail that turns a frustrating 400 into a self-service fix.

The trade-off to be aware of: strict rejection breaks clients that append their own tracking parameters (`?utm_source=...`). For a public API, consider allowing an explicit prefix or a small allowlist. For an internal API, strictness wins.
:::

::: project TaskFlow's routing contract
1. Implement the full URL table from the design box.
2. `TaskQueryParameters` bound from the query string, with repeated values and sort parsing.
3. Unknown-parameter rejection.
4. `CreatedAtAction` for every create, and no hard-coded URL anywhere.
5. Route constraints on every id.
6. Update the `.http` file with a worked example of every route, including the filters.
7. Write the URL table into `API.md` at the repo root.

Commit.
:::

::: interview What does it mean for an HTTP method to be idempotent?
Making the same request multiple times has the same effect as making it once. `GET`, `PUT` and `DELETE` are idempotent; `POST` and `PATCH` are not.

It matters because the whole HTTP infrastructure relies on it: clients, proxies and load balancers will retry an idempotent request after a timeout or a network failure, and will not retry a `POST`. So if a `POST` handler is genuinely repeat-safe you can say so, and if a `PUT` handler is not — say it appends rather than replaces — you have broken an expectation that something in the chain is relying on.

The related property is **safe**: `GET` and `HEAD` must not change server state at all, because browsers prefetch them, crawlers follow them and proxies cache them.
:::

::: checkpoint
- [ ] I can write route templates with constraints from memory
- [ ] I know the difference between a route constraint and validation
- [ ] I can state which HTTP methods are safe and which are idempotent, and why it matters
- [ ] My API rejects unknown query parameters with a helpful message
- [ ] No URL is hard-coded anywhere in TaskFlow
:::

## Common mistakes

::: mistake
**Verbs in URLs.** `/api/getTasks`, `/api/tasks/delete/{id}`. The method is the verb.

**`GET` that mutates.** Prefetching and caching will bite you.

**Silently ignoring unknown query parameters.** Users cannot tell a typo from a filter that had no effect.

**Deep nesting.** `/api/orgs/{a}/projects/{b}/tasks/{c}/comments/{d}` — nobody can construct that URL correctly. Nest one level and expose direct routes.

**Hard-coded URLs in `Created(...)`.** They break silently when routes change.
:::
