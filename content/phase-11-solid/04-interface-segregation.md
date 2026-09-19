---
title: Interface Segregation
summary: No client should depend on methods it does not use — and the fat interface that makes testing painful.
minutes: 30
---

## What are we learning?

Why big interfaces hurt, measured in the concrete cost they impose on implementers and testers.

## The bad implementation

```csharp
public interface ITaskService
{
    Task<TaskItem?> GetAsync(Guid id, CancellationToken ct);
    Task<Page<TaskSummary>> SearchAsync(TaskQuery query, CancellationToken ct);
    Task<TaskItem> CreateAsync(CreateTaskCommand command, CancellationToken ct);
    Task<TaskItem> UpdateAsync(Guid id, UpdateTaskCommand command, CancellationToken ct);
    Task<TaskItem> CompleteAsync(Guid id, CancellationToken ct);
    Task<TaskItem> AssignAsync(Guid id, Guid userId, CancellationToken ct);
    Task DeleteAsync(Guid id, CancellationToken ct);
    Task<byte[]> ExportAsync(TaskQuery query, string format, CancellationToken ct);
    Task<ImportResult> ImportAsync(Stream data, CancellationToken ct);
    Task<TaskStatistics> GetStatisticsAsync(Guid projectId, CancellationToken ct);
    Task<IReadOnlyList<Comment>> GetCommentsAsync(Guid id, CancellationToken ct);
    Task<Comment> AddCommentAsync(Guid id, string body, CancellationToken ct);
    Task AddLabelAsync(Guid id, string label, CancellationToken ct);
    Task RemoveLabelAsync(Guid id, string label, CancellationToken ct);
    Task<IReadOnlyList<TaskItem>> GetBlockersAsync(Guid id, CancellationToken ct);
    Task ArchiveOldAsync(DateOnly before, CancellationToken ct);
}
```

Sixteen methods. Every consumer takes a dependency on all sixteen.

## Why it becomes a problem

::: why The costs are concrete
**1. Test setup explodes.** A component that only needs `GetAsync` must still substitute a sixteen-method interface. With a hand-written fake, that is sixteen `NotImplementedException` stubs — and every new method added to the interface breaks every fake in the codebase.

**2. Coupling that is invisible.** A reporting component that only reads now recompiles when the import signature changes. In a large solution, this is measured in build times.

**3. It hides what a component actually needs.** `TasksController(ITaskService service)` tells you nothing. `ExportController(ITaskReader reader, ITaskExporter exporter)` tells you exactly what it touches.

**4. It encourages the god-class.** An interface with sixteen methods gets an implementation with sixteen methods, which has every dependency the union of those methods needs. That class now violates SRP by construction.

**5. Substitutability suffers.** The more an interface promises, the harder it is for an alternative implementation to honestly provide it all — which is the LSP problem from the previous lesson.
:::

## The refactor

Split by **client need**, not by entity:

```csharp
// read
public interface ITaskReader
{
    Task<TaskItem?> GetAsync(Guid id, CancellationToken ct = default);
    Task<Page<TaskSummary>> SearchAsync(TaskQuery query, CancellationToken ct = default);
}

// write
public interface ITaskWriter
{
    Task<TaskItem> CreateAsync(CreateTaskCommand command, CancellationToken ct = default);
    Task<TaskItem> UpdateAsync(Guid id, UpdateTaskCommand command, CancellationToken ct = default);
    Task DeleteAsync(Guid id, CancellationToken ct = default);
}

// state transitions — a different actor and a different set of rules
public interface ITaskWorkflow
{
    Task<TaskItem> StartAsync(Guid id, CancellationToken ct = default);
    Task<TaskItem> CompleteAsync(Guid id, CancellationToken ct = default);
    Task<TaskItem> AssignAsync(Guid id, Guid userId, CancellationToken ct = default);
}

// bulk operations — used only by the import/export endpoints and a background job
public interface ITaskBulkOperations
{
    Task<ImportResult> ImportAsync(Stream data, CancellationToken ct = default);
    Task ArchiveOldAsync(DateOnly before, CancellationToken ct = default);
}

// reporting — read-only, different shape
public interface ITaskStatistics
{
    Task<TaskStatistics> GetAsync(Guid projectId, CancellationToken ct = default);
}
```

One class may still implement several of these:

```csharp
public sealed class TaskService : ITaskReader, ITaskWriter, ITaskWorkflow { }
```

**Segregating the interface does not require segregating the implementation.** That is the point people miss: the split is for the *consumers*.

## The improved implementation

```csharp
// before
public sealed class ExportController(ITaskService service) { }          // depends on 16 methods

// after
public sealed class ExportController(ITaskReader reader, ITaskExporter exporter) { }
```

The constructor is now documentation. A test substitutes two small interfaces. Adding a bulk-import method cannot affect the export controller at all.

::: note This is also why `IReadOnlyList<T>` exists
The BCL is full of segregated interfaces:

