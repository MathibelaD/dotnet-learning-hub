---
title: Single Responsibility
summary: "One reason to change" — what that actually means, and the class that always violates it.
minutes: 35
---

## What are we learning?

The most quoted and least understood of the five. It is not "a class should do one thing".

## The principle, stated properly

> A class should have **one reason to change** — one *actor* it answers to.

"One thing" is uselessly vague; every class does one thing at some level of description. The useful formulation is about **who asks for changes**. If the finance team and the operations team can both cause a change to the same class, that class has two responsibilities.

## The bad implementation

```csharp
public sealed class TaskService(TaskFlowDbContext db, IConfiguration config)
{
    public async Task<TaskItem> CompleteAsync(Guid id, CancellationToken ct)
    {
        var task = await db.Tasks.FirstOrDefaultAsync(t => t.Id == id, ct)
                   ?? throw new TaskNotFoundException(id);

        if (task.Status is TaskStatus.Completed)
            throw new InvalidOperationException("Already complete");

        task.Status = TaskStatus.Completed;
        task.CompletedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);

        // send an email
        using var smtp = new SmtpClient(config["Smtp:Host"]);
        await smtp.SendMailAsync(new MailMessage(
            "noreply@taskflow.example", task.AssigneeEmail,
            $"Task complete: {task.Title}",
            $"<h1>{task.Title}</h1><p>Completed at {task.CompletedAt:g}</p>"));

        // write an audit line
        await File.AppendAllTextAsync("audit.log",
            $"{DateTime.UtcNow:O}\tCOMPLETE\t{id}\n", ct);

        // update the dashboard cache
        var stats = await db.Tasks.Where(t => t.ProjectId == task.ProjectId)
            .GroupBy(t => t.Status).ToDictionaryAsync(g => g.Key, g => g.Count(), ct);
        MemoryCache.Default.Set($"stats:{task.ProjectId}", stats, DateTimeOffset.UtcNow.AddMinutes(5));

        // post to Slack
        using var http = new HttpClient();
        await http.PostAsJsonAsync(config["Slack:Webhook"],
            new { text = $"✅ {task.Title}" }, ct);

        return task;
    }
}
```

## Why it becomes a problem

::: why Count the actors
This method changes when **any** of these people ask for something:

| Actor | What they change |
|---|---|
| Product | the completion rules |
| Marketing | the email wording or HTML |
| Compliance | the audit format or retention |
| Platform | the caching strategy |
| Ops | the Slack message or the webhook |
| DBA | the query |

Six reasons to change. Concretely, that means:

1. **Every change risks every other concern.** A marketing tweak to the email template is a deployment that could break task completion.
2. **It cannot be tested.** Testing "a completed task cannot be completed twice" requires an SMTP server, a writable file system, a cache and a Slack endpoint.
3. **Merge conflicts.** Six teams editing one method.
4. **The business rule is invisible.** Three lines of rule buried in thirty lines of plumbing.
5. **Failure modes are entangled.** Slack being down fails the completion — after the database has already been written. The task is complete and the caller got an exception.
6. **It only grows.** Nobody deletes from a method like this; they append.
:::

## The refactor

Separate by actor:

```csharp
// DOMAIN — changes when the business rules change (Product)
public sealed class TaskItem
{
    public void Complete(TimeProvider clock)
    {
        if (Status is TaskStatus.Completed)
            throw new TaskStateException(this, "complete");

        Status = TaskStatus.Completed;
        CompletedAt = clock.GetUtcNow();
    }
}

// APPLICATION — changes when the use case changes
public sealed class CompleteTaskHandler(
    ITaskRepository tasks,
    IUnitOfWork uow,
    IDomainEventPublisher events,
    TimeProvider clock)
{
    public async Task<TaskItem> HandleAsync(Guid id, CancellationToken ct)
    {
        var task = await tasks.GetAsync(id, ct) ?? throw new TaskNotFoundException(id);

        task.Complete(clock);

        await events.PublishAsync(new TaskCompleted(task.Id, task.ProjectId, task.Title), ct);
        await uow.SaveChangesAsync(ct);          // event and data committed together

        return task;
    }
}

// INFRASTRUCTURE — each changes for its own actor, independently
public sealed class TaskCompletedEmailHandler(IEmailSender email) : IEventHandler<TaskCompleted> { }
public sealed class TaskCompletedAuditHandler(IAuditLog audit) : IEventHandler<TaskCompleted> { }
public sealed class TaskCompletedCacheHandler(IStatsCache cache) : IEventHandler<TaskCompleted> { }
public sealed class TaskCompletedSlackHandler(ISlackClient slack) : IEventHandler<TaskCompleted> { }
```

## The improved implementation

What changed, concretely:

- **Testing the rule** is now three lines with no infrastructure.
- **Marketing changing the email** touches one file that cannot break completion.
- **Slack being down** fails a handler, not the operation — and if the events go through the outbox (Phase 7), it retries.
- **Adding a fifth side effect** is a new class and a registration; no existing file changes.
- **The rule is visible**: `TaskItem.Complete` is four lines and reads like the requirement.

::: warn Do not shred everything into one-method classes
SRP is not "one method per class". A `TaskService` with `Create`, `Complete`, `Assign` and `Delete` has one actor — the product owner defining task behaviour — and is perfectly cohesive.

The over-corrected version, with `CreateTaskService`, `CompleteTaskService`, `AssignTaskService`, each with one method and five constructor parameters, is harder to navigate and no more testable.

The question is always **"who asks for this to change?"**, not "how many methods are there?"
:::

::: exercise Level 1 — Guided · Find your own violations
Go through TaskFlow and, for each service class, list the actors who could request a change to it.

