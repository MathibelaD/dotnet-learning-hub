---
title: Your first Web API
summary: Minimal APIs and controllers side by side, and what the request pipeline actually is.
minutes: 40
stage: Stage 3
---

## What are we learning?

How an ASP.NET Core application starts, the two styles of defining endpoints, and how to choose between them.

## The smallest API

```bash
cd ~/dotnet-scratch
dotnet new web -o firstapi && cd firstapi
```

`Program.cs`:

```csharp
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/", () => "Hello");

app.Run();
```

```bash
dotnet run
curl http://localhost:5xxx/
```

That is a complete HTTP server. There is no `web.config`, no IIS, no external host — .NET has a web server (Kestrel) built in.

## What `WebApplication.CreateBuilder` gives you

It is `Host.CreateApplicationBuilder` from Phase 5 plus web-specific parts:

```text
builder.Configuration     appsettings + environment + args   (Phase 5)
builder.Services          the DI container                   (Phase 5)
builder.Logging           ILogger providers                  (Phase 5)
builder.Environment       Development / Production
builder.WebHost           Kestrel, URLs, ports
```

And `builder.Build()` produces a `WebApplication`, which is both:
- an `IApplicationBuilder` — you add **middleware** to it
- an `IEndpointRouteBuilder` — you add **endpoints** to it

## Two styles

### Minimal APIs

```csharp
var tasks = app.MapGroup("/api/tasks").WithTags("Tasks");

tasks.MapGet("/", async (ITaskService service, CancellationToken ct) =>
    Results.Ok(await service.ListAsync(ct)));

tasks.MapGet("/{id:guid}", async (Guid id, ITaskService service, CancellationToken ct) =>
    await service.GetAsync(id, ct) is { } task
        ? Results.Ok(task)
        : Results.NotFound());

tasks.MapPost("/", async (CreateTaskRequest request, ITaskService service, CancellationToken ct) =>
{
    var created = await service.CreateAsync(request, ct);
    return Results.Created($"/api/tasks/{created.Id}", created);
});

tasks.MapDelete("/{id:guid}", async (Guid id, ITaskService service, CancellationToken ct) =>
    await service.DeleteAsync(id, ct) ? Results.NoContent() : Results.NotFound());
```

Notice: `ITaskService` and `CancellationToken` are injected into the lambda automatically. The framework works out which parameters come from the route, which from the body, and which from DI.

### Controllers

```csharp
// Program.cs
builder.Services.AddControllers();
app.MapControllers();
```

```csharp
[ApiController]
[Route("api/[controller]")]
public sealed class TasksController(ITaskService service) : ControllerBase
{
    [HttpGet]
    public async Task<ActionResult<IReadOnlyList<TaskResponse>>> List(CancellationToken ct) =>
        Ok(await service.ListAsync(ct));

    [HttpGet("{id:guid}")]
    public async Task<ActionResult<TaskResponse>> Get(Guid id, CancellationToken ct) =>
        await service.GetAsync(id, ct) is { } task ? Ok(task) : NotFound();

    [HttpPost]
    public async Task<ActionResult<TaskResponse>> Create(CreateTaskRequest request, CancellationToken ct)
    {
        var created = await service.CreateAsync(request, ct);
        return CreatedAtAction(nameof(Get), new { id = created.Id }, created);
    }

    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Delete(Guid id, CancellationToken ct) =>
        await service.DeleteAsync(id, ct) ? NoContent() : NotFound();
}
```

`[ApiController]` is doing real work: it makes `[FromBody]` the default for complex types, adds automatic 400 responses for invalid models, and requires attribute routing.

::: design Minimal APIs or controllers?
| | Minimal APIs | Controllers |
|---|---|---|
| Ceremony | Very little | More |
| Startup performance | Slightly faster | Slightly slower |
| Grouping | `MapGroup` | The class |
| Cross-cutting concerns | Endpoint filters | Action filters, model binders |
| Shared base behaviour | Extension methods | Base controller class |
| Familiarity | Newer | What most existing code uses |

Both are fully supported, both are fast, and you can mix them in one application.

**Recommendation for TaskFlow: controllers.** Reasons: you are learning a stack you will be hired to work in, and the majority of existing .NET APIs use controllers; the `[ApiController]` conventions do a lot of useful work for free; and action filters are a cleaner story than endpoint filters for validation and authorisation.

But write a couple of minimal API endpoints too — health checks and simple lookups are genuinely nicer that way, and you should be fluent in both.
:::

## Ports and launch settings

`Properties/launchSettings.json` (development only, never deployed):

```json
{
  "profiles": {
    "http": {
      "commandName": "Project",
      "applicationUrl": "http://localhost:5080",
      "environmentVariables": { "ASPNETCORE_ENVIRONMENT": "Development" }
    }
  }
}
```

In production, the URL comes from configuration or environment variables:

```bash
export ASPNETCORE_URLS="http://+:8080"
```

The `+` means "all interfaces" — which is what you need inside a container (Phase 15), where binding to `localhost` makes the service unreachable from outside.

## Testing an API from the terminal

```bash
curl -i localhost:5080/api/tasks
curl -i -X POST localhost:5080/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"Learn ASP.NET Core","priority":"High"}'
curl -i -X DELETE localhost:5080/api/tasks/3f2a...
```

Or use a `.http` file, which VS Code and Rider execute directly:

```text
### Create a task
POST http://localhost:5080/api/tasks
Content-Type: application/json

{ "title": "Learn ASP.NET Core", "priority": "High" }

### List
GET http://localhost:5080/api/tasks
```

