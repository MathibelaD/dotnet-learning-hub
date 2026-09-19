---
title: Enums and pattern matching
summary: Modelling a closed set of states, and the switch expression that makes working with them a pleasure.
minutes: 40
stage: Stage 1
---

## What are we learning?

Enums — including their sharp edges — and the pattern matching that replaces the `if`/`else` towers you would write in other languages.

## Enums

```csharp
public enum Priority { Low, Normal, High, Urgent }

public enum TaskStatus
{
    Todo = 0,
    InProgress = 1,
    Blocked = 2,
    Completed = 3,
    Cancelled = 4
}
```

An enum is a named set of integer constants. That phrasing matters, because it explains both sharp edges:

::: warn Two things about enums that will catch you
**1. An enum variable can hold a value that is not in the enum.**
```csharp
var p = (Priority)42;
Console.WriteLine(p);              // "42" — no exception, no validation
Console.WriteLine(p == Priority.Low);  // False
```
There is no runtime check. When an enum arrives from outside your program — an HTTP request, a database column, JSON — validate it:
```csharp
if (!Enum.IsDefined(value)) throw new ArgumentOutOfRangeException(nameof(value));
```

**2. The numeric values are part of your data contract.**
If `TaskStatus.Blocked` is stored in the database as `2`, and someone later inserts a new member in the middle, every existing row silently changes meaning. **Always assign explicit values**, and always append new members at the end.
:::

### Flags

```csharp
[Flags]
public enum TaskPermissions
{
    None   = 0,
    Read   = 1 << 0,   // 1
    Write  = 1 << 1,   // 2
    Delete = 1 << 2,   // 4
    Assign = 1 << 3,   // 8
    All    = Read | Write | Delete | Assign
}

var p = TaskPermissions.Read | TaskPermissions.Write;
Console.WriteLine(p);                            // "Read, Write"
Console.WriteLine(p.HasFlag(TaskPermissions.Write));  // True
p |= TaskPermissions.Delete;                     // add
p &= ~TaskPermissions.Read;                      // remove
```

The `[Flags]` attribute does not change behaviour — it changes `ToString()` and signals intent. The powers of two are what make it work.

## Pattern matching

This is the feature that most changes how C# reads compared to Java or C.

### Switch expressions

```csharp
string Describe(TaskStatus status) => status switch
{
    TaskStatus.Todo       => "Not started",
    TaskStatus.InProgress => "Being worked on",
    TaskStatus.Blocked    => "Waiting on something",
    TaskStatus.Completed  => "Done",
    TaskStatus.Cancelled  => "Abandoned",
    _                     => throw new ArgumentOutOfRangeException(nameof(status))
};
```

It is an **expression** — it produces a value, so it can be the body of a method, an argument, or the right-hand side of an assignment. No `break`, no fallthrough, no accidental missing `return`.

### The pattern vocabulary

```csharp
object value = GetSomething();

var result = value switch
{
    null                          => "nothing",                 // constant pattern
    int n when n < 0              => "negative number",         // type + guard
    int n                         => $"number {n}",             // type pattern
    string { Length: 0 }          => "empty string",            // property pattern
    string s                      => $"string of {s.Length}",
    TaskItem { IsComplete: true } => "a finished task",          // property pattern
    TaskItem { Priority: Priority.Urgent, IsComplete: false } t
                                  => $"URGENT: {t.Title}",       // multiple properties + capture
    [ ]                           => "empty collection",         // list pattern
    [var only]                    => $"one item: {only}",        // list pattern with capture
    [_, _, ..]                    => "two or more items",
    _                             => "something else"            // discard
};
```

And the relational and logical patterns:

```csharp
string Bucket(int days) => days switch
{
    < 0        => "overdue",
    0          => "today",
    1 or 2     => "soon",
    >= 3 and <= 7 => "this week",
    _          => "later"
};
```

### `is` patterns

```csharp
if (obj is TaskItem { IsComplete: false } task)
    Console.WriteLine(task.Title);          // 'task' is in scope and strongly typed

if (value is not null) { }                  // the readable negation
if (task.CompletedAt is { } completedAt) { }  // "is not null, and call it completedAt"
```

::: note Exhaustiveness
A switch expression over an enum that misses a member compiles with a **warning** (`CS8509`), not an error, because of the "enums can hold undefined values" problem. Treat that warning as an error — see the project step.

Over a sealed hierarchy of records, the compiler can often prove exhaustiveness completely, which makes "add a new case, compiler tells me every place to update" a real workflow.
:::

::: exercise Level 1 — Guided · Replace an if-chain
Write this method twice — first with `if`/`else if`, then as a switch expression. Compare the two.

```csharp
// Rules:
//   Completed or Cancelled          -> "closed"
//   Blocked                         -> "needs attention"
//   InProgress and Urgent priority  -> "escalate"
//   InProgress                      -> "in flight"
//   Todo and Urgent                 -> "start immediately"
//   Todo                            -> "queued"
string Triage(TaskStatus status, Priority priority)
```

Then extend it: add a third parameter `int daysOld`, and any task open for more than 14 days returns `"stale"` regardless of anything else. Notice how much easier that was to add to one version than the other.
:::

::: solution
```csharp
string Triage(TaskStatus status, Priority priority, int daysOld) => (status, priority, daysOld) switch
{
    (TaskStatus.Completed or TaskStatus.Cancelled, _, _) => "closed",
    (_, _, > 14)                                         => "stale",
    (TaskStatus.Blocked, _, _)                           => "needs attention",
    (TaskStatus.InProgress, Priority.Urgent, _)          => "escalate",
    (TaskStatus.InProgress, _, _)                        => "in flight",
    (TaskStatus.Todo, Priority.Urgent, _)                => "start immediately",
    (TaskStatus.Todo, _, _)                              => "queued",
    _ => throw new ArgumentOutOfRangeException(nameof(status))
};
```

