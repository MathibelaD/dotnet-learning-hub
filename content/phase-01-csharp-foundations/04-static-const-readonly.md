---
title: Static members, const and readonly
summary: Three ways to say "this does not change", and they mean different things at different times.
minutes: 30
stage: Stage 1
---

## What are we learning?

`static`, `const`, `readonly` and `static readonly` — what each one actually guarantees, and when each is the wrong choice.

## Static: belongs to the type, not the instance

```csharp
public class TaskItem
{
    private static int _created;                 // one field for the whole program

    public TaskItem() => _created++;

    public static int TotalCreated => _created;  // static property
    public static TaskItem Empty { get; } = new();  // static factory-ish member
}

var a = new TaskItem();
var b = new TaskItem();
Console.WriteLine(TaskItem.TotalCreated);   // 2 — accessed on the TYPE
```

Static members are initialised **once**, lazily, the first time the type is touched. Which is exactly the bug from the constructors lesson.

### Static classes

```csharp
public static class TaskFormatting
{
    public static string ToDisplay(this TaskItem t) => $"{t.Title} ({t.Priority})";
}
```

A `static class` cannot be instantiated or inherited and can only hold static members. It is the home for extension methods (Phase 2) and for genuinely stateless helpers.

::: warn Static is where thread-safety bugs live
A static field is shared by every thread in your process. In a web API, that means every concurrent request. `private static List<TaskItem> _cache = [];` looks harmless in a console app and corrupts memory under load in an API.

Rule of thumb: static + mutable = you now owe the reader a thread-safety argument. Phase 13 covers `ConcurrentDictionary` and locking; until then, avoid mutable statics entirely.
:::

## `const`: compile-time constant, baked into callers

```csharp
public const int MaxTitleLength = 200;
public const string DefaultProject = "Inbox";
```

Rules:

- Must be assigned at declaration, with a value the compiler can compute.
- Only primitives, `string`, and `enum` can be `const`. Not `DateTime`, not `Guid`, not arrays.
- Implicitly `static`. You never write `static const`.
- **The value is copied into every assembly that uses it.**

That last rule has a real, nasty consequence:

::: warn The const versioning trap
Library `A` declares `public const int MaxRetries = 3;`. Application `B` compiles against it. The compiler bakes the literal `3` into `B.dll`.

You ship a new `A.dll` with `MaxRetries = 5`. `B` still uses 3 — because the value was copied at *B's* compile time, and B was not recompiled.

For anything that crosses an assembly boundary and might ever change, use `static readonly` instead. It is read at runtime from the current assembly.
:::

## `readonly`: assignable only in the constructor

```csharp
public class TaskItem
{
    private readonly List<string> _labels = [];        // set at declaration
    private readonly DateTime _createdAt;

    public TaskItem() => _createdAt = DateTime.UtcNow; // or in the constructor
}
```

`readonly` means the *variable* cannot be reassigned after construction. It says nothing about the object the variable points to.

```csharp
_labels = new List<string>();  // CS0191 outside a constructor
_labels.Add("still fine");     // completely legal
```

## The comparison

| | Evaluated | Where stored | Can hold | Changes on redeploy of the defining assembly |
|---|---|---|---|---|
| `const` | Compile time | Inlined into callers | primitives, string, enum | **No** |
| `static readonly` | Runtime, once per type | Defining assembly | anything | Yes |
| `readonly` | Runtime, once per object | The object | anything | Yes |

::: predict What does this print?
```csharp
Console.WriteLine(Config.Timeout);
Console.WriteLine(Config.Retries);
Console.WriteLine(Config.Started == Config.Started);

static class Config
{
    public const int Timeout = 30;
    public static readonly int Retries = 3;
    public static DateTime Started => DateTime.UtcNow;
}
```
Write down all three lines before you run it, then explain the third.
:::

::: solution
```text
30
3
False        (usually — occasionally True)
```

`Started` is an expression-bodied **property**, not a field. It is a method that returns `DateTime.UtcNow` every time it is called, so the two calls happen at slightly different moments. On a fast machine the clock's resolution occasionally makes them equal, which is worse than always being false — an intermittently failing test is much harder to diagnose than a consistently failing one.

Change `=>` to `=` and it becomes a field initialised once, and the comparison is always `True`. One character.

This is a genuinely common bug when writing configuration and caching types. `=>` means "compute each time"; `=` means "compute once, store it".
:::

::: exercise Level 2 — Independent · Domain constants for TaskFlow
Requirements:

1. Create `Domain/TaskRules.cs` as a `static class`.
2. It holds: maximum title length (200), maximum description length (2000), maximum labels per task (10), and the set of reserved label names that users may not use (`"archived"`, `"deleted"`).
3. Choose `const` or `static readonly` for each **and be able to justify each choice**.
4. Wire the limits into `TaskItem`'s constructor and `AddLabel` so the rules are actually enforced.
5. Write throwaway code in `Program.cs` that proves each rule by triggering it.
:::

