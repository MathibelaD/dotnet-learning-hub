---
title: Composition over inheritance
summary: Why the inheritance hierarchy you are about to draw is probably wrong, and what to build instead.
minutes: 35
stage: Stage 1
---

## What are we learning?

The most repeated piece of design advice in object-oriented programming, demonstrated with code that actually breaks rather than as a slogan.

## The setup that always happens

You have tasks. Some are recurring. Some need approval. Some are assigned to a team rather than a person. Inheritance looks perfect:

```csharp
public class TaskItem { }
public class RecurringTask : TaskItem { public string Cron { get; set; } }
public class ApprovalTask  : TaskItem { public Guid ApproverId { get; set; } }
public class TeamTask      : TaskItem { public Guid TeamId { get; set; } }
```

Then the product owner asks for a **recurring task that needs approval and is assigned to a team.**

```csharp
public class RecurringApprovalTeamTask : ??? 
```

C# has single inheritance. You cannot have it. Your options are all bad:

- Duplicate the recurring logic into `ApprovalTask`.
- Push everything up into `TaskItem`, so every task carries a `Cron` it never uses.
- Build a combinatorial explosion of classes: with 3 traits you need 7 classes; with 5 you need 31.

This is not a hypothetical. It is the single most common way domain models rot.

## The composition version

```csharp
public class TaskItem
{
    private readonly List<ITaskBehaviour> _behaviours = [];

    public required string Title { get; init; }
    public IReadOnlyList<ITaskBehaviour> Behaviours => _behaviours;

    public TaskItem With(ITaskBehaviour behaviour)
    {
        _behaviours.Add(behaviour);
        return this;
    }

    public T? BehaviourOf<T>() where T : class, ITaskBehaviour =>
        _behaviours.OfType<T>().FirstOrDefault();
}

public interface ITaskBehaviour { }

public sealed record Recurrence(string Cron, DateTime? NextRun) : ITaskBehaviour;
public sealed record RequiresApproval(Guid ApproverId, bool Approved) : ITaskBehaviour;
public sealed record TeamAssignment(Guid TeamId) : ITaskBehaviour;
```

Now:

```csharp
var task = new TaskItem { Title = "Quarterly security review" }
    .With(new Recurrence("0 0 1 */3 *", null))
    .With(new RequiresApproval(ciso, Approved: false))
    .With(new TeamAssignment(platformTeam));

if (task.BehaviourOf<RequiresApproval>() is { Approved: false } approval)
    Console.WriteLine($"Blocked pending approval from {approval.ApproverId}");
```

Three traits, three types, any combination. Adding a fourth costs one type, not eight.

::: why What composition actually buys you
1. **Combinations are free.** `n` behaviours give you `2^n` combinations with `n` classes.
2. **Changes are local.** Changing recurrence logic touches one small type, not a base class every task inherits.
3. **It is testable in isolation.** `Recurrence` has no `TaskItem` in it, so you can test it alone.
4. **It can change at runtime.** An object cannot change its base class. It can gain and lose behaviours.

The cost, stated honestly: one more level of indirection, and `BehaviourOf<T>()` is a lookup rather than a field access. For a small fixed hierarchy that will genuinely never grow, plain inheritance is simpler and you should use it.
:::

## The other composition: delegation

Inheriting to get functionality is the other trap.

```csharp
// Bad: "a TaskStore IS A Dictionary"? No. It HAS one.
public class TaskStore : Dictionary<Guid, TaskItem>
{
    public void AddTask(TaskItem t) => Add(t.Id, t);
}
```

Every `Dictionary` member is now part of your public API forever: `Clear()`, the indexer that inserts silently, `Remove`, enumeration order, `Comparer`. You cannot change your storage to a database later without breaking every caller.

```csharp
// Good: hold one, expose only what you mean.
public class TaskStore : ITaskStore
{
    private readonly Dictionary<Guid, TaskItem> _tasks = [];

    public void Add(TaskItem t) => _tasks[t.Id] = t;
    public TaskItem? Get(Guid id) => _tasks.GetValueOrDefault(id);
    public IReadOnlyList<TaskItem> All() => _tasks.Values.ToList();
}
```

::: exercise Level 1 — Guided · Feel the explosion
1. Write the four inheritance classes from the top of this lesson.
2. Now add the requirement: a recurring task that needs approval. Try to implement it with inheritance. Get properly stuck — actually attempt it.
3. Count how many classes you would need for all combinations of the three traits.
4. Now implement the composition version and create that same combined task.
5. Add a fourth behaviour, `Dependency(Guid blockedBy)`, to both designs. Count the work in each.
:::

::: challenge Level 3 · Behaviours that do something
Extend the composition model so behaviours can affect whether a task may be completed.