Switching on a **tuple** of inputs is the technique to remember. It turns a decision table into something that reads like a decision table.

Order matters: the first matching arm wins. `closed` must come before `stale`, or a completed task from last month reports as stale. Write the arms in priority order and read them top to bottom as rules.
:::

::: challenge Level 3 · A permission check
Implement:

```csharp
bool CanEdit(TaskItem task, User user, TaskPermissions permissions)
```

Rules, in order of precedence:
1. Nobody can edit a `Cancelled` task.
2. A user with the `Admin` role can edit anything else.
3. The task's assignee can edit it if they hold the `Write` permission.
4. The project owner can always edit tasks in their project.
5. Otherwise, no.

Design the types you need (`User` with a `Role`, a `Role` enum, an `AssigneeId` on `TaskItem`). Use pattern matching where it genuinely reads better than `if`, and plain `if` where it does not. Part of the challenge is deciding which is which.
:::

::: solution
```csharp
bool CanEdit(TaskItem task, User user, TaskPermissions permissions) => (task, user) switch
{
    ({ Status: TaskStatus.Cancelled }, _)              => false,
    (_, { Role: Role.Admin })                          => true,
    ({ AssigneeId: var a }, { Id: var u }) when a == u => permissions.HasFlag(TaskPermissions.Write),
    _ when task.Project?.OwnerId == user.Id            => true,
    _                                                  => false
};
```

Honest assessment: arms three and four are pushing it. `when` clauses that do most of the work are a sign the pattern is not carrying its weight. A perfectly good alternative:

```csharp
bool CanEdit(TaskItem task, User user, TaskPermissions permissions)
{
    if (task.Status is TaskStatus.Cancelled) return false;
    if (user.Role is Role.Admin) return true;
    if (task.AssigneeId == user.Id) return permissions.HasFlag(TaskPermissions.Write);
    if (task.Project?.OwnerId == user.Id) return true;
    return false;
}
```

This version is arguably clearer, and `is` patterns still make the conditions read well. **Pattern matching is a tool, not a virtue.** Use the switch expression when you are mapping inputs to outputs; use `if` when you are describing a sequence of policy decisions. If you picked the second form, you made a good call.
:::

::: project Add TaskStatus to TaskFlow
1. Create `Domain/TaskStatus.cs` with explicit numeric values for `Todo`, `InProgress`, `Blocked`, `Completed`, `Cancelled`.
2. Replace `TaskItem.CompletedAt`-as-the-source-of-truth with a `Status` property (`{ get; private set; }`), keeping `CompletedAt` as a timestamp that is set when status becomes `Completed`.
3. Add methods `Start()`, `Block(string reason)`, `Complete()`, `Cancel()` that enforce legal transitions. Use a switch expression for the transition table.
4. Add `Domain/TaskStateExtensions.cs` with `string ToDisplay(this TaskStatus status)`.
5. Turn the exhaustiveness warning into an error. In `TaskFlow.Console.csproj`:
   ```xml
   <PropertyGroup>
     <WarningsAsErrors>CS8509;CS8524</WarningsAsErrors>
   </PropertyGroup>
   ```
   Now delete one arm of a switch and confirm the build fails. That configuration is worth carrying into every project you ever write.

Commit.
:::

::: warn A name collision you will definitely hit
`System.Threading.Tasks.TaskStatus` already exists in the BCL, and `System.Threading.Tasks` is one of the implicit usings. The moment you add `async` code in Phase 4, `TaskStatus` becomes ambiguous (`CS0104`).

Three ways out, in order of preference:
1. Name yours something else: `TaskState`, `WorkItemStatus`.
2. Alias it: `using TaskStatus = TaskFlow.Domain.TaskStatus;`
3. Fully qualify it at every use site. (Don't.)

This is why the entity is called `TaskItem` and not `Task` — `System.Threading.Tasks.Task` would collide constantly. Choosing domain names that do not clash with the BCL is a real skill, and "Task" is the classic trap.
:::

::: interview What is pattern matching used for in C#?
It lets you test a value's shape — its type, its property values, its position in a sequence — and extract parts of it in one expression. Concretely: type patterns (`is TaskItem t`), property patterns (`{ Status: Completed }`), relational and logical patterns (`>= 3 and <= 7`, `Todo or Blocked`), list patterns, and switch expressions that return a value.

The practical payoff is that mapping logic becomes a readable table rather than a nest of `if`s, and the compiler can warn you when the table is incomplete.
:::

::: checkpoint
- [ ] I proved that `(Priority)42` is legal and produces no error
- [ ] I can write a switch expression over a tuple of inputs
- [ ] I know the difference between `is not null` and `!= null` for a type with a custom `==`
- [ ] I chose deliberately between a switch expression and `if` in the permission challenge
- [ ] TaskFlow has a `TaskStatus` with enforced transitions and `CS8509` as an error
:::

## Common mistakes

::: mistake
**Not assigning explicit enum values for anything persisted.** Reordering members silently corrupts stored data.

**Trusting an enum that came from outside.** JSON deserialisation will happily produce `(Priority)99`. Validate with `Enum.IsDefined`.

**Forgetting the discard arm.** A switch expression with no matching arm throws `SwitchExpressionException` at runtime — a weird exception type that tells you nothing about which input caused it. Either handle `_` explicitly or throw with the value in the message.

**Using `[Flags]` without powers of two.** `Read = 1, Write = 2, Delete = 3` means `Read | Write == Delete`. Silent, total nonsense.
:::
