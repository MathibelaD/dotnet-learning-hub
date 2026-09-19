---
title: Test doubles and mocking
summary: Fakes, stubs and mocks — what each is for, and why over-mocking produces tests that verify nothing.
minutes: 40
---

## What are we learning?

Replacing a dependency in a test, the five kinds of test double, and the judgement about which to reach for.

## The five kinds

```text
DUMMY   passed to satisfy a signature, never used
STUB    returns canned answers                          "GetAsync returns this task"
FAKE    a working but simplified implementation         an in-memory repository
SPY     records how it was called                       "was SendAsync called?"
MOCK    a spy with expectations that fail the test      "SendAsync must be called once"
```

People say "mock" for all five. The distinctions matter because they shape what a test actually verifies.

## NSubstitute

```bash
dotnet add package NSubstitute
```

```csharp
var repository = Substitute.For<ITaskRepository>();

// stub — return a canned value
repository.GetAsync(taskId, Arg.Any<CancellationToken>()).Returns(task);
repository.GetAsync(Arg.Any<Guid>(), Arg.Any<CancellationToken>()).Returns((TaskItem?)null);

// stub a sequence
repository.GetAsync(id, Arg.Any<CancellationToken>()).Returns(task, null);

// throw
repository.AddAsync(Arg.Any<TaskItem>(), Arg.Any<CancellationToken>())
          .ThrowsAsync(new DbUpdateException());

// spy — verify it was called
await repository.Received(1).AddAsync(Arg.Is<TaskItem>(t => t.Title == "Fix the bug"), Arg.Any<CancellationToken>());
await repository.DidNotReceive().RemoveAsync(Arg.Any<Guid>(), Arg.Any<CancellationToken>());

// capture the argument for detailed assertions
await repository.Received(1).AddAsync(Arg.Do<TaskItem>(t => captured = t), Arg.Any<CancellationToken>());
```

NSubstitute over Moq for new projects: the syntax is lighter (no `.Object`), and Moq's 2023 telemetry incident led many teams to move away.

## A service test

```csharp
public sealed class TaskServiceTests
{
    private readonly ITaskRepository _tasks = Substitute.For<ITaskRepository>();
    private readonly IProjectRepository _projects = Substitute.For<IProjectRepository>();
    private readonly INotificationService _notifications = Substitute.For<INotificationService>();
    private readonly IUnitOfWork _uow = Substitute.For<IUnitOfWork>();
    private readonly FakeTimeProvider _clock = new(new DateTimeOffset(2026, 9, 19, 10, 0, 0, TimeSpan.Zero));

    private TaskService CreateSut() => new(_tasks, _projects, _notifications, _uow, _clock);

    [Fact]
    public async Task CreateAsync_throws_when_the_project_does_not_exist()
    {
        _projects.GetAsync(Arg.Any<Guid>(), Arg.Any<CancellationToken>()).Returns((Project?)null);

        await Should.ThrowAsync<ProjectNotFoundException>(
            () => CreateSut().CreateAsync(new CreateTaskCommand("Title", projectId), default));

        await _tasks.DidNotReceive().AddAsync(Arg.Any<TaskItem>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task CreateAsync_notifies_only_when_the_project_has_notifications_enabled()
    {
        var project = new ProjectBuilder().WithNotifications(false).Build();
        _projects.GetAsync(project.Id, Arg.Any<CancellationToken>()).Returns(project);

        await CreateSut().CreateAsync(new CreateTaskCommand("Title", project.Id), default);

        await _notifications.DidNotReceiveWithAnyArgs().TaskCreatedAsync(default!, default);
    }
}
```

`CreateSut()` — "system under test" — built in a method rather than the constructor means each test can adjust a substitute before the service is created.

## When to verify and when not to

::: design Verify outcomes, not interactions
```csharp
// ❌ testing implementation
await _repository.Received(1).GetAsync(id, Arg.Any<CancellationToken>());
await _repository.Received(1).AddAsync(Arg.Any<TaskItem>(), Arg.Any<CancellationToken>());
await _uow.Received(1).SaveChangesAsync(Arg.Any<CancellationToken>());
```
This test passes only if the service calls exactly those methods in that shape. Refactor the service — combine two repository calls, add a cache — and the test fails even though the behaviour is unchanged. It verifies the code you wrote, not the behaviour you wanted.

