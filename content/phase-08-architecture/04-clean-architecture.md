---
title: Clean Architecture, honestly
summary: The dependency rule, what it buys, what it costs, and when it is the wrong choice.
minutes: 40
---

## What are we learning?

Clean Architecture (and its relatives: Onion, Hexagonal, Ports and Adapters) as an engineering trade-off rather than a doctrine.

## The one idea

Strip away the diagrams and there is a single rule:

> **Source code dependencies point inward. Nothing in an inner layer knows anything about an outer one.**

```text
        ┌─────────────────────────────┐
        │   Frameworks & Drivers      │   ASP.NET Core, EF Core, SMTP
        │  ┌───────────────────────┐  │
        │  │  Interface Adapters   │  │   controllers, repositories, presenters
        │  │  ┌─────────────────┐  │  │
        │  │  │  Use Cases      │  │  │   application services
        │  │  │  ┌───────────┐  │  │  │
        │  │  │  │ Entities  │  │  │  │   domain rules
        │  │  │  └───────────┘  │  │  │
        │  │  └─────────────────┘  │  │
        │  └───────────────────────┘  │
        └─────────────────────────────┘
                 dependencies →  inward only
```

## How the inversion works

The domain needs to save a task. Saving requires a database. The domain must not know about databases. Resolution: **the domain defines the interface; infrastructure implements it.**

```csharp
// TaskFlow.Domain  — defines what it needs
public interface ITaskRepository
{
    Task<TaskItem?> GetAsync(Guid id, CancellationToken ct);
    Task AddAsync(TaskItem task, CancellationToken ct);
}

// TaskFlow.Infrastructure — depends on Domain, provides the implementation
public sealed class EfTaskRepository(TaskFlowDbContext db) : ITaskRepository { ... }
```

The compile-time dependency now points from Infrastructure **to** Domain, while the runtime call goes from Domain outward. That is the Dependency Inversion Principle (Phase 11) doing the structural work.

## The projects

```text
src/
  TaskFlow.Domain/          entities, value objects, domain services,
                            repository INTERFACES, domain exceptions
                            references: NOTHING

  TaskFlow.Application/     use cases, commands, queries, DTOs,
                            application service interfaces, validators
                            references: Domain

  TaskFlow.Infrastructure/  DbContext, configurations, repository
                            implementations, email, file storage
                            references: Domain, Application

  TaskFlow.Api/             controllers, middleware, filters,
                            Program.cs, DI composition
                            references: Application, Infrastructure

tests/
  TaskFlow.Domain.Tests/          fast, no I/O
  TaskFlow.Application.Tests/     fast, fakes
  TaskFlow.Integration.Tests/     real database, real HTTP
```

::: note The API references Infrastructure — is that a violation?
No, and this confuses people. `Program.cs` is the **composition root**: the one place that knows every concrete type, because someone has to call `AddScoped<ITaskRepository, EfTaskRepository>()`.

What matters is that no *controller* and no *application service* references an infrastructure type. Only the composition root does.

If you want to enforce even that, a `TaskFlow.Bootstrap` project can own the registrations, leaving the API referencing only Application. That is extra structure for a small gain; most teams do not bother.
:::

## What it buys you

1. **Rules are testable in milliseconds.** No database, no HTTP.
2. **Infrastructure is replaceable.** Swapping PostgreSQL, or adding a second delivery mechanism (a gRPC service, a CLI, a queue consumer), touches no rule.
3. **The domain is readable.** `TaskFlow.Domain` contains the business, uncluttered by persistence and transport.
4. **Dependencies are enforceable.** The MSBuild target from Phase 5 makes "the domain depends on nothing" a build error rather than a convention.
5. **It scales with the team.** Boundaries are where responsibilities can be split.

## What it costs

::: warn The honest cost
1. **More projects, more files, more indirection.** A change that adds one field can touch six files.
2. **More types.** Request, command, entity, DTO, plus mapping between each.
3. **It can hide EF Core's strengths.** Repositories returning entities lose projection, which is the fastest read path (lesson 2's argument).
4. **Interfaces with one implementation.** `ITaskService`/`TaskService` where there will never be a second. That is not automatically wrong — it is how you fake it in a test — but it should be a choice, not a reflex.
5. **Junior developers get lost.** "Where do I add this?" has a non-obvious answer, and the wrong answer creates a mess that is harder to unpick than no structure at all.

**When not to use it:**
- A CRUD service over one or two tables with no real rules.
- A prototype whose purpose is to be thrown away.
- A team of one or two who ship faster without it and know the trade-off.
- A short-lived internal tool.

**When to use it:**
- Business rules that are genuinely complex.
- More than one entry point (API, CLI, scheduled jobs, message consumers).
- A codebase expected to live for years and be worked on by people who did not write it.
- Rules that must be tested exhaustively and quickly.

TaskFlow qualifies for the second list — that is why the course uses it. A blog engine would not.
:::

## Enforcing the boundaries

Conventions decay. Enforce them:

**With MSBuild** (Phase 5) — the domain-purity target.

**With architecture tests:**

```bash
dotnet add tests/TaskFlow.Architecture.Tests package NetArchTest.Rules
```

