---
title: Separation of concerns
summary: What actually goes wrong in a codebase with no boundaries — demonstrated, then fixed.
minutes: 35
---

## What are we learning?

Why layers exist, starting from the pain rather than from the diagram.

## The codebase that has no boundaries

```csharp
[HttpPost]
public async Task<IActionResult> Create(CreateTaskRequest request)
{
    if (string.IsNullOrWhiteSpace(request.Title))
        return BadRequest("Title required");

    await using var conn = new NpgsqlConnection(_config.GetConnectionString("Default"));
    var project = await conn.QuerySingleOrDefaultAsync<Project>(
        "SELECT * FROM projects WHERE id = @id", new { id = request.ProjectId });
    if (project is null) return NotFound();

    var task = new TaskItem
    {
        Id = Guid.NewGuid(),
        Title = request.Title,
        Status = TaskStatus.Todo,
        CreatedAt = DateTime.UtcNow
    };

    await conn.ExecuteAsync("INSERT INTO tasks ...", task);

    if (project.NotifyOnCreate)
    {
        var smtp = new SmtpClient(_config["Smtp:Host"]);
        await smtp.SendMailAsync(new MailMessage(...));
    }

    return Ok(task);
}
```

This works. People ship this. Here is what it costs.

::: why Six concrete costs, not abstractions
1. **You cannot test it.** Testing "a task cannot be created in an archived project" requires a database, an SMTP server and an HTTP request.
2. **The rule exists in one place only — this method.** The next endpoint that creates a task will have a slightly different copy. Then they diverge.
3. **You cannot reuse it.** A CLI importer or a background job cannot call a controller action.
4. **Changing the database changes the controller.** The SQL is embedded in the HTTP layer.
5. **The business rule is invisible.** "Notify on create" is buried between an INSERT and a `return Ok`. Nobody reading this file is thinking about domain rules.
6. **It grows.** This method is 25 lines today. Add authorisation, audit logging, label handling, assignment validation and a webhook, and it is 200 lines that nobody dares change.
:::

## The separation

```text
┌─────────────────────────────────────────────┐
│ API            HTTP concerns only           │
│                routing, status codes, DTOs  │
├─────────────────────────────────────────────┤
│ APPLICATION    use cases / orchestration     │
│                "create a task" as a unit    │
├─────────────────────────────────────────────┤
│ DOMAIN         entities, rules, invariants  │
│                no framework, no I/O         │
├─────────────────────────────────────────────┤
│ INFRASTRUCTURE database, email, files, HTTP │
└─────────────────────────────────────────────┘
```

The same code, separated:

```csharp
// API — HTTP only
[HttpPost]
[ProducesResponseType<TaskResponse>(201)]
public async Task<ActionResult<TaskResponse>> Create(CreateTaskRequest request, CancellationToken ct)
{
    var task = await taskService.CreateAsync(request.ToCommand(), ct);
    return CreatedAtAction(nameof(Get), new { id = task.Id }, task.ToResponse());
}

// APPLICATION — the use case
public sealed class TaskService(
    ITaskRepository tasks,
    IProjectRepository projects,
    INotificationService notifications,
    TimeProvider clock) : ITaskService
{
    public async Task<TaskItem> CreateAsync(CreateTaskCommand command, CancellationToken ct)
    {
        var project = await projects.GetAsync(command.ProjectId, ct)
            ?? throw new ProjectNotFoundException(command.ProjectId);

        var task = project.AddTask(command.Title, command.Priority, clock);   // domain rules here

        await tasks.AddAsync(task, ct);

        if (project.NotifyOnCreate)
            await notifications.TaskCreatedAsync(task, ct);

        return task;
    }
}

// DOMAIN — the rules
public sealed class Project
{
    public TaskItem AddTask(string title, Priority priority, TimeProvider clock)
    {
        if (IsArchived) throw new ProjectStateException(this, "add a task to");
        if (_tasks.Count >= 500) throw new ProjectStateException(this, "exceed 500 tasks in");

        var task = new TaskItem(title, Id, priority, clock);
        _tasks.Add(task);
        return task;
    }
}

// INFRASTRUCTURE — the how
public sealed class EfTaskRepository(TaskFlowDbContext db) : ITaskRepository { ... }
public sealed class SmtpNotificationService(IOptions<SmtpOptions> options) : INotificationService { ... }
```

Now: the rule lives in `Project.AddTask` and is testable with no database. The use case is testable with fakes. The controller is three lines and has nothing to test. A CLI can call `TaskService` directly.

::: design What each layer may and may not do
| Layer | May | May not |
|---|---|---|
| **API** | Bind, validate shape, map DTOs, choose status codes | Contain business rules, touch the database |
| **Application** | Orchestrate, coordinate repositories, manage transactions | Know about HTTP, contain entity invariants |
| **Domain** | Enforce invariants, express rules | Reference EF Core, ASP.NET Core, or any I/O |
| **Infrastructure** | Talk to databases, queues, email, external APIs | Contain business rules |

The dependency rule: **everything depends on the domain; the domain depends on nothing.** Infrastructure implements interfaces that the domain or application layer defines. That inversion is what lets you swap PostgreSQL for something else without touching a business rule.
:::