```csharp
// ✅ testing behaviour
var result = await sut.CreateAsync(command, default);

result.Title.ShouldBe("Fix the bug");
result.Status.ShouldBe(TaskStatus.Todo);
(await fakeRepository.GetAsync(result.Id, default)).ShouldNotBeNull();
```
This passes for any implementation that produces the right outcome.

**Verify an interaction only when the interaction *is* the behaviour:**
- "An email is sent when a task is assigned" — the send *is* the observable outcome. Verify it.
- "The audit log records a deletion" — same.
- "Changes are saved" — usually better verified by reading the data back from a fake.

The rule: if you can assert on **state** instead of on **calls**, do. State assertions survive refactoring; call assertions do not.
:::

## Fakes are often better than mocks

```csharp
public sealed class FakeTaskRepository : ITaskRepository
{
    private readonly Dictionary<Guid, TaskItem> _tasks = [];

    public Task<TaskItem?> GetAsync(Guid id, CancellationToken ct = default) =>
        Task.FromResult(_tasks.GetValueOrDefault(id));

    public Task AddAsync(TaskItem task, CancellationToken ct = default)
    {
        _tasks[task.Id] = task;
        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<TaskItem>> ListByProjectAsync(Guid projectId, CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<TaskItem>>(
            _tasks.Values.Where(t => t.ProjectId == projectId)
                         .OrderByDescending(t => t.CreatedAt).ToList());

    // test affordances
    public void Seed(params TaskItem[] tasks) { foreach (var t in tasks) _tasks[t.Id] = t; }
    public int Count => _tasks.Count;
}
```

A fake is a real implementation with a simple backing store. Compared with a stub it:
- needs no per-test setup — `Seed(...)` once and every method works consistently
- lets you assert on **state** after the act
- stays consistent: adding then getting returns what you added, which a hand-stubbed mock will not unless you remember to wire it

The cost is that you maintain it — and it can drift from the real implementation, which is what the **contract tests** from Phase 8 are for.

**Reach for a fake when the dependency is stateful (a repository, a cache, a clock). Reach for a substitute when it is a one-shot collaborator (an email sender, an HTTP client) or when you specifically want to simulate a failure.**

## `TimeProvider`

```csharp
var clock = new FakeTimeProvider(new DateTimeOffset(2026, 9, 19, 10, 0, 0, TimeSpan.Zero));
var task = new TaskItem("x", projectId, Priority.Normal, clock);

clock.Advance(TimeSpan.FromDays(3));

task.AgeInDays(clock).ShouldBe(3);
task.IsStale(clock).ShouldBeFalse();

clock.Advance(TimeSpan.FromDays(12));
task.IsStale(clock).ShouldBeTrue();
```

```bash
dotnet add package Microsoft.Extensions.TimeProvider.Testing
```

This is the whole payoff for replacing `DateTime.UtcNow` with an injected `TimeProvider` back in Phase 5. Testing a fifteen-day staleness rule takes microseconds instead of being untestable.

`FakeTimeProvider` also controls `Task.Delay` and timers, so you can test a background service's schedule without waiting.

::: exercise Level 1 — Guided · Both approaches
Test `TaskService.CreateAsync` twice.

**Version A** — substitutes for everything, with `Received()` verification.
**Version B** — a `FakeTaskRepository` and `FakeProjectRepository`, asserting on state; a substitute only for `INotificationService`.

Then:
1. Refactor `CreateAsync` to look up the project through a cache before the repository.
2. Re-run both. Version A fails; version B passes.
3. Confirm the behaviour is actually unchanged.
4. Decide which suite you would rather own.
:::

::: challenge Level 3 · Test the hard paths
Write tests for the cases that are hard to reach in production:

1. The repository throws `DbUpdateConcurrencyException` — the service must translate it to a domain exception.
2. The notification service throws — the task must still be created (notification failure is not fatal).
3. The cancellation token is cancelled mid-operation — no partial write.
4. Two concurrent `CompleteAsync` calls for the same task — exactly one succeeds.
5. `SaveChangesAsync` succeeds but the notification times out — the outbox row must still exist.
6. A malformed row from the repository (null title, impossible status) — the service must fail loudly rather than propagate corruption.