Commit that file. It is executable documentation, and far better than a README describing the endpoints.

::: exercise Level 1 — Guided · Build both styles
```bash
cd ~/dotnet-scratch
dotnet new webapi -o bothstyles && cd bothstyles
```

1. Delete the sample weather endpoint.
2. Create an in-memory `List<TaskItem>` as a singleton service.
3. Build the five CRUD endpoints as **minimal APIs** under `/minimal/tasks`.
4. Build the same five as a **controller** under `/api/tasks`.
5. Exercise every endpoint with curl and confirm both return identical results.
6. Write a `.http` file covering all ten endpoints.
7. Look at what each returns for a missing id — make sure it is 404 with no body, not 200 with `null`.
:::

::: challenge Level 3 · Status codes that are actually correct
For each scenario, decide the correct status code and implement it. Do not guess — look up anything you are unsure of, and be able to justify each one.

1. `GET /api/tasks` with no tasks in the system.
2. `GET /api/tasks/{id}` where the id does not exist.
3. `GET /api/tasks/{id}` where the id is not a valid Guid.
4. `POST /api/tasks` with a valid body.
5. `POST /api/tasks` with an empty title.
6. `POST /api/tasks` with no `Content-Type` header.
7. `PUT /api/tasks/{id}` where the id does not exist.
8. `DELETE /api/tasks/{id}` where it exists.
9. `DELETE /api/tasks/{id}` where it does not — twice in a row.
10. `POST /api/tasks/{id}/complete` on a task that is already complete.
:::

::: solution
1. **200** with `[]`. An empty collection is a successful result, not a 404. A 404 would mean the *collection resource* does not exist.
2. **404**.
3. **400**. The route constraint `{id:guid}` rejects it before your code runs — you get 404 from routing by default, which is defensible but 400 is more accurate. Add a constraint plus explicit validation if you care.
4. **201 Created**, with a `Location` header pointing at the new resource and the created object in the body.
5. **400** with a `ProblemDetails` body listing the field errors (lesson 4 and 7).
6. **415 Unsupported Media Type**. ASP.NET Core returns this automatically.
7. **404** if you do not support upsert; **201** if you do and you create it. Pick one and document it.
8. **204 No Content**. Nothing to return.
9. **404** both times — *or* **204** both times. This is the interesting one: `DELETE` is supposed to be **idempotent**, meaning repeating it has the same effect. Both answers preserve that (the effect is "it is gone"), and both are widely used. 404 gives the caller more information; 204 makes retries simpler. Choose, write it down, be consistent.
10. **409 Conflict**. The request is well-formed and the resource exists, but its current state forbids the operation. Not 400 (the request is fine), not 404 (it exists), not 500 (nothing went wrong).

The thing to take from this: **status codes are part of your API's contract**, and getting them right is one of the clearest signals of whether an API was designed or accreted. 409 and 422 in particular separate people who have thought about it from people who return 400 for everything.
:::

::: project Create the TaskFlow API
This is **Stage 3**.

```bash
cd ~/taskflow
dotnet new webapi -o src/TaskFlow.Api --use-controllers
dotnet sln add src/TaskFlow.Api
dotnet add src/TaskFlow.Api reference src/TaskFlow.Application
```

Then:
1. Delete the weather sample.
2. Wire in `AddTaskFlowApplication(builder.Configuration)` from Phase 5 — your service registration already works unchanged.
3. `TasksController` with `GET /api/tasks`, `GET /api/tasks/{id:guid}`, `POST`, `PUT`, `DELETE`, backed by your existing `ITaskStore`.
4. A minimal API `GET /health` returning `{ "status": "ok" }`.
5. `launchSettings.json` on port 5080.
6. A `.http` file exercising every endpoint, committed.
7. Correct status codes for all ten scenarios from the challenge.

Verify the layering held: `TaskFlow.Api` references `TaskFlow.Application`, which references `TaskFlow.Domain`. The domain still references nothing, and your build target from Phase 5 still enforces it.

Commit.
:::

::: interview What is ASP.NET Core?
A cross-platform framework for building web applications and APIs on .NET. It ships with its own web server, Kestrel, so an application is a console program that happens to listen on a socket — there is no external host requirement.

The architecture is a **middleware pipeline**: each request passes through an ordered chain of components, each of which can act on the request, pass it along, and act on the response. Endpoints — defined as controllers or as minimal API lambdas — sit at the end of that pipeline.

It is built around the same hosting, configuration, dependency injection and logging abstractions as any other .NET application, which is why a service registered in a console app works unchanged in an API.
:::

::: checkpoint
- [ ] I built the same CRUD API twice, as minimal APIs and as controllers
- [ ] I can justify the correct status code for all ten scenarios
- [ ] I know what `[ApiController]` does for me
- [ ] I have a committed `.http` file that exercises every endpoint
- [ ] TaskFlow has an API project layered on the existing application code
:::

## Common mistakes

::: mistake
**Returning 404 for an empty list.** 200 with `[]`.

**Returning 200 with a null body for a missing resource.** Clients cannot distinguish "not found" from "found, but empty".

**200 for everything, with a `success` flag in the body.** You have reinvented status codes, worse. Use HTTP.

**Binding to `localhost` in a container.** Nothing outside the container can reach it. Use `http://+:8080`.

**Committing `launchSettings.json` secrets.** It is a development file; keep it free of anything sensitive.
:::
