---
title: Repositories and Unit of Work
summary: The most argued-about pattern in .NET — what it is for, and why EF Core changes the answer.
minutes: 40
---

## What are we learning?

The Repository and Unit of Work patterns, and a genuine assessment of whether you should use them on top of EF Core. This lesson deliberately argues both sides, because the right answer depends on things only you know about your project.

## What they are

**Repository**: a collection-like abstraction over persistence.

```csharp
public interface ITaskRepository
{
    Task<TaskItem?> GetAsync(Guid id, CancellationToken ct = default);
    Task<IReadOnlyList<TaskItem>> ListByProjectAsync(Guid projectId, CancellationToken ct = default);
    Task AddAsync(TaskItem task, CancellationToken ct = default);
    void Remove(TaskItem task);
}
```

**Unit of Work**: a transaction boundary spanning several repositories.

```csharp
public interface IUnitOfWork
{
    ITaskRepository Tasks { get; }
    IProjectRepository Projects { get; }
    Task<int> SaveChangesAsync(CancellationToken ct = default);
}
```

## The uncomfortable fact

::: warn `DbContext` is already both of these
`DbSet<T>` **is** a repository: a queryable collection of entities with add and remove.

`DbContext` **is** a unit of work: it tracks changes across multiple entity types and commits them in one transaction with `SaveChanges`.

So wrapping EF Core in a repository and a unit of work is, quite literally, wrapping a repository in a repository. That is why the argument exists.
:::

## The case for a repository over EF Core

**1. It keeps `IQueryable` out of your application layer.** This is the strongest argument. Without a repository, services write EF Core queries, and now your business logic knows about `Include`, `AsNoTracking`, translation limits and context lifetimes. With a repository, the application layer asks for *what* it needs and infrastructure decides *how*.

**2. Query logic gets a name and one home.**
```csharp
await tasks.ListOverdueForUserAsync(userId, ct);
// instead of, in three different services:
await db.Tasks.Where(t => t.AssigneeId == userId && t.DueDate < today
                          && t.Status != TaskStatus.Completed)
               .AsNoTracking().ToListAsync(ct);
```
The second version will be written slightly differently in each place, and one of them will forget the status check.

**3. You can test the application layer without a database.** A fake repository is a `Dictionary`. Against raw `DbContext` you need the in-memory provider (which behaves differently from PostgreSQL) or a container.

**4. The domain can define the interface.** `ITaskRepository` lives in the domain; `EfTaskRepository` lives in infrastructure. That is dependency inversion, and it is what keeps the domain free of EF Core.

## The case against

**1. It hides EF Core's capabilities.** Projection, `Include`, split queries, `ExecuteUpdate` — a repository returning `IReadOnlyList<TaskItem>` cannot express "project these four columns", so you either load whole entities everywhere (slow) or add a repository method per projection (endless).

**2. Method explosion.** `GetByIdAsync`, `GetByIdWithCommentsAsync`, `GetByIdWithCommentsAndProjectAsync`, `ListByProjectPagedSortedAsync`… Each new query shape is a new method. Real repositories reach forty methods.

**3. `IQueryable` in, `IQueryable` out defeats the purpose.** The common "fix" for (1) is `IQueryable<T> Query()`, which leaks EF Core straight back into the caller — with the added risk of enumerating after disposal.

**4. EF Core is already a portability layer.** "We might switch database" is the usual justification, and it almost never happens; when it does, the SQL dialect differences EF Core does *not* hide are the actual problem, not the query syntax.

::: design So what should you actually do?
Three defensible positions:

**A — No repository. Inject `DbContext` into application services.**
Simplest. Full access to EF Core. Testing needs a real database (Testcontainers, Phase 10), which is slower but tests what actually runs. Good for small services and teams comfortable with EF Core.

