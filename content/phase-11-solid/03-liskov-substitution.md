---
title: Liskov Substitution
summary: A subtype that surprises you is a subtype that breaks callers — the principle behind "is-a" actually meaning something.
minutes: 35
---

## What are we learning?

The most formal of the five, stated usefully: **anywhere the base type works, every derived type must work too, without the caller knowing the difference.**

## The bad implementation

```csharp
public class TaskRepository
{
    public virtual async Task<TaskItem?> GetAsync(Guid id, CancellationToken ct)
    {
        return await _db.Tasks.FirstOrDefaultAsync(t => t.Id == id, ct);
    }

    public virtual async Task AddAsync(TaskItem task, CancellationToken ct)
    {
        _db.Tasks.Add(task);
        await _db.SaveChangesAsync(ct);
    }

    public virtual async Task RemoveAsync(Guid id, CancellationToken ct) { ... }
}

public sealed class ReadOnlyTaskRepository : TaskRepository
{
    public override Task AddAsync(TaskItem task, CancellationToken ct) =>
        throw new NotSupportedException("This repository is read-only.");

    public override Task RemoveAsync(Guid id, CancellationToken ct) =>
        throw new NotSupportedException("This repository is read-only.");
}
```

And a subtler one:

```csharp
public class TaskItem
{
    public virtual void Complete() { Status = TaskStatus.Completed; }
}

public sealed class RecurringTaskItem : TaskItem
{
    public override void Complete()
    {
        Status = TaskStatus.Todo;             // ← "completing" it resets it
        DueDate = NextOccurrence();
    }
}
```

## Why it becomes a problem

::: why Substitution failures are silent until they are not
The read-only repository breaks every caller written against `TaskRepository`:

```csharp
async Task Import(TaskRepository repository, IEnumerable<TaskItem> tasks)
{
    foreach (var t in tasks) await repository.AddAsync(t, ct);    // throws for one subtype
}
```

The caller did everything right. The type says `AddAsync` is available. The subtype removed a capability the contract promised, so callers must now know which concrete type they have — which defeats the entire point of the abstraction.

`RecurringTaskItem` is worse because it fails **without** an exception:

```csharp
foreach (var task in overdueTasks)
{
    task.Complete();
    completedCount++;                       // counts tasks that are now Todo
}
report.Completed = completedCount;          // wrong, silently
```

Nothing throws. The number is just wrong, and the bug is in a report nobody checks closely.

**The four rules a subtype must not break:**
1. **Preconditions may not be strengthened.** A subtype may not demand more of its inputs than the base does.
2. **Postconditions may not be weakened.** It must deliver at least what the base promises.
3. **Invariants must be preserved.** Anything true of the base must remain true.
4. **No new exceptions** that callers of the base would not expect.

`ReadOnlyTaskRepository` breaks 4. `RecurringTaskItem` breaks 2.
:::

## The refactor

**For the repository — split the interface** so that "read-only" is expressible as a type, not as a broken promise:

```csharp
public interface ITaskReader
{
    Task<TaskItem?> GetAsync(Guid id, CancellationToken ct = default);
    Task<IReadOnlyList<TaskItem>> ListByProjectAsync(Guid projectId, CancellationToken ct = default);
}

public interface ITaskWriter
{
    Task AddAsync(TaskItem task, CancellationToken ct = default);
    Task RemoveAsync(Guid id, CancellationToken ct = default);
}

public interface ITaskRepository : ITaskReader, ITaskWriter;
```

Now a read-only implementation implements `ITaskReader` and nothing lies. A method that only reads asks for `ITaskReader`, and the compiler enforces it. (This is Interface Segregation, the next lesson — the principles overlap constantly.)

**For the recurring task — do not override the meaning of a method:**

```csharp
public sealed class TaskItem
{
    public Recurrence? Recurrence { get; private set; }

    public TaskItem? Complete(TimeProvider clock)
    {
        if (Status is TaskStatus.Completed) throw new TaskStateException(this, "complete");

        Status = TaskStatus.Completed;
        CompletedAt = clock.GetUtcNow();

        // A recurring task produces a SUCCESSOR. It does not un-complete itself.
        return Recurrence?.CreateNext(this, clock);
    }
}
```

