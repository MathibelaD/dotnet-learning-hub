---
title: "Checkpoint: restructure TaskFlow"
summary: Apply the architecture to the whole application, and write down what it cost.
minutes: 90
---

## What are we learning?

Nothing new. This is the restructuring pass, and it is the point at which the code you have been growing since Phase 1 becomes something you would be comfortable handing to another engineer.

::: stop
Do not start this until Stage 4 is committed and tagged. You want to be able to diff against it.
:::

## The deliverable

```text
TaskFlow/
├── Directory.Build.props
├── Directory.Packages.props
├── .editorconfig
├── docker-compose.yml
├── global.json
├── API.md
├── DECISIONS.md
├── DEPENDENCIES.md
├── docs/
│   ├── TaskFlow.Api.json          generated OpenAPI
│   └── migrations/
├── scripts/
│   ├── build.sh
│   ├── migrate.sh
│   └── benchmark.sh
├── src/
│   ├── TaskFlow.Domain/
│   │   ├── Entities/              TaskItem, Project, User, Comment
│   │   ├── ValueObjects/          DateRange, TaskId, …
│   │   ├── Enums/
│   │   ├── Behaviours/            the composition work from Phase 1
│   │   ├── Exceptions/
│   │   ├── Repositories/          INTERFACES only
│   │   └── Services/              domain services (assignment rules)
│   ├── TaskFlow.Application/
│   │   ├── Commands/
│   │   ├── Queries/
│   │   ├── Services/
│   │   ├── Validators/
│   │   ├── Abstractions/          ITaskQueries, INotificationService, IUnitOfWork
│   │   └── DependencyInjection.cs
│   ├── TaskFlow.Infrastructure/
│   │   ├── Persistence/           DbContext, Configurations, Migrations
│   │   ├── Repositories/
│   │   ├── Queries/               projection implementations
│   │   ├── Notifications/
│   │   └── DependencyInjection.cs
│   ├── TaskFlow.Api/
│   │   ├── Controllers/
│   │   ├── Contracts/             requests and responses
│   │   ├── Middleware/
│   │   ├── Filters/
│   │   └── Program.cs
│   └── TaskFlow.Cli/
└── tests/
    ├── TaskFlow.Domain.Tests/
    ├── TaskFlow.Application.Tests/
    ├── TaskFlow.Architecture.Tests/
    └── TaskFlow.Integration.Tests/
```

## Requirements

1. **The dependency rule holds**, enforced by MSBuild and by architecture tests.
2. **No behaviour changes.** Your `.http` file passes identically before and after.
3. **Every layer registers its own services** through an extension method; `Program.cs` calls four of them and is under 60 lines.
4. **Domain tests run in under 200ms** with no I/O.
5. **Two delivery mechanisms** (API and CLI) share every rule.
6. **Two repository implementations** (EF Core and file), selectable by configuration.
7. **`DECISIONS.md` is complete** — every architectural decision you have made since Phase 1, with the reasoning and the trade-off.

## Checkpoint

::: checkpoint
- [ ] `dotnet build` is clean with warnings as errors
- [ ] `dotnet test` passes, including the architecture tests
- [ ] The `.http` file produces identical responses to the `stage-4` tag
- [ ] `Program.cs` is under 60 lines
- [ ] No controller references `DbContext`
- [ ] No application type references `IActionResult`
- [ ] The domain project references nothing
- [ ] Domain tests run in under 200ms
- [ ] The CLI and the API both work, with no duplicated rules
- [ ] `DECISIONS.md` covers every significant choice
:::

::: project Do the restructure
Work in small commits — one per moved concern — so that if something breaks you can find it.

```bash
git checkout -b architecture-refactor
# ... many small commits ...
dotnet test
git checkout main && git merge architecture-refactor
git tag architecture-v1
```

Then measure what it cost:

```bash
git diff --stat stage-4 HEAD
```

Record the number of files and the net line change in `DECISIONS.md`, alongside what you got for it.
:::

::: solution What a good `Program.cs` looks like
```csharp
var builder = WebApplication.CreateBuilder(args);

builder.Host.UseDefaultServiceProvider(o => { o.ValidateScopes = true; o.ValidateOnBuild = true; });

builder.Services
    .AddTaskFlowApplication(builder.Configuration)
    .AddTaskFlowInfrastructure(builder.Configuration)
    .AddTaskFlowApi(builder.Configuration);

var app = builder.Build();

app.UseExceptionHandler();                    // must wrap everything
if (!app.Environment.IsDevelopment()) app.UseHsts();
app.UseHttpsRedirection();
app.UseMiddleware<CorrelationIdMiddleware>(); // before anything that logs
app.UseMiddleware<SecurityHeadersMiddleware>();
app.UseRouting();
app.UseCors();
app.UseAuthentication();                      // before authorization, always
app.UseAuthorization();
app.UseStatusCodePages();

app.MapControllers();
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference();
    await app.Services.MigrateAndSeedAsync();
}

app.Run();

public partial class Program;                 // so WebApplicationFactory can find it (Phase 10)
```

Thirty lines, and every line is a decision you can explain. Each `Add...` extension lives with the layer it configures, so adding a service never touches this file.

`public partial class Program;` at the bottom is not decoration — top-level statements generate an `internal` `Program` class, and `WebApplicationFactory<Program>` needs it to be accessible. Adding it now saves a confusing error in Phase 10.

**What the diff typically shows:** around 25 new files and a net increase of perhaps 400 lines, mostly interfaces, registration extensions and mapping. In exchange: a 200ms domain test suite, two delivery mechanisms sharing one set of rules, two storage implementations, and boundaries that the build enforces.

Whether that is a good trade for *your* project is a judgement. For TaskFlow — which will grow authentication, testing, background services and deployment over the next eight phases — it is clearly worth it. State the judgement; do not just state the structure.
:::

::: interview Walk me through your project structure
> "Four source projects. Domain holds entities, value objects and repository interfaces, and references nothing — that is enforced by an MSBuild target and an architecture test, not by convention. Application holds use cases and orchestrates repositories; it knows nothing about HTTP. Infrastructure implements the repository interfaces with EF Core and holds the DbContext and mappings. The API is controllers, DTOs and middleware, and it is the composition root.
>
> The dependency rule points inward throughout, which means business rules are tested with no database — the domain suite runs in about 150 milliseconds. It also meant adding a CLI as a second entry point cost about a hundred lines of argument parsing and zero duplicated logic, and adding a file-based repository was one class and one registration.
>
> The cost was real: roughly 25 extra files and 400 lines. I would not do this for a CRUD service over one table. I would, and did, for something with genuine rules and more than one way in."
:::

::: checkpoint Phase 8 complete
- [ ] The restructure is merged and tagged
- [ ] I measured the cost and recorded it
- [ ] I can defend every boundary, including the ones I chose not to draw
- [ ] `DECISIONS.md` reads like something a new engineer could learn from
:::