**B — Repositories for writes, projections for reads.** *(This is what TaskFlow uses.)*
Write paths load aggregates through a repository so domain rules run and the unit of work is clear. Read paths bypass it entirely with a query service that projects straight to DTOs.
```csharp
public interface ITaskRepository                 // writes: whole aggregates
{
    Task<TaskItem?> GetAsync(Guid id, CancellationToken ct);
    Task AddAsync(TaskItem task, CancellationToken ct);
}

public interface ITaskQueries                     // reads: DTOs, optimised
{
    Task<Page<TaskSummaryResponse>> SearchAsync(TaskQuery query, CancellationToken ct);
    Task<TaskResponse?> GetDetailAsync(Guid id, CancellationToken ct);
}
```
This is CQRS in its mildest form — separate the read model from the write model — and it dissolves the strongest argument against repositories, because the read side was where all the pain was.

**C — Full repository and unit of work over everything.**
Most ceremony. Justified when you have several persistence mechanisms, a genuinely database-agnostic product, or a team standard you are not in a position to change.

**Pick B unless something specific pushes you elsewhere.** And be able to explain why — this exact question comes up in interviews constantly, and "because Clean Architecture says so" is the answer that marks someone who has not thought about it.
:::

## Do you need an explicit Unit of Work?

With EF Core: usually no. Inject the `DbContext` (or a thin `IUnitOfWork` wrapping only `SaveChangesAsync`) into the application service and call save once at the end of the use case.

```csharp
public sealed class TaskService(ITaskRepository tasks, IProjectRepository projects, IUnitOfWork uow)
{
    public async Task<TaskItem> CreateAsync(CreateTaskCommand cmd, CancellationToken ct)
    {
        var project = await projects.GetAsync(cmd.ProjectId, ct) ?? throw new ProjectNotFoundException();
        var task = project.AddTask(cmd.Title, cmd.Priority, clock);
        await tasks.AddAsync(task, ct);
        await uow.SaveChangesAsync(ct);          // ONE transaction, both repositories
        return task;
    }
}
```

The value of the explicit `IUnitOfWork` here is not technical — both repositories already share a context. It is that the code **says** where the transaction boundary is, which matters when someone later adds a third repository call.

::: exercise Level 1 — Guided · Implement option B
1. Define `ITaskRepository` and `IProjectRepository` in `TaskFlow.Domain` — interfaces only, no EF Core.
2. Implement them in `TaskFlow.Infrastructure` with `DbContext`.
3. Define `ITaskQueries` in `TaskFlow.Application`, returning **DTOs**.
4. Implement it in Infrastructure with projections.
5. Rewrite your write endpoints to use the repository; rewrite your read endpoints to use the query service.
6. Add `IUnitOfWork` with only `SaveChangesAsync`, implemented by the context.
7. Confirm no `DbContext`, `IQueryable` or `Include` appears in Application or Domain.
:::

::: challenge Level 3 · A fake repository that is actually useful
Write `InMemoryTaskRepository` implementing `ITaskRepository`, for tests.

Requirements:
1. Behaviourally equivalent to the EF Core one for every method.
2. Deterministic ordering that matches the SQL one's `ORDER BY`.
3. Case-insensitive matching matching the `ILIKE` behaviour.
4. A `SaveChangesAsync` that can be made to fail on demand, so you can test error paths.
5. A **contract test suite** run against both implementations, so divergence is caught.
6. Document every behaviour you could not faithfully reproduce.

Point 5 is the important one. A fake that drifts from the real thing is worse than no fake.
:::

::: solution
The contract test suite is the technique worth learning:

