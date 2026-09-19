---
title: Testing fundamentals with xUnit
summary: What to test, what not to, and how to write a test whose failure message tells you what broke.
minutes: 40
---

## What are we learning?

xUnit mechanics, Arrange/Act/Assert, and the judgement about what deserves a test.

## Why xUnit

.NET has three mainstream frameworks. xUnit is the default for new projects: it is what the ASP.NET Core team uses, it creates a fresh test class instance per test (so state cannot leak between tests), and it has no `[SetUp]`/`[TearDown]` attributes — you use a constructor and `IDisposable`, which is just C#.

NUnit and MSTest are both fine and you will meet them. The concepts transfer entirely.

```bash
dotnet new xunit -o tests/TaskFlow.Domain.Tests
dotnet add tests/TaskFlow.Domain.Tests reference src/TaskFlow.Domain
dotnet add tests/TaskFlow.Domain.Tests package NSubstitute
dotnet add tests/TaskFlow.Domain.Tests package Shouldly
```

## The shape of a test

```csharp
public sealed class TaskItemTests
{
    [Fact]
    public void Complete_sets_the_status_and_the_completion_time()
    {
        // Arrange
        var clock = new FakeTimeProvider(new DateTimeOffset(2026, 9, 19, 10, 0, 0, TimeSpan.Zero));
        var task = new TaskItem("Fix the bug", projectId, Priority.Normal, clock);
        task.Start();

        // Act
        task.Complete();

        // Assert
        Assert.Equal(TaskStatus.Completed, task.Status);
        Assert.Equal(clock.GetUtcNow(), task.CompletedAt);
    }
}
```

**Arrange, Act, Assert.** One action per test. If you have two "Act" steps, you have two tests.

## Naming

The name is the specification, and it is what you read when the test fails in CI at 4pm on a Friday.

```csharp
// ❌ tells you nothing
public void Test1()
public void CompleteTest()
public void TestComplete_Works()

// ✅ states the behaviour
public void Complete_sets_the_status_to_completed()
public void Complete_throws_when_the_task_is_already_complete()
public void AddLabel_ignores_a_duplicate_that_differs_only_in_case()
public void Search_returns_an_empty_page_when_nothing_matches()
```

A good convention: `Method_expectedBehaviour_whenCondition`, or plain English. The test that matters most is the one whose name you will read without opening the file.

## Facts and theories

```csharp
[Fact]
public void A_new_task_starts_in_the_todo_state() { }

[Theory]
[InlineData("")]
[InlineData("   ")]
[InlineData(null)]
public void Constructor_rejects_a_blank_title(string? title) =>
    Assert.Throws<ArgumentException>(() => new TaskItem(title!, projectId, clock));

[Theory]
[MemberData(nameof(IllegalTransitions))]
public void Illegal_transitions_are_rejected(TaskStatus from, TaskStatus to)
{
    var task = TaskAt(from);
    Assert.Throws<TaskStateException>(() => task.TransitionTo(to));
}

public static TheoryData<TaskStatus, TaskStatus> IllegalTransitions => new()
{
    { TaskStatus.Completed, TaskStatus.InProgress },
    { TaskStatus.Completed, TaskStatus.Todo },
    { TaskStatus.Cancelled, TaskStatus.InProgress },
    { TaskStatus.Todo,      TaskStatus.Completed },     // must go through InProgress
    { TaskStatus.Todo,      TaskStatus.Blocked },
};
```

`TheoryData<...>` is strongly typed, unlike `IEnumerable<object[]>`, so a mismatched argument is a compile error.

## Assertions

```csharp
// xUnit built-in
Assert.Equal(expected, actual);
Assert.NotNull(value);
Assert.Contains("bug", task.Labels);
Assert.Empty(results);
Assert.Throws<TaskStateException>(() => task.Complete());
await Assert.ThrowsAsync<TaskNotFoundException>(() => service.GetAsync(id, default));

// Shouldly — better failure messages
task.Status.ShouldBe(TaskStatus.Completed);
task.Labels.ShouldContain("bug");
Should.Throw<TaskStateException>(() => task.Complete())
      .Message.ShouldContain("already complete");
```

