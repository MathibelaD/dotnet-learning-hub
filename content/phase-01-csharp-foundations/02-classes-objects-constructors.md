---
title: Classes, objects and constructors
summary: Reference semantics, constructor overloads, primary constructors, initialisers and object initialisers.
minutes: 40
stage: Stage 1
---

## What are we learning?

How C# builds objects. You know what a class is — what you need is the C#-specific machinery: the several ways to construct an object, what `new` really costs, and which style is idiomatic in 2026.

## Classes are reference types

```csharp
var a = new TaskItem { Title = "Ship it" };
var b = a;
b.Title = "Changed";

Console.WriteLine(a.Title);   // "Changed" — a and b point at the same object
```

`a` and `b` are two variables holding the same **reference**. The object lives on the heap; the variables hold an address. This is the single most consequential fact about classes in C#, and Phase 13 gets into what it costs.

## Four ways to construct

```csharp
public class TaskItem
{
    public string Title { get; set; }
    public string? Description { get; set; }
    public Priority Priority { get; set; } = Priority.Normal;   // field initialiser
    public DateTime CreatedAt { get; }

    // 1. Explicit constructor
    public TaskItem(string title)
    {
        Title = title;
        CreatedAt = DateTime.UtcNow;
    }

    // 2. Overload that chains with `this`
    public TaskItem(string title, Priority priority) : this(title)
    {
        Priority = priority;
    }
}
```

Usage:

```csharp
var t1 = new TaskItem("Write tests");
var t2 = new TaskItem("Fix the bug", Priority.High);

// 3. Object initialiser — runs after the constructor
var t3 = new TaskItem("Review PR") { Description = "Check the migration" };

// 4. Target-typed new — the type is already known from the left side
TaskItem t4 = new("Deploy");
```

Order of execution for `t3`: field initialisers → constructor body → object initialiser. Knowing that order explains why an object initialiser can overwrite something the constructor set.

## Primary constructors

Since C# 12, a class can declare constructor parameters on the class itself. The parameters are in scope for the whole class body.

```csharp
public class TaskItem(string title, Priority priority = Priority.Normal)
{
    public string Title { get; set; } = title;
    public Priority Priority { get; set; } = priority;
    public DateTime CreatedAt { get; } = DateTime.UtcNow;

    public override string ToString() => $"[{Priority}] {Title}";
}
```

::: warn Primary constructor parameters are not fields
On a **class** (unlike a `record`), `title` does not automatically become a property. It is captured only where you use it. If you write `public string Title { get; set; } = title;` the property is what stores the value; `title` itself is just the parameter.

That matters because this is a subtle bug:
```csharp
public class Counter(int start)
{
    public int Value { get; set; } = start;
    public void Reset() => Value = start;   // 'start' is captured in a hidden field — fine,
}                                           // but it is the ORIGINAL value, not the current one.
```
Primary constructors are excellent for dependency injection (Phase 8) and short data-holding classes. For anything with real initialisation logic, write a normal constructor.
:::

## Where primary constructors shine

```csharp
// This is the single most common shape you will write in the rest of the course.
public class TaskService(ITaskRepository repository, ILogger<TaskService> logger)
{
    public async Task<TaskItem> CompleteAsync(Guid id)
    {
        logger.LogInformation("Completing task {TaskId}", id);
        var task = await repository.GetAsync(id);
        task.Complete();
        return task;
    }
}
```

Compare with the old form — same behaviour, six more lines of ceremony:

```csharp
public class TaskService
{
    private readonly ITaskRepository _repository;
    private readonly ILogger<TaskService> _logger;

    public TaskService(ITaskRepository repository, ILogger<TaskService> logger)
    {
        _repository = repository;
        _logger = logger;
    }
    // ...
}
```

You will see both in real codebases. Read both fluently; write the first.

::: exercise Level 1 — Guided · Build TaskItem four ways
In your scratch project, create a `TaskItem` class with `Title`, `Description` (nullable), `Priority` (default `Normal`) and a read-only `CreatedAt`.

You will need an enum first:

```csharp
public enum Priority { Low, Normal, High, Urgent }
```

Now construct one instance using each of the four styles above and print each with string interpolation. Confirm you understand which values came from where.

Then add a second constructor that takes `(string title, string description)` and chains to the first with `: this(title)`.
:::

::: exercise Level 2 — Independent · Prove the execution order
Write a class that proves — with `Console.WriteLine` calls — the exact order of:

1. a field initialiser
2. the constructor body
3. an object initialiser

Requirements: three separate properties, each printing when it is set. Predict the output before you run it.
:::

::: solution
```csharp
var t = new Ordered("from ctor") { Third = "from initialiser" };

class Ordered
{
    public string First { get; set; } = Log("1: field initialiser");
    public string Second { get; set; }
    public string Third { get => _third; set { _third = Log("3: object initialiser"); } }
    private string _third = "";

    public Ordered(string second)
    {
        Second = Log("2: constructor body");
    }

    static string Log(string s) { Console.WriteLine(s); return s; }
}
```

Output:
```text
1: field initialiser
2: constructor body
3: object initialiser
```