```text
IEnumerable<T>          iterate
ICollection<T>          + count, add, remove
IList<T>                + indexing, insert
IReadOnlyCollection<T>  count, no mutation
IReadOnlyList<T>        + indexing, no mutation
```

A method taking `IEnumerable<T>` cannot accidentally mutate your collection, and can accept a lazy sequence. That is ISP in the standard library, and it is why Phase 1 told you to accept the weakest interface you need.
:::

::: warn Do not shred interfaces into one method each
Taken too far you get `ITaskGetter`, `ITaskSearcher`, `ITaskCreator`, `ITaskUpdater`, `ITaskDeleter` — and a controller with seven constructor parameters, none of which tells you more than three would have.

The unit of segregation is a **role**, not a method. `ITaskReader` is a role: "something that can find tasks for me". `ITaskGetter` is a method with an interface wrapped around it.

The test: would a consumer plausibly need exactly these members and no others? If yes, it is a role. If no, you have split too far.
:::

::: exercise Level 1 — Guided · Segregate
1. Find your largest interface in TaskFlow.
2. For each consumer, list which members it actually calls.
3. Group the members by which consumers use them — that grouping *is* the segregation.
4. Split accordingly.
5. Update consumers to depend only on what they need.
6. Compare the test setup for one consumer before and after — count the lines.
7. Confirm one class can still implement several of the new interfaces.
:::

::: challenge Level 3 · Consumer-driven interfaces
Take it further: let each consumer **declare** the interface it needs, rather than choosing from what exists.

Requirements:
1. For three consumers, define the interface from the consumer's side — name it after the consumer's need, not the entity.
2. Place those interfaces in the consumer's project, not the provider's.
3. The provider implements them.
4. Show that this inverts the dependency: the provider now depends on the consumer's contract.
5. Argue whether it is worth it for TaskFlow, and where it clearly would not be.
:::

::: solution
```csharp
// in TaskFlow.Api, next to the controller that needs it
namespace TaskFlow.Api.Export;

public interface IExportableTaskSource
{
    Task<IReadOnlyList<TaskItem>> GetForExportAsync(TaskQuery query, CancellationToken ct);
}
```

```csharp
// in TaskFlow.Infrastructure
public sealed class EfTaskRepository : ITaskRepository, IExportableTaskSource { }
```

The dependency now points from Infrastructure **to** the API's contract — the consumer owns the interface and the provider adapts to it. This is the full form of the Dependency Inversion Principle (next lesson), and it is what "ports and adapters" means: the port is defined by the thing that needs it.

**When it is worth it:** across a genuine module boundary, especially where the provider is shared by several consumers with different needs, or where the consumer is the more stable side. It makes the consumer's requirements explicit and prevents the provider's interface from becoming the union of everyone's wishes.

**When it is not:** within one cohesive application where the same team owns both sides. You end up with `IExportableTaskSource`, `IReportableTaskSource`, `INotifiableTaskSource` — five nearly identical interfaces over one repository, and a reader now has to check which one a given class implements.

**For TaskFlow: not worth it.** Role interfaces in the domain (`ITaskReader`, `ITaskWriter`) give most of the benefit at a fraction of the cost. Say that out loud rather than applying the pattern because it appears in a book — recognising when a principle does not pay is the more advanced skill.
:::

::: project ISP in TaskFlow
1. Split every interface with more than about six members into roles.
2. Every consumer depends only on what it uses.
3. Implementations may still be combined — confirm at least one class implements several roles.
4. Method parameters and return types use the weakest sufficient interface.
5. Measure: pick a consumer and record its test setup line count before and after.
6. `DECISIONS.md`: where you stopped splitting, and why.

Commit.
:::

::: interview What is the Interface Segregation Principle?
No client should be forced to depend on methods it does not use. In practice it means preferring several small role-based interfaces over one large one.

The costs of a fat interface are concrete: every consumer recompiles when any member changes; every test double must stub every method, so adding a method breaks every fake; and the constructor stops telling you what a class actually needs. It also tends to produce a god implementation, because one class ends up owning every dependency the union of those methods requires.

The refactor is to group members by which consumers use them, and split along that boundary. Importantly, segregating the interface does not mean segregating the implementation — one class can implement several role interfaces.

The limit is that the unit of segregation should be a role, not a method. An interface per method gives you constructors with seven parameters and no additional clarity.
:::

::: checkpoint
- [ ] My largest interface is split by consumer need
- [ ] Every constructor tells me what that class touches
- [ ] Test setup for a consumer got measurably smaller
- [ ] One implementation still covers several roles
- [ ] I can say where further splitting would stop paying
:::

## Common mistakes

::: mistake
**One interface per entity.** `ITaskService` with sixteen methods, because there is one `TaskItem`.

**One interface per method.** Constructors with seven parameters.

**Splitting the implementation because you split the interface.** Unnecessary.

**`IList<T>` in a signature that only iterates.** Ask for `IEnumerable<T>`.

**Adding a method to a shared interface "while you are there".** Every implementer and every fake now has to change.
:::