The difference shows up on failure:

```text
xUnit:     Assert.Equal() Failure
           Expected: Completed
           Actual:   InProgress

Shouldly:  task.Status
               should be
           Completed
               but was
           InProgress
```

Shouldly reads your source to show the expression that failed. On a complex assertion inside a loop, that is the difference between knowing what broke and re-running under a debugger.

## What to test

::: design The testing pyramid, adjusted for reality
```text
        ╱╲          E2E / API tests      few, slow, high confidence
       ╱──╲
      ╱────╲        Integration tests    some, medium
     ╱──────╲
    ╱────────╲      Unit tests           many, fast, precise
```

**Test:**
- Business rules and invariants — every branch
- Edge cases: empty, null, zero, one, maximum, boundary ± 1
- Anything that has broken before — a regression test is the highest-value test there is
- Anything you had to think hard about

**Do not test:**
- Property getters and setters
- The framework (EF Core saves things; ASP.NET Core routes)
- Mapping code with no logic — a compile error catches those
- Implementation details. Test *what* it does, not *how*

**The test for whether a test is worth writing:** if this test fails, will I learn something I did not know? If it can only fail when the code is deleted, it is not earning its place.
:::

## Coverage

```bash
dotnet test --collect:"XPlat Code Coverage"
dotnet tool install -g dotnet-reportgenerator-globaltool
reportgenerator -reports:"**/coverage.cobertura.xml" -targetdir:coverage -reporttypes:Html
```

::: warn Coverage is a diagnostic, not a target
100% coverage with no assertions is possible and worthless:
```csharp
[Fact]
public void Covers_everything()
{
    var task = new TaskItem("x", id, clock);
    task.Start(); task.Complete(); _ = task.ToString();
    // no assertions — 100% coverage, zero value
}
```

Use coverage to **find** untested branches, not as a number to hit. A mandated 80% target reliably produces assertion-free tests written to satisfy the gate.

What to actually look at: which *branches* in your domain are uncovered. Those are the rules nobody has verified.
:::

::: exercise Level 1 — Guided · Test the domain
Write tests for `TaskItem` covering:

1. A new task starts as `Todo` with no `CompletedAt`.
2. A blank, whitespace or null title is rejected — one `[Theory]`.
3. A title over 200 characters is rejected; exactly 200 is accepted (boundary).
4. Every legal status transition succeeds — `[Theory]`.
5. Every illegal transition throws, with both states in the message — `[Theory]`.
6. `Complete()` sets `CompletedAt` from the injected clock.
7. `AddLabel` trims, rejects blanks and reserved names, and ignores case-insensitive duplicates.
8. The eleventh label throws.
9. `IsOverdue` is correct for: past due and open, past due and complete, due today, due tomorrow, no due date.

Run `dotnet test`. Then run it with coverage and find what you missed.
:::

::: challenge Level 3 · Make the tests tell you what broke
Take your test suite and improve every failure message.

Requirements:
1. Deliberately break each rule in the domain, one at a time, and read the failure.
2. For any failure that does not immediately say what is wrong, improve the test.
3. No test may need the debugger to diagnose.
4. Add a custom assertion for your most-repeated check.
5. Reduce duplication with a test data builder, without hiding what each test is actually asserting.

Point 5 has a trap: over-abstracted test setup makes tests unreadable. Find the line.
:::

::: solution
A test data builder, done well:

```csharp
public sealed class TaskItemBuilder
{
    private string _title = "A task";
    private Priority _priority = Priority.Normal;
    private TaskStatus _status = TaskStatus.Todo;
    private DateOnly? _dueDate;
    private readonly List<string> _labels = [];
    private FakeTimeProvider _clock = new(new DateTimeOffset(2026, 9, 19, 10, 0, 0, TimeSpan.Zero));

    public TaskItemBuilder Titled(string title) { _title = title; return this; }
    public TaskItemBuilder WithPriority(Priority p) { _priority = p; return this; }
    public TaskItemBuilder DueOn(DateOnly date) { _dueDate = date; return this; }
    public TaskItemBuilder Labelled(params string[] labels) { _labels.AddRange(labels); return this; }
    public TaskItemBuilder InProgress() { _status = TaskStatus.InProgress; return this; }

    public TaskItem Build()
    {
        var task = new TaskItem(_title, Guid.NewGuid(), _priority, _clock);
        if (_dueDate is { } d) task.SetDueDate(d);
        foreach (var l in _labels) task.AddLabel(l);
        if (_status is TaskStatus.InProgress) task.Start();
        return task;
    }

    public static implicit operator TaskItem(TaskItemBuilder b) => b.Build();
}
```