The practical consequence: **an object initialiser can silently overwrite a value your constructor carefully computed.** If a value must not be overwritable, expose it as `{ get; }` with no setter — then the object initialiser cannot touch it and the compiler enforces it.
:::

::: debug Level 4 · Why is CreatedAt always the same?
This code produces three tasks with identical `CreatedAt` values, down to the tick. Find the bug.

```csharp
public class TaskItem
{
    private static readonly DateTime Now = DateTime.UtcNow;

    public string Title { get; set; } = "";
    public DateTime CreatedAt { get; } = Now;
}

var tasks = new[] { new TaskItem(), new TaskItem(), new TaskItem() };
foreach (var t in tasks) Console.WriteLine(t.CreatedAt.Ticks);
```
:::

::: solution
`Now` is `static readonly`. A static field is initialised **once**, the first time the type is used, not once per instance. Every `TaskItem` then copies that same frozen value.

Fix:
```csharp
public DateTime CreatedAt { get; } = DateTime.UtcNow;   // evaluated per instance
```

This is a real bug that ships. The general rule: a `static` initialiser runs once per type; an instance field initialiser runs once per object. When a value must differ per object, it cannot come from a static.

A second, sharper lesson lurks here: hard-coding `DateTime.UtcNow` inside a domain type makes it untestable — you cannot write a test that asserts "created at 3pm". In Phase 10 we replace it with an injected `TimeProvider`. Remember this spot.
:::

::: project Flesh out the TaskFlow TaskItem
Replace `Domain/TaskItem.cs` in your TaskFlow repo with a real one:

Requirements:
- `Id` of type `Guid`, set at construction, read-only from outside
- `Title`, required at construction, never null or empty
- `Description`, optional
- `Priority`, defaulting to `Normal`
- `CreatedAt` (UTC), read-only
- `CompletedAt` — nullable, `null` until the task is completed
- A method `Complete()` that sets `CompletedAt`, and throws if the task is already complete
- `ToString()` that renders something readable

Add `Domain/Priority.cs` with the enum.

Then in `Program.cs`: create three tasks, complete one, print all three. Commit.

```bash
git add . && git commit -m "Stage 1: TaskItem with construction rules"
```

Do not use `record` yet — we compare class and record deliberately in a later lesson, and you want the contrast.
:::

::: solution
```csharp
namespace TaskFlow.Domain;

public class TaskItem
{
    public Guid Id { get; } = Guid.NewGuid();
    public string Title { get; set; }
    public string? Description { get; set; }
    public Priority Priority { get; set; }
    public DateTime CreatedAt { get; } = DateTime.UtcNow;
    public DateTime? CompletedAt { get; private set; }

    public bool IsComplete => CompletedAt is not null;

    public TaskItem(string title, Priority priority = Priority.Normal)
    {
        if (string.IsNullOrWhiteSpace(title))
            throw new ArgumentException("Title is required.", nameof(title));

        Title = title;
        Priority = priority;
    }

    public void Complete()
    {
        if (IsComplete)
            throw new InvalidOperationException($"Task '{Title}' is already complete.");

        CompletedAt = DateTime.UtcNow;
    }

    public override string ToString() =>
        $"[{(IsComplete ? "x" : " ")}] {Priority,-6} {Title}";
}
```

Three things worth noticing:

- `CompletedAt` has a `private set`. Outside code cannot assign it; only `Complete()` can. This is how you make invalid states unrepresentable instead of documenting rules in a comment.
- `IsComplete` is an **expression-bodied property** computed from state rather than stored. Two sources of truth would eventually disagree.
- `nameof(title)` gives the compiler-checked parameter name. If you rename the parameter, the exception message follows. Never hard-code a string there.
:::

::: interview What happens when you write `new TaskItem()`?
Memory is allocated on the managed heap, the object header and type pointer are written, all fields are zeroed (`0`, `false`, `null`), then field initialisers run in declaration order, then the constructor body, then any object initialiser. The expression evaluates to a **reference** to that object.

Worth adding: the allocation is cheap (a pointer bump in the generation-0 nursery); the cost is paid later by the garbage collector.
:::

::: checkpoint
- [ ] I constructed an object four different ways
- [ ] I proved the field-initialiser → constructor → object-initialiser order myself
- [ ] I found the `static readonly` bug without reading the solution
- [ ] I can explain when to use a primary constructor and when not to
- [ ] TaskFlow's `TaskItem` validates its title and protects `CompletedAt`
:::

## Common mistakes

::: mistake
**`public string Title { get; set; }` with no initialiser on a non-nullable property.** The compiler warns `CS8618: Non-nullable property must contain a non-null value when exiting constructor`. Either set it in the constructor, give it `= ""`, or mark it `required`. Do not silence it with `= null!` unless you truly mean it.

**Exposing `set` on everything out of habit.** Every public setter is a way for callers to put your object into a state you did not intend. Start with `{ get; }` or `{ get; private set; }` and widen only when you need to.

**Putting validation in a setter instead of a constructor.** A constructor can refuse to create the object. A setter can only refuse after the object exists — by which point something invalid was already constructed.
:::
