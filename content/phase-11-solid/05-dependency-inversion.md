---
title: Dependency Inversion
summary: Depend on abstractions — and the crucial detail about who gets to define them.
minutes: 35
---

## What are we learning?

The principle that makes the architecture of Phase 8 possible, including the part usually left out.

## The principle, both halves

> **A.** High-level modules should not depend on low-level modules. Both should depend on abstractions.
>
> **B.** Abstractions should not depend on details. Details should depend on abstractions.

Most explanations cover A and stop. **B is where the real content is**, and it implies something specific: the abstraction belongs to the **high-level** module, not the low-level one.

## The bad implementation

```csharp
// TaskFlow.Application
public sealed class TaskService
{
    private readonly EfTaskRepository _repository;        // a concrete infrastructure type
    private readonly SmtpEmailSender _email;
    private readonly RedisCache _cache;

    public TaskService()
    {
        _repository = new EfTaskRepository(new TaskFlowDbContext(...));
        _email = new SmtpEmailSender("smtp.example.com", 587);
        _cache = new RedisCache("localhost:6379");
    }
}
```

And the version that *looks* fixed but is not:

```csharp
// TaskFlow.Infrastructure — the interface lives with the implementation
namespace TaskFlow.Infrastructure.Persistence;
public interface IEfTaskRepository
{
    IQueryable<TaskItem> Query();
    Task<int> SaveChangesAsync(CancellationToken ct);
}
```

```csharp
// TaskFlow.Application
using TaskFlow.Infrastructure.Persistence;        // ← still depends on infrastructure
public sealed class TaskService(IEfTaskRepository repository) { }
```

## Why it becomes a problem

::: why The second version is the interesting failure
The first version is obviously bad: untestable, unconfigurable, compiled-in decisions.

The second has an interface and still fails, in two ways:

**1. The dependency still points outward.** `TaskFlow.Application` has a `using TaskFlow.Infrastructure`. Change infrastructure and the application recompiles. You cannot ship the application layer without the infrastructure project.

**2. The abstraction is shaped by the detail.** `IQueryable<TaskItem> Query()` and `SaveChangesAsync` are EF Core concepts. Any alternative implementation must be able to evaluate expression trees and support a unit-of-work — so a file store, an HTTP-backed store or a simple fake cannot implement it honestly. The "abstraction" is EF Core with an `I` in front.

That is precisely what part **B** forbids: the abstraction depends on the detail.
:::

## The refactor

The abstraction moves to the layer that **needs** it, and is expressed in that layer's vocabulary:

```csharp
// TaskFlow.Domain — owns the contract, expressed in domain terms
namespace TaskFlow.Domain.Repositories;

public interface ITaskRepository
{
    Task<TaskItem?> GetAsync(Guid id, CancellationToken ct = default);
    Task<IReadOnlyList<TaskItem>> ListOverdueAsync(DateOnly today, CancellationToken ct = default);
    Task AddAsync(TaskItem task, CancellationToken ct = default);
    void Remove(TaskItem task);
}
```

```csharp
// TaskFlow.Infrastructure — depends on Domain, adapts EF Core to the contract
public sealed class EfTaskRepository(TaskFlowDbContext db) : ITaskRepository { }
```

```text
BEFORE                             AFTER
Application ──▶ Infrastructure     Application ──▶ Domain ◀── Infrastructure
                                                     ▲
                                              (owns ITaskRepository)
```

The arrow from Infrastructure has been **inverted**. That is where the name comes from.

## The improved implementation

```csharp
public sealed class TaskService(
    ITaskRepository tasks,          // domain-owned contract
    INotificationService notify,    // domain-owned contract
    IUnitOfWork uow,
    TimeProvider clock)
{
    public async Task<IReadOnlyList<TaskItem>> NudgeOverdueAsync(CancellationToken ct)
    {
        var today = DateOnly.FromDateTime(clock.GetUtcNow().Date);
        var overdue = await tasks.ListOverdueAsync(today, ct);

        foreach (var task in overdue)
            await notify.OverdueAsync(task, ct);

        return overdue;
    }
}
```

Nothing here knows about EF Core, PostgreSQL, SMTP or Redis. You can:
- test it with three fakes and no I/O
- swap PostgreSQL for anything, by changing one registration
- compile and ship `TaskFlow.Application` without any infrastructure present

## Where the concrete types live

Exactly one place: the **composition root**.

```csharp
// Program.cs — the ONLY file that knows every concrete type
builder.Services.AddScoped<ITaskRepository, EfTaskRepository>();
builder.Services.AddSingleton<INotificationService, SmtpNotificationService>();
builder.Services.AddSingleton<ICache, RedisCache>();
```

::: warn "Depend on abstractions" does not mean "interface everything"
```csharp
public interface IStringFormatter { string Format(string input); }
public interface IGuidGenerator { Guid New(); }
public interface IMathHelper { int Add(int a, int b); }
```

These are indirection with no purpose. DIP is about inverting dependencies on **volatile** details — things that change for reasons outside your control, or that you need to substitute in a test:

**Abstract these:** databases, HTTP clients, file systems, message queues, email, clocks, random numbers, external services, anything with configuration.