Used:
```csharp
[Fact]
public void An_open_task_past_its_due_date_is_overdue()
{
    TaskItem task = new TaskItemBuilder().InProgress().DueOn(new DateOnly(2026, 9, 1));

    task.IsOverdue(new DateOnly(2026, 9, 19)).ShouldBeTrue();
}
```

**Where the line is:** the builder supplies *defaults you do not care about* while every value the test *is about* stays visible in the test. `.DueOn(...)` and `.InProgress()` are in the test because they are the conditions under test; the title and project id are not, because they are irrelevant to overdue-ness.

The anti-pattern is `TestData.CreateOverdueTask()` — now the test reads "assert that the overdue task is overdue", and when it fails you have to open another file to find out what "overdue task" meant.

The implicit conversion is a small nicety that removes `.Build()` from every call site. Use it or not; it is taste.

A custom assertion for the repeated check:
```csharp
public static class TaskAssertions
{
    public static void ShouldBeInState(this TaskItem task, TaskStatus expected)
    {
        if (task.Status != expected)
            throw new ShouldAssertException(
                $"Task '{task.Title}' should be {expected} but was {task.Status}. " +
                $"CompletedAt={task.CompletedAt?.ToString() ?? "null"}.");
    }
}
```
Including the *related* state in the message is what makes a failure self-diagnosing — you learn not just that the status is wrong but that `CompletedAt` was set anyway, which tells you where the bug is.
:::

::: project Test TaskFlow's domain
1. `tests/TaskFlow.Domain.Tests` covering every rule in `TaskItem`, `Project`, `User` and your value objects.
2. `[Theory]` for every table-shaped rule (transitions, validation limits).
3. A `TaskItemBuilder` and a `ProjectBuilder`.
4. `FakeTimeProvider` (from `Microsoft.Extensions.TimeProvider.Testing`) everywhere — this is why you injected `TimeProvider` in Phase 5.
5. The whole suite runs in under 200ms.
6. A coverage report; find and fill the gaps that matter.
7. Add `dotnet test` to your build script.

Commit.
:::

::: interview What makes a good unit test?
It tests one behaviour, it is fast, it does not depend on other tests, and its name and failure message tell you what broke without opening a debugger.

Concretely: Arrange/Act/Assert with a single action; no I/O, so it runs in milliseconds; a fresh instance per test — which xUnit gives you by construction — so state cannot leak; and a name that states the behaviour rather than the method under test.

What I would not test is framework behaviour, trivial property accessors, or implementation details — testing *how* something works rather than *what* it does makes refactoring break tests that should not care. I use coverage to find untested branches, not as a target, because a mandated percentage reliably produces tests with no assertions.
:::

::: checkpoint
- [ ] Every domain rule has a test
- [ ] Test names state behaviour and read without the file open
- [ ] I broke each rule deliberately and confirmed the failure message was useful
- [ ] My builders hide irrelevant setup without hiding the assertion's subject
- [ ] The domain suite runs in under 200ms
:::

## Common mistakes

::: mistake
**Tests named `Test1`, `TestMethod`, `ItWorks`.** The name is what you read at 4pm on a Friday.

**Multiple acts in one test.** When it fails you do not know which action broke.

**Tests that depend on execution order.** xUnit runs classes in parallel by default; order-dependent tests fail randomly.

**Asserting on implementation.** "Calls the repository twice" breaks on every refactor and verifies nothing about behaviour.

**Coverage as a target.** Produces assertion-free tests.

**`DateTime.UtcNow` in a test.** Non-deterministic, and unable to test "in three days". Inject `TimeProvider`.
:::