## Where people overdo it

::: warn Layers are not free
Each boundary costs: a DTO, a mapping, an interface, a registration. For a three-endpoint CRUD service over one table, four layers is more code than the problem.

Honest guidance by size:
- **A tiny service, few rules, unlikely to grow:** controller → EF Core. Genuinely fine. "Simple CRUD" does not need a domain layer.
- **Real business rules, multiple entry points, a team:** the separation above pays for itself within weeks.
- **A large system with several bounded contexts:** more structure, plus the patterns in Phase 12.

The signal that you need the boundary is not size, it is **rules**. When the answer to "where does this rule live?" is "in whichever method happened to need it", you needed a domain layer a while ago.
:::

::: exercise Level 1 — Guided · Find the violations
Go through your own TaskFlow code and list every place where a layer does something it should not.

Look specifically for:
1. Business logic in a controller (an `if` that encodes a rule).
2. HTTP concepts in the application layer (`IActionResult`, status codes, `HttpContext`).
3. EF Core types outside Infrastructure (`DbContext`, `IQueryable`, `Include`).
4. Domain entities that know how they are stored.
5. Rules duplicated in two places.

Write the list down before you fix anything. Most people find between five and fifteen.
:::

::: challenge Level 3 · Refactor one endpoint, properly
Take your most complex endpoint — probably `POST /api/tasks` or the assignment endpoint — and separate it fully.

Requirements:
1. The controller action is at most five lines.
2. Every business rule is in the domain, in a method with a name that states the rule.
3. The application service orchestrates and contains no rules of its own.
4. A unit test for each rule, with **no** database and **no** HTTP.
5. The same operation is callable from a CLI command, proving reusability.
6. Behaviour is unchanged — your `.http` file still passes.

Then count the lines before and after. It will be more code. Be able to say why that is worth it.
:::

::: solution
It will be roughly 40% more lines. The honest accounting:

**What you paid:** an interface, a command type, a mapping method, a service class, a registration.

**What you bought:**

```csharp
[Fact]
public void Cannot_add_a_task_to_an_archived_project()
{
    var project = new Project("Old", ownerId);
    project.Archive();

    var ex = Assert.Throws<ProjectStateException>(
        () => project.AddTask("New task", Priority.Normal, TimeProvider.System));

    Assert.Contains("archived", ex.Message);
}
```

That test runs in under a millisecond, needs no database, no container, no HTTP, and no test data setup. In the "before" version, the equivalent test needed a PostgreSQL container, a seeded project, an HTTP client and an SMTP stub — perhaps 40 lines of setup and 400ms per run.

Multiply by the fifty rules a real application accumulates. The separation is not about elegance; it is about whether your test suite runs in two seconds or four minutes, because a suite that takes four minutes is a suite people stop running.

The second thing you bought is a single place to look. When someone asks "what are the rules for creating a task", the answer is `Project.AddTask` — one method, twelve lines, reads like the requirements document.
:::

::: project Audit TaskFlow
1. The violation list from the exercise, written into `DECISIONS.md`.
2. Fix at least the five worst.
3. Confirm the layer boundaries hold:
   ```bash
   grep -rn "DbContext\|IQueryable\|Include(" src/TaskFlow.Api src/TaskFlow.Application | grep -v "^Binary"
   grep -rn "IActionResult\|HttpContext\|StatusCode" src/TaskFlow.Application src/TaskFlow.Domain
   ```
   Both should return nothing.
4. Add those greps to your build script so the boundary is checked, not remembered.

Commit.
:::

::: interview Why separate an application into layers?
So that business rules live in one place, can be tested without infrastructure, and can be reused from more than one entry point. The concrete payoff is the test suite: a rule that lives in a domain entity is tested in a millisecond with no database, whereas the same rule embedded in a controller needs a container, a seeded database and an HTTP client.

The dependency rule is what makes it work — the domain depends on nothing, and infrastructure implements interfaces the inner layers define. That is what lets you change database or delivery mechanism without touching a rule.

The honest counterpoint is that layers cost real code — a DTO, a mapping, an interface and a registration per boundary — so a small CRUD service over one table genuinely does not need them. The signal that you do is having business rules whose home is otherwise "whichever method needed them first".
:::

::: checkpoint
- [ ] I listed my own layer violations before fixing them
- [ ] My controllers contain no business rules
- [ ] No EF Core type appears outside Infrastructure
- [ ] I can test a business rule with no database
- [ ] I can state when layering is not worth it
:::

## Common mistakes

::: mistake
**Business rules in controllers.** Untestable, unreusable, duplicated by the second endpoint.

**An "application" layer that just forwards to a repository.** If a service adds nothing, it is a layer of noise. Delete it or give it a job.

**`IQueryable` crossing a layer boundary.** The consumer is now coupled to EF Core's translation rules and to the context's lifetime.

**A domain model that is only property bags.** If entities have no methods, the rules are somewhere else, and the layering achieved nothing.

**Applying four layers to a CRUD service over one table.** Ceremony with no payoff.
:::