`Complete` now always means "this task is complete". A recurring task additionally produces a new task — which is honest about what is happening and is what the business actually meant.

## The improved implementation

```csharp
var next = task.Complete(clock);
if (next is not null) await tasks.AddAsync(next, ct);

completedCount++;                     // now always correct
```

The caller's count is right for every kind of task. There is no subtype to know about. The recurring behaviour is composition (Phase 1) rather than inheritance.

::: warn The classic example, and why it is actually about mutation
Square-is-a-Rectangle is the textbook case:

```csharp
public class Rectangle { public virtual int Width { get; set; } public virtual int Height { get; set; } }
public class Square : Rectangle
{
    public override int Width { set { base.Width = base.Height = value; } }
    public override int Height { set { base.Width = base.Height = value; } }
}

void Resize(Rectangle r) { r.Width = 5; r.Height = 4; Debug.Assert(r.Width * r.Height == 20); }
Resize(new Square());      // 16 — assertion fails
```

Mathematically a square *is* a rectangle. The violation only exists because the type is **mutable** with independent setters.

Make it immutable and the problem disappears: an immutable `Square` with `Width == Height` substitutes perfectly for an immutable `Rectangle`, because there is no way to set one dimension independently.

That is a general and useful observation: **most LSP violations are about mutation.** Immutable types are much harder to make unsubstitutable — which is one more argument for the `record` and `init` habits from Phase 1.
:::

::: exercise Level 1 — Guided · Find the violations
For each, decide whether it violates LSP, and why:

1. `SqlTaskRepository.GetAsync` returns null for a missing id; `CachedTaskRepository.GetAsync` throws.
2. `EmailNotifier.SendAsync` is async; `ConsoleNotifier.SendAsync` blocks for 5 seconds.
3. `List<T>.Add` appends; a `CappedList<T>.Add` silently ignores items past a limit.
4. A base validator accepts any string; a derived one rejects strings over 100 characters.
5. `FileStore.SaveAsync` is atomic; `S3Store.SaveAsync` is eventually consistent.
6. `TaskItem.Complete()` throws when already complete; `DraftTask.Complete()` does nothing.

Then fix the ones that violate it.
:::

::: solution
1. **Violates.** A new exception the base's callers do not expect (rule 4). Fix: return null, or make "throws when missing" part of the base contract and have both do it.
2. **Violates in spirit.** The signature says async, implying non-blocking; a caller doing `await Task.WhenAll(notifiers.Select(n => n.SendAsync(...)))` expects concurrency and gets serialisation. Performance characteristics are part of a contract even though the type system cannot express them.
3. **Violates.** Weakened postcondition (rule 2): `Add` promises the item is in the collection afterwards. Silently dropping is the worst option — throwing would at least be visible. Fix: `bool TryAdd`, which is honest in the signature.
4. **Violates.** Strengthened precondition (rule 1). Code written against the base passes a 150-character string legitimately and the derived type rejects it.
5. **Violates, and this one is real and common.** Code that saves then immediately reads back works on files and intermittently fails on S3. The fix is to make the base contract eventually consistent — the weakest guarantee any implementation provides — so callers cannot rely on something that is not universally true.
6. **Violates.** Different postcondition for the same call. Fix: if a draft cannot be completed, do not give it a `Complete` that silently succeeds. Either throw (same contract) or model drafts as a different type that has no `Complete`.

Number 5 is the one worth dwelling on: **an abstraction's contract is the intersection of what its implementations guarantee, not the union.** Documenting the strongest implementation's behaviour and letting callers depend on it is how you get bugs that only appear in production, where the other implementation is used.
:::

::: challenge Level 3 · A substitutable storage abstraction
Design `ITaskStore` so that **every** implementation can honestly satisfy it: in-memory, EF Core/PostgreSQL, a file store, and a hypothetical eventually-consistent cloud store.

Requirements:
1. Write the contract as documented pre/post-conditions before any code.
2. Every guarantee must be one that all four can provide.
3. Where they genuinely differ — ordering, consistency, transactionality — the difference is in the type system or explicitly documented, never assumed.
4. A contract test suite passing against all four.
5. A caller written against the interface works with all four, unchanged.
6. Document what you had to give up to make the abstraction honest.