Requirements:
- `ITaskBehaviour` gains an optional way to veto completion with a reason.
- `RequiresApproval` vetoes while `Approved` is false.
- A new `Dependency(Guid blockedBy)` vetoes while the blocking task is incomplete — which means it needs to look something up.
- `TaskItem.Complete()` asks every behaviour, and throws with **all** the reasons if any veto.
- `Recurrence` does not veto, and must not be forced to implement anything meaningless.

The interesting design question: how does `Dependency` see other tasks without `TaskItem` knowing about the store? Solve that before writing code.
:::

::: solution
```csharp
public interface ITaskBehaviour;

public interface ICompletionRule : ITaskBehaviour
{
    string? VetoReason(CompletionContext context);
}

public readonly record struct CompletionContext(TaskItem Task, ITaskStore Store);

public sealed record Recurrence(string Cron) : ITaskBehaviour;               // no rule, no ceremony

public sealed record RequiresApproval(Guid ApproverId, bool Approved) : ICompletionRule
{
    public string? VetoReason(CompletionContext _) =>
        Approved ? null : $"Awaiting approval from {ApproverId}.";
}

public sealed record Dependency(Guid BlockedBy) : ICompletionRule
{
    public string? VetoReason(CompletionContext ctx) =>
        ctx.Store.Get(BlockedBy) is { IsComplete: false } blocker
            ? $"Blocked by '{blocker.Title}'."
            : null;
}
```

```csharp
public void Complete(ITaskStore store)
{
    var reasons = _behaviours
        .OfType<ICompletionRule>()
        .Select(r => r.VetoReason(new CompletionContext(this, store)))
        .Where(r => r is not null)
        .ToList();

    if (reasons.Count > 0)
        throw new InvalidOperationException(
            $"Cannot complete '{Title}': {string.Join(" ", reasons)}");

    Status = TaskStatus.Completed;
    CompletedAt = DateTime.UtcNow;
}
```

The design answer to the interesting question: **pass the context in rather than letting the domain object hold a reference to the store.** `TaskItem` still knows nothing about storage; the caller supplies what the rules need. That keeps the domain model free of infrastructure, which is exactly the principle Phase 8 builds a whole architecture around.

Note `ITaskBehaviour` declared as `public interface ITaskBehaviour;` — an empty marker interface with no body. It is a legal and readable way to say "this is a member of a family".

Also note: `Recurrence` implements only `ITaskBehaviour` and is not dragged into implementing a `VetoReason` it does not care about. That is Interface Segregation (Phase 11), arrived at by doing the obvious thing.
:::

::: project Refactor TaskFlow to composition
Your `TaskItem` is accumulating fields. Before it gets worse:

1. Add `Domain/Behaviours/ITaskBehaviour.cs` and the `ICompletionRule` split above.
2. Implement `RequiresApproval` and `Dependency`.
3. Give `TaskItem` a private behaviour list, a `With(...)` method and `BehaviourOf<T>()`.
4. Change `Complete()` to consult the completion rules.
5. In `Program.cs`, build a small chain: task A blocks task B; try to complete B and see it refused; complete A; complete B successfully.

Commit with a message that states the reasoning, not just the change:

```bash
git commit -am "Stage 1: task behaviours by composition instead of subclassing

Subclassing TaskItem per trait cannot express combinations (recurring +
approval + team). Behaviours are independent records attached at runtime."
```

Write commit messages like that for the rest of the course. Explaining *why* in writing is the same skill an interviewer is testing.
:::

::: interview When would you choose composition over inheritance?
Inheritance couples a subclass to the base class's implementation and consumes the single inheritance slot. It works when there is a genuine, stable "is-a" relationship and a small closed set of variants.

Composition — holding collaborators and delegating to them — is the better default when variations combine (you would otherwise need a class per combination), when the behaviour may change at runtime, or when you would be inheriting purely to reuse code rather than to be substitutable.

The concrete tell: if you are about to write `class AB : A` and you can imagine wanting `AB` *and* `AC` on the same object, inheritance is already the wrong tool.
:::

::: checkpoint
- [ ] I actually attempted the inheritance version and hit the wall
- [ ] I can state how many classes `n` combinable traits need under each design
- [ ] I solved the "how does Dependency see other tasks" problem before coding it
- [ ] I can explain the cost of composition, not just the benefit
- [ ] TaskFlow uses behaviours, and my commit message explains why
:::

## Common mistakes

::: mistake
**Inheriting from a collection type.** `class Basket : List<Item>` leaks the entire `List` API into your domain and locks your storage choice in forever.

**Treating "favour composition" as "never inherit".** Abstract base classes with a template method are good design. A three-member closed hierarchy is fine. The advice is about *reflexive* inheritance, particularly inheritance for code reuse.

**Building a behaviour/plugin system for two variants that will never grow.** Composition has real indirection cost. If you genuinely have two cases and always will, write two classes.

**Making the marker interface do too much.** The moment every behaviour must implement six methods it does not care about, split the interface.
:::