Case 6 is the one people skip and the one that saves you in production.
:::

::: solution
Case 6 deserves an argument, because there are two defensible answers.

```csharp
[Fact]
public async Task Service_fails_loudly_on_a_corrupt_entity()
{
    var corrupt = CreateCorruptTaskViaReflection(title: null!, status: (TaskStatus)99);
    _tasks.GetAsync(id, Arg.Any<CancellationToken>()).Returns(corrupt);

    await Should.ThrowAsync<InvalidOperationException>(() => CreateSut().CompleteAsync(id, default));
}
```

**Position A — fail loudly.** A corrupt entity means an invariant has already been violated. Continuing spreads the corruption into new writes and into responses. Better to fail one request with a clear error and get an alert.

**Position B — do not test this.** If the domain constructor enforces invariants, a corrupt entity cannot exist without someone bypassing the domain — via `ExecuteUpdate`, a manual SQL fix, or a migration. Writing a test for a state you have designed to be unreachable can be rearranging deck chairs.

**The resolution:** position B is correct *if* nothing bypasses the domain. In practice something does — a data fix at 2am, a migration with a wrong default, an `ExecuteUpdate` added by someone in a hurry. And EF Core materialises entities **without** running your constructor, so an invalid database row becomes an invalid object with no complaint.

That last fact is the deciding argument. A validation pass at the persistence boundary — or at least on the paths that mutate — is cheap insurance. Note it in `DECISIONS.md`.

For case 4, concurrency, a fake with a deliberate delay exposes the race:
```csharp
_tasks.GetAsync(id, Arg.Any<CancellationToken>()).Returns(async _ =>
{
    await Task.Delay(50);
    return task;
});

var results = await Task.WhenAll(
    Try(() => sut.CompleteAsync(id, default)),
    Try(() => sut.CompleteAsync(id, default)));

results.Count(r => r.Succeeded).ShouldBe(1);
```
This tests your *service's* handling. It does **not** test database-level concurrency, which needs a real database — that is Phase 10 lesson 4, and knowing the difference is the point.
:::

::: project Test TaskFlow's application layer
1. `tests/TaskFlow.Application.Tests`.
2. Fakes for repositories, substitutes for notifications and email.
3. Tests for every use case: happy path, not-found, forbidden, invalid state, dependency failure.
4. `FakeTimeProvider` for anything time-dependent.
5. No test asserting on repository call counts unless the call *is* the behaviour.
6. The suite runs in under one second.
7. `DECISIONS.md`: your fake-versus-mock policy in three sentences.

Commit.
:::

::: interview What is the difference between a mock and a stub?
A stub supplies canned answers so the code under test can run — it is about *input*. A mock records how it was called and can fail the test if expectations are not met — it is about *output*, specifically the interaction itself. A fake is a third thing: a real but simplified implementation, like an in-memory repository.

My preference is fakes plus state assertions over mocks plus interaction assertions, because asserting "the repository was called twice" couples the test to the implementation — refactoring breaks it even when behaviour is unchanged. Asserting "the task is now retrievable and completed" survives refactoring.

I use interaction verification only when the interaction *is* the observable behaviour — "an email is sent when a task is assigned" has no state to check, so verifying the call is the test.
:::

::: checkpoint
- [ ] I can name the five kinds of test double
- [ ] I wrote the same test with mocks and with fakes and saw which survived a refactor
- [ ] I assert on state wherever state exists
- [ ] `FakeTimeProvider` lets me test time-based rules instantly
- [ ] I tested the failure paths, not only the happy path
:::

## Common mistakes

::: mistake
**Mocking everything.** The test verifies the implementation and breaks on every refactor.

**Mocking types you own and could fake.** A fake gives you consistency for free.

**Mocking `DbContext`.** It does not work well and the result tests nothing real. Use a fake repository or a real database.

**Asserting call counts as a matter of habit.** `Received(1)` on a getter tells you nothing about behaviour.

**No failure-path tests.** The happy path is the path that already works.
:::