```csharp
public abstract class TaskRepositoryContract
{
    protected abstract Task<ITaskRepository> CreateAsync();

    [Fact]
    public async Task Get_returns_null_for_a_missing_id()
    {
        var repo = await CreateAsync();
        Assert.Null(await repo.GetAsync(Guid.NewGuid(), default));
    }

    [Fact]
    public async Task List_by_project_is_ordered_newest_first()
    {
        var repo = await CreateAsync();
        // ... add three tasks with known timestamps
        var result = await repo.ListByProjectAsync(projectId, default);
        Assert.Equal(["third", "second", "first"], result.Select(t => t.Title));
    }
}

public sealed class InMemoryTaskRepositoryTests : TaskRepositoryContract
{
    protected override Task<ITaskRepository> CreateAsync() =>
        Task.FromResult<ITaskRepository>(new InMemoryTaskRepository());
}

public sealed class EfTaskRepositoryTests : TaskRepositoryContract, IAsyncLifetime
{
    // spins up PostgreSQL via Testcontainers (Phase 10)
    protected override async Task<ITaskRepository> CreateAsync() => new EfTaskRepository(await NewContextAsync());
}
```

One set of assertions, two implementations. Add a test to the base class and both are checked. This is how you keep a test double honest, and it generalises to any interface with more than one implementation.

**Behaviours you cannot faithfully reproduce** — and these belong in the documentation:

- **Concurrency.** The in-memory version has no `xmin`, so `DbUpdateConcurrencyException` cannot occur. Concurrency tests must run against the real database.
- **Collation.** `OrdinalIgnoreCase` and PostgreSQL's `ILIKE` differ for non-ASCII text.
- **Constraint violations.** Foreign keys, unique indexes and check constraints only exist in the database. A test asserting "duplicate email is rejected" only means something against PostgreSQL.
- **Transaction semantics.** In-memory `SaveChanges` cannot partially fail.

The conclusion that follows: **fakes for the fast majority of tests, the real database for anything about persistence semantics.** That split is exactly what Phase 10 builds.
:::

::: project Restructure TaskFlow's data access
1. `ITaskRepository` / `IProjectRepository` / `IUserRepository` in Domain.
2. EF Core implementations in Infrastructure.
3. `ITaskQueries` in Application, projections in Infrastructure.
4. `IUnitOfWork` with only `SaveChangesAsync`.
5. Write endpoints through repositories, read endpoints through queries.
6. `InMemoryTaskRepository` plus the contract test suite.
7. `DECISIONS.md`: which option (A, B or C) you chose, with your reasoning and the arguments against.

Commit.
:::

::: interview Should you use the Repository pattern with EF Core?
It depends, and the honest starting point is that `DbSet<T>` is already a repository and `DbContext` is already a unit of work — so adding both on top is wrapping an abstraction in the same abstraction.

The genuine argument in favour is keeping `IQueryable` out of the application layer, giving query logic one named home, and letting the domain define the interface so infrastructure depends inward. The argument against is that a repository hides EF Core's best features — projection, split queries, `ExecuteUpdate` — and tends to grow a method per query shape.

What I would do, and have done, is split by direction: repositories for writes, where you load whole aggregates so domain rules run and the transaction boundary is explicit; and a separate query service for reads that projects straight into DTOs. That keeps the write side clean and lets the read side use everything EF Core offers. It is CQRS in its lightest form.
:::

::: checkpoint
- [ ] I can argue both for and against repositories over EF Core
- [ ] I chose an option deliberately and wrote down why
- [ ] No `IQueryable` crosses a layer boundary in my code
- [ ] I built a contract test suite run against two implementations
- [ ] I documented what my fake cannot faithfully reproduce
:::

## Common mistakes

::: mistake
**A generic `IRepository<T>` with `GetAll()`.** It either loads the whole table or leaks `IQueryable`. Repositories should expose the queries your application actually needs.

**Returning `IQueryable<T>` from a repository.** You have added a layer and kept every coupling it was meant to remove.

**A unit of work that wraps a single repository.** Nothing to coordinate.

**Repositories that duplicate EF Core one-to-one.** `AddAsync`, `UpdateAsync`, `DeleteAsync`, `GetByIdAsync` and nothing else is pure ceremony.

**A fake that drifts from the real implementation.** Green tests, broken production. Contract tests.
:::