Point 6 is the real deliverable.
:::

::: solution
The contract, written first:

```csharp
/// <summary>
/// Stores tasks.
///
/// GUARANTEES (all implementations):
///  - GetAsync returns null for an id that was never added, or was removed.
///  - After AddAsync completes, GetAsync for that id returns the task
///    WITHIN THE SAME LOGICAL SESSION. Cross-session visibility is not guaranteed.
///  - ListAsync returns tasks in an unspecified order unless an ordering is requested.
///  - Concurrent AddAsync for the same id: last writer wins, unless a
///    concurrency token is supplied, in which case one fails.
///
/// NOT GUARANTEED:
///  - Atomicity across multiple operations. Use IUnitOfWork.
///  - Immediate visibility to other sessions.
///  - Stable ordering without an explicit sort.
/// </summary>
```

**What you give up to make it honest:**

1. **Ordering.** The in-memory `Dictionary` and a SQL query without `ORDER BY` both return "some order". Promising insertion order would be a lie for one of them, so ordering must be requested explicitly — which is also the right API.

2. **Immediate cross-session read-after-write.** An eventually-consistent store cannot promise it. So the contract promises it only within a session, and anything needing more must say so.

3. **Multi-operation atomicity.** A file store cannot give it. So it moves to `IUnitOfWork`, which only some implementations support — and that is visible in the type, not hidden.

4. **Query richness.** `FindAsync(Expression<Func<TaskItem, bool>>)` is implementable only by something that can evaluate expression trees against storage. Honest abstractions use intention-revealing methods: `ListOverdueAsync`, `ListByLabelAsync`.

**The conclusion, and it is the point of the lesson:** an honest abstraction over genuinely different implementations is **weaker** than any single implementation. That weakness is the price of substitutability.

Which raises the right question: is the abstraction worth it? If you will only ever use PostgreSQL, then an interface that hides PostgreSQL's transactions and ordering has cost you real capability for a portability you will never use. That is a legitimate reason **not** to abstract — and being able to make that argument is more valuable than reciting the principle.
:::

::: project LSP in TaskFlow
1. Split `ITaskRepository` into reader and writer interfaces.
2. Audit every interface: can each implementation honestly satisfy every member?
3. Fix any implementation that throws `NotSupportedException` — that is always an LSP violation.
4. Make recurrence a composition, not a subtype override.
5. Document the contract of `ITaskStore`/`ITaskRepository` as pre/post-conditions in XML comments.
6. Run the contract test suite against every implementation.
7. `DECISIONS.md`: what your abstraction gives up, and whether it is worth it.

Commit.
:::

::: interview What is the Liskov Substitution Principle?
Any place that works with a base type must keep working when given a derived type, without knowing the difference. Concretely, a subtype may not strengthen preconditions, weaken postconditions, break invariants, or throw exceptions the base's callers would not expect.

The classic smell is an override that throws `NotSupportedException` — a read-only collection deriving from a mutable one. The type promises a capability the subtype removes, so callers have to know which concrete type they hold, which defeats the abstraction. The fix is usually interface segregation: make the smaller capability its own interface rather than a broken implementation of a larger one.

The subtler violations are silent. An override that changes what a method *means* — "complete" resetting a recurring task to to-do — produces no exception and just makes the caller's logic wrong.

Worth noting: most LSP violations are enabled by mutation. The square-rectangle example only breaks because the dimensions have independent setters; immutable types are much harder to make unsubstitutable.
:::

::: checkpoint
- [ ] I can state the four rules a subtype must not break
- [ ] I identified the violations in all six scenarios
- [ ] No implementation of my interfaces throws `NotSupportedException`
- [ ] My abstraction's contract is documented as pre/post-conditions
- [ ] I can explain why an honest abstraction is weaker than any one implementation
:::

## Common mistakes

::: mistake
**`NotSupportedException` in an override.** The clearest possible violation.

**An override that changes the meaning of the method.** Silent wrong behaviour.

**Documenting the strongest implementation's guarantees as the contract.** Works in development, fails with the other implementation.

**Ignoring performance as part of the contract.** A "async" method that blocks breaks callers' concurrency assumptions.

**Inheriting to reuse code rather than to be substitutable.** Composition.
:::