1. Name the actors for each class.
2. Any class with more than one actor is a candidate.
3. For the worst one, sketch the split before writing code.
4. Implement the split for that one class.
5. Write a test for its core rule and confirm it needs no infrastructure.
6. Count the test's setup lines before and after.
:::

::: challenge Level 3 · Domain events in TaskFlow
Implement the event mechanism properly.

Requirements:
1. `IDomainEvent`, raised by entities and collected until save.
2. Events are published **after** a successful `SaveChanges`, never before.
3. A failing handler does not roll back the data.
4. Handlers are discovered by DI; adding one requires no change to the publisher.
5. Events that must not be lost go through the outbox from Phase 7.
6. Handler failures are logged with the event payload.
7. A test proving that a rolled-back transaction publishes nothing.

Requirement 2 is the one people get wrong, and requirement 5 is where the real design decision lives.
:::

::: solution
Entities collect events rather than publishing them:

```csharp
public abstract class Entity
{
    private readonly List<IDomainEvent> _events = [];
    public IReadOnlyList<IDomainEvent> DomainEvents => _events;
    protected void Raise(IDomainEvent e) => _events.Add(e);
    public void ClearEvents() => _events.Clear();
}

public sealed class TaskItem : Entity
{
    public void Complete(TimeProvider clock)
    {
        if (Status is TaskStatus.Completed) throw new TaskStateException(this, "complete");
        Status = TaskStatus.Completed;
        CompletedAt = clock.GetUtcNow();
        Raise(new TaskCompleted(Id, ProjectId, Title, CompletedAt.Value));
    }
}
```

Published after the save, by overriding `SaveChangesAsync`:

```csharp
public override async Task<int> SaveChangesAsync(CancellationToken ct = default)
{
    var entities = ChangeTracker.Entries<Entity>()
        .Where(e => e.Entity.DomainEvents.Count > 0)
        .Select(e => e.Entity)
        .ToList();

    var events = entities.SelectMany(e => e.DomainEvents).ToList();

    // Durable events go in the SAME transaction as the data.
    foreach (var e in events.Where(e => e is IDurableEvent))
        OutboxMessages.Add(OutboxMessage.From(e));

    var written = await base.SaveChangesAsync(ct);      // ← the commit

    entities.ForEach(e => e.ClearEvents());

    // In-process handlers run AFTER the commit, and their failures do not roll back.
    foreach (var e in events)
        await _publisher.PublishAsync(e, ct);

    return written;
}
```

**Why events are raised in the entity but published after the save:** an entity raising `TaskCompleted` before the transaction commits means a handler could email "your task is complete" for a transaction that then rolls back. Collecting and publishing after the commit makes the event mean "this definitely happened".

**Why durable events go through the outbox and in-process ones do not.** This is the real decision:
- An email must not be lost if the process crashes between commit and publish → **outbox**, written inside the transaction, delivered by a background worker.
- A cache invalidation can be lost; the cache expires anyway → **in-process**, simpler and immediate.

Classifying each event is a design choice, and writing it down is what stops someone later assuming all events are reliable. Put the list in `DECISIONS.md`.

The test:
```csharp
[Fact]
public async Task A_rolled_back_transaction_publishes_nothing()
{
    await using var tx = await db.Database.BeginTransactionAsync();
    var task = await db.Tasks.FirstAsync();
    task.Complete(clock);
    await db.SaveChangesAsync();
    await tx.RollbackAsync();

    recordingPublisher.Published.ShouldBeEmpty();     // ← fails with naive publishing
    (await db.OutboxMessages.CountAsync()).ShouldBe(0);
}
```
Note this test fails for the in-process publisher if `SaveChangesAsync` publishes inside an outer transaction — which is a genuine limitation worth documenting: publishing after `SaveChanges` is not the same as publishing after *commit* when an explicit transaction wraps it.
:::

::: project Apply SRP to TaskFlow
1. Domain events for `TaskCreated`, `TaskCompleted`, `TaskAssigned`, `ProjectArchived`.
2. Handlers for email, audit, cache invalidation and statistics, each its own class.
3. Durable events through the outbox; transient ones in-process.
4. Every service class has one identifiable actor, recorded in `DECISIONS.md`.
5. Domain rule tests need no infrastructure.
6. The rollback test.

Commit.
:::

::: interview What is the Single Responsibility Principle?
A class should have one reason to change — one actor whose requests cause it to be modified. The common phrasing "does one thing" is too vague to act on; the useful question is "who asks for changes to this?"

The classic violation is a service method that applies a business rule, writes to the database, sends an email, writes an audit record and posts to a chat webhook. That is five actors, so five different teams can break task completion, and testing the rule requires an SMTP server and a file system.

The fix is to move the rule into the domain entity, let the use case orchestrate, and turn the side effects into separate handlers reacting to a domain event. The rule becomes testable in microseconds, and a change to the email template cannot break completion.

The caution is that SRP does not mean one method per class — over-splitting produces a codebase you cannot navigate for no gain in testability.
:::

::: checkpoint
- [ ] I can state SRP in terms of actors, not "one thing"
- [ ] I listed the actors for each of my service classes
- [ ] Domain events decouple side effects from the rule
- [ ] Events publish after commit, never before
- [ ] I classified each event as durable or transient, with reasons
:::

## Common mistakes

::: mistake
**Reading SRP as "one method per class".** Produces sprawl without benefit.

**Publishing events before the commit.** Notifications for transactions that roll back.

**A failing side effect rolling back the business operation.** Slack being down should not prevent completing a task.

**Side effects inline in the use case.** Untestable, and every actor's change risks every other.

**Assuming all events are reliable.** Some are; say which.
:::