::: solution
```csharp
namespace TaskFlow.Domain;

public static class TaskRules
{
    public const int MaxTitleLength = 200;          // int, never crosses an assembly boundary yet
    public const int MaxDescriptionLength = 2000;
    public const int MaxLabelsPerTask = 10;

    // Cannot be const: a collection is not a compile-time constant.
    public static readonly IReadOnlySet<string> ReservedLabels =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "archived", "deleted" };
}
```

Justifications worth being able to give out loud:

- The three ints are `const` because they are primitives used inside one assembly, and inlining them is free. If `TaskFlow.Domain` becomes a NuGet package other teams consume, revisit — `static readonly` would then be safer.
- `ReservedLabels` **must** be `static readonly`: `const` cannot hold a collection.
- `IReadOnlySet<string>` rather than `HashSet<string>` so callers cannot add to it. Note this is still the partial protection from the previous lesson, and here it is the right trade-off.
- `StringComparer.OrdinalIgnoreCase` means `"Archived"` is also rejected. Choosing the comparer explicitly is the kind of detail that separates working code from correct code.

In `AddLabel`:
```csharp
public void AddLabel(string label)
{
    label = label?.Trim() ?? "";
    if (label.Length == 0) throw new ArgumentException("Label cannot be blank.", nameof(label));
    if (TaskRules.ReservedLabels.Contains(label))
        throw new ArgumentException($"'{label}' is reserved.", nameof(label));
    if (_labels.Count >= TaskRules.MaxLabelsPerTask)
        throw new InvalidOperationException($"A task may have at most {TaskRules.MaxLabelsPerTask} labels.");
    if (_labels.Contains(label, StringComparer.OrdinalIgnoreCase)) return;
    _labels.Add(label);
}
```
:::

::: debug Level 4 · The counter that counts wrong
This is supposed to report how many tasks exist. Under a web API it reports nonsense. Find both problems.

```csharp
public class TaskItem
{
    public static int Count;
    public TaskItem() { Count = Count + 1; }
}
```
:::

::: solution
**Problem 1 — it is a public mutable static field.** Any code anywhere can write `TaskItem.Count = 9999;`. Make it `private static` with a public read-only property.

**Problem 2 — `Count = Count + 1` is not atomic.** It compiles to read, add, write. Two threads can both read `5`, both write `6`, and one increment vanishes. In a console app with one thread you will never see it. In an API serving concurrent requests you will, and it will look like a random undercount that nobody can reproduce.

```csharp
public class TaskItem
{
    private static int _count;
    public static int Count => Volatile.Read(ref _count);
    public TaskItem() => Interlocked.Increment(ref _count);
}
```

`Interlocked.Increment` performs the read-modify-write as a single atomic CPU operation. Phase 13 covers this properly.

The deeper lesson: **counting instances via a static is almost always the wrong design.** It is untestable (state leaks between tests), it is global, and it does not survive a restart. If you need a count, ask the thing that owns the collection.
:::

::: project Apply the rules
Wire `TaskRules` into `TaskItem` as above, then add a `TaskFlow.Domain.Project` rule: a project may not hold more than 500 tasks. Prove each limit from `Program.cs`, then commit:

```bash
git commit -am "Stage 1: domain rules enforced in the constructor"
```
:::

::: interview When would you use `const` versus `static readonly`?
`const` is evaluated at compile time and its value is **inlined into every assembly that references it**, so changing it requires recompiling all consumers. It is limited to primitives, strings and enums. `static readonly` is evaluated once at runtime when the type is first used, lives in the declaring assembly, and can hold any type.

Practical rule: `const` for values that are true by definition and will never change (`SecondsPerMinute = 60`, a protocol's magic string). `static readonly` for anything configurable, anything non-primitive, and anything that crosses a package boundary.
:::

::: checkpoint
- [ ] I can explain the const versioning trap to someone else
- [ ] I know the difference between `=` and `=>` on a static member, and why it matters
- [ ] I found both bugs in the counter without reading the solution
- [ ] `TaskRules` exists and its limits are actually enforced
- [ ] I can justify every `const` vs `static readonly` choice I made
:::

## Common mistakes

::: mistake
**Mutable static state in a web application.** Shared across every request and every thread. This is the single most common source of "works on my machine, corrupts data in production".

**`static readonly` arrays as "constants".** `public static readonly string[] Names = {...}` — array contents are mutable; any caller can write `Names[0] = "oops"`. Use `ImmutableArray<T>` or `IReadOnlyList<T>`.

**Using a static class to avoid dependency injection.** `TaskHelper.DoEverything()` is easy to call and impossible to test or replace. Phases 8 and 10 explain why this hurts. Static is for genuinely stateless, dependency-free logic.
:::