**Do not abstract these:** `string`, `List<T>`, `Math`, `Guid.NewGuid`, your own value objects, pure functions, entities.

The test: **would you ever want a different implementation, including in a test?** `Guid.NewGuid()` — no, because a test does not usually care which Guid. `DateTime.UtcNow` — **yes**, because a test absolutely cares what time it is, which is exactly why `TimeProvider` exists.
:::

::: exercise Level 1 — Guided · Invert the dependencies
1. Find every `new` of an infrastructure type in your Application and Domain projects.
2. For each, ask: is this volatile? Would I substitute it in a test?
3. For the volatile ones, define the interface **in the layer that consumes it**, using that layer's vocabulary.
4. Implement in Infrastructure.
5. Register in the composition root.
6. Confirm the dependency direction:
   ```bash
   dotnet list src/TaskFlow.Application reference   # no Infrastructure
   dotnet list src/TaskFlow.Domain reference        # nothing
   ```
7. Confirm the abstraction is not shaped by the detail: could a file store implement it?
:::

::: challenge Level 3 · Prove the inversion
Requirements:
1. Delete the `TaskFlow.Infrastructure` project reference from the solution temporarily.
2. `TaskFlow.Domain`, `TaskFlow.Application` and all their tests must still compile and pass.
3. Write a complete alternative infrastructure — file-based storage, console notifications, in-memory cache — in a new project.
4. Point the composition root at it. The application must run with full functionality.
5. No file in Domain or Application changes.
6. Both infrastructures pass the same contract tests.

If step 2 fails, you have a leak. Find it and fix it before continuing.
:::

::: solution
The leaks that turn up in step 2, in order of frequency:

**1. An EF Core attribute or type in the domain.** `[Key]`, `[Column]`, `ValueGeneratedOnAdd`, or a navigation property typed as `ICollection<T>` specifically because EF Core needs it. Fix: move all of it to Fluent configuration in Infrastructure.

**2. `IQueryable` in an application-layer signature.** It is in `System.Linq`, so it compiles — but only something with a query provider can implement it meaningfully, so the abstraction is not honest. Fix: intention-revealing repository methods.

**3. `DbUpdateConcurrencyException` caught in the application layer.** An infrastructure exception type has leaked into a business decision. Fix: the repository catches it and rethrows a domain `ConcurrencyConflictException`.

**4. A connection string in an application-layer options class.** Configuration shaped by the storage choice. Fix: infrastructure owns its own options.

**5. `Microsoft.Extensions.Caching.Distributed` in the application layer.** A specific caching library's abstraction, not yours. Fix: define your own `ICache` with the two methods you actually use.

Number 5 is worth a second look, because the counter-argument is reasonable: `IDistributedCache` *is* an abstraction, from Microsoft, and wrapping it is another layer. The deciding question is whether its shape suits you. `IDistributedCache` deals in `byte[]` and has no notion of typed values or of "get or create", so almost everyone writes a wrapper anyway — at which point owning the interface is free.

Compare with `ILogger<T>`, which almost nobody wraps, because its shape is right, it is a de-facto standard, and every logging provider implements it. **Wrap an external abstraction when its shape does not fit your domain; use it directly when it does.** That is a judgement, and applying either rule mechanically produces bad code.
:::

::: project DIP in TaskFlow
1. Every volatile dependency behind an interface owned by the consuming layer.
2. Zero `new` of infrastructure types outside the composition root.
3. The architecture test proving the dependency direction.
4. An alternative infrastructure project, proving the inversion is real.
5. Contract tests passing against both.
6. `DECISIONS.md`: which external abstractions you wrapped, which you used directly, and why.

Commit. **Phase 11 is complete.**
:::

::: interview What is the Dependency Inversion Principle?
Two parts. High-level modules should not depend on low-level modules — both depend on abstractions. And abstractions should not depend on details; details depend on abstractions.

The second part is the one that gets skipped, and it determines *where the interface lives*. Putting `IRepository` in your infrastructure project and referencing it from the application layer is not inversion — the dependency still points outward, and the interface ends up shaped by the implementation, with `IQueryable` and `SaveChanges` on it. Real inversion means the domain or application layer defines the contract in its own vocabulary, and infrastructure implements it. Then the compile-time arrow points inward even though the call goes outward.

The practical caveat is that this applies to *volatile* dependencies — databases, HTTP, email, the clock — not to everything. An interface over `Math` or `string` is indirection with no purpose. The test is whether you would ever want a different implementation, including a test double.
:::

::: checkpoint Phase 11 complete
- [ ] Interfaces live in the layer that consumes them
- [ ] No abstraction is shaped by its implementation
- [ ] The application layer compiles with Infrastructure removed
- [ ] A second infrastructure runs the whole application
- [ ] I can state all five principles with a real example of each
:::

## Common mistakes

::: mistake
**The interface in the infrastructure project.** Not inversion; the dependency still points outward.

**An abstraction shaped by the implementation.** `IQueryable` on a repository means only an ORM can implement it.

**Interfacing everything.** `IGuidGenerator` is noise.

**`new` of a concrete service inside a service.** The composition root is the only place that should.

**Wrapping every external abstraction reflexively.** `ILogger<T>` is fine as it is.
:::