```csharp
[Fact]
public void Domain_does_not_depend_on_anything_outside_itself()
{
    var result = Types.InAssembly(typeof(TaskItem).Assembly)
        .Should()
        .NotHaveDependencyOnAny("Microsoft.EntityFrameworkCore", "Microsoft.AspNetCore", "TaskFlow.Infrastructure")
        .GetResult();

    Assert.True(result.IsSuccessful,
        $"These domain types reach outward: {string.Join(", ", result.FailingTypeNames ?? [])}");
}

[Fact]
public void Application_does_not_depend_on_infrastructure()
{
    var result = Types.InAssembly(typeof(ITaskService).Assembly)
        .Should().NotHaveDependencyOn("TaskFlow.Infrastructure")
        .GetResult();
    Assert.True(result.IsSuccessful);
}

[Fact]
public void Controllers_do_not_use_DbContext()
{
    var result = Types.InAssembly(typeof(TasksController).Assembly)
        .That().HaveNameEndingWith("Controller")
        .Should().NotHaveDependencyOn("Microsoft.EntityFrameworkCore")
        .GetResult();
    Assert.True(result.IsSuccessful);
}

[Fact]
public void Entities_are_sealed_and_have_no_public_setters()
{
    var offenders = typeof(TaskItem).Assembly.GetTypes()
        .Where(t => t.Namespace?.EndsWith(".Domain") == true && !t.IsAbstract && !t.IsInterface)
        .SelectMany(t => t.GetProperties())
        .Where(p => p.SetMethod is { IsPublic: true })
        .Select(p => $"{p.DeclaringType!.Name}.{p.Name}")
        .ToList();

    Assert.True(offenders.Count == 0, $"Public setters on domain types: {string.Join(", ", offenders)}");
}
```

These run in milliseconds and they never get tired. A rule that is tested is a rule; a rule in a wiki is a suggestion.

::: exercise Level 1 — Guided · Restructure and enforce
1. Move your types into the four projects as listed.
2. Fix the resulting compile errors — they are exactly your boundary violations, made visible.
3. Add `TaskFlow.Architecture.Tests` with the four tests above.
4. Add two more of your own:
   - No domain type has a public setter.
   - No application type references `IActionResult` or `HttpContext`.
5. Run them. Fix what fails.
6. Deliberately add a violation and confirm the test catches it.
:::

::: challenge Level 3 · Prove the architecture is real
Requirements — do all four, and each one should be *easy* if the architecture is right:

1. Add a **second delivery mechanism**: a CLI that creates, lists and completes tasks, calling the same application services as the API. No business logic may be duplicated.
2. Add a **second persistence implementation**: a file-based `ITaskRepository` writing JSON. Selectable by configuration.
3. Add a **second notification channel** without changing any existing file except a registration.
4. Write a domain test suite for every business rule that runs in under **200ms total** and touches no I/O.

Then answer honestly: which of these was hard, and what does that tell you about where your architecture is weak?
:::

::: solution
If the architecture holds, this is what each one costs:

**1 — CLI.** A new console project referencing Application and Infrastructure, calling `AddTaskFlowApplication` and `AddTaskFlowInfrastructure`, then resolving `ITaskService`. Perhaps 100 lines, all of it argument parsing. Zero business logic. If you found yourself copying rules out of a controller, the rules were in the wrong place.

**2 — File repository.** A new class implementing `ITaskRepository`, plus one line in the composition root. If it was hard, the interface was leaking EF Core — probably an `IQueryable` return or an `Include`-shaped method name.

**3 — Notification channel.** One class, one registration. This is Phase 5's work paying off.

**4 — Fast domain tests.** If they run in 200ms, your rules are in the domain. If they need a `DbContext`, they are not — and that is the finding.

**The common weak spot** is number 2, and it is almost always the same cause: an interface designed around what EF Core can do rather than around what the application needs. `Task<IReadOnlyList<TaskItem>> FindAsync(Expression<Func<TaskItem, bool>> predicate)` is a repository that only a database can implement, because a file store cannot evaluate an arbitrary expression tree against JSON without deserialising everything.

The fix is intention-revealing methods: `ListOverdueForUserAsync(userId, ct)` can be implemented by anything. That is the real test of whether an abstraction abstracts — **can something genuinely different implement it?**
:::

::: project Restructure TaskFlow
1. Four source projects with the dependency rule enforced by MSBuild **and** by architecture tests.
2. `TaskFlow.Architecture.Tests` with at least six rules.
3. A second delivery mechanism (keep your CLI, pointed at the application layer).
4. A file-based repository selectable by configuration.
5. Domain tests running in under 200ms.
6. `DECISIONS.md`: what this structure cost you in files and lines, and what it bought. Be specific and be honest — if part of it was not worth it, say so.

Commit and tag `architecture-refactor`.
:::

::: interview What is Clean Architecture?
A way of organising an application so that source-code dependencies only point inward, toward the business rules. Entities and domain rules are at the centre and reference nothing; use cases sit around them; adapters like controllers and repositories sit outside that; frameworks and drivers are outermost.

The mechanism that makes it possible is dependency inversion: when the domain needs persistence, it defines the interface and infrastructure implements it, so the compile-time dependency points inward even though the call goes outward.

What it buys is testable business rules with no infrastructure, replaceable adapters, and boundaries a team can work across. What it costs is more projects, more types and more indirection — so it is the wrong choice for a simple CRUD service. I would also say that boundaries decay unless they are enforced, so I put them in architecture tests or the build rather than relying on discipline.
:::

::: checkpoint
- [ ] The dependency rule holds and is enforced by tests
- [ ] I added a second delivery mechanism with no duplicated logic
- [ ] I added a second repository implementation with one registration change
- [ ] My domain test suite runs in under 200ms
- [ ] I can argue when Clean Architecture is the wrong choice
:::

## Common mistakes

::: mistake
**Following the diagram without the reason.** Four projects and all the logic still in controllers.

**An "anaemic" domain.** Entities with only properties, all rules in services. You have layers without a domain.

**Interfaces for everything, reflexively.** An interface with one implementation and no test double adds indirection and nothing else.

**Boundaries by convention only.** They will be violated within a month. Enforce them.

**Applying it to a CRUD app.** Six files to add a field to a table nobody has rules about.
:::
