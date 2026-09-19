---
title: Extension methods
summary: Adding methods to types you do not own — how LINQ exists at all, and how to not abuse it.
minutes: 25
stage: Stage 1
---

## What are we learning?

Extension methods: the mechanism behind LINQ, ASP.NET Core's entire configuration API, and about half of the ergonomics of modern .NET.

## The mechanism

```csharp
public static class TaskExtensions
{
    public static bool IsStale(this TaskItem task, int days = 14) =>
        task.IsOpen && (DateTime.UtcNow - task.CreatedAt).TotalDays > days;
}
```

Three requirements: a **static class**, a **static method**, and `this` on the **first parameter**.

Now:

```csharp
if (task.IsStale())          // looks like an instance method
if (task.IsStale(days: 30))
```

The compiler rewrites `task.IsStale()` into `TaskExtensions.IsStale(task)`. There is no runtime magic; the type is not modified. It is syntax.

::: why Why this feature exists
LINQ. `Where`, `Select` and the other operators are extension methods on `IEnumerable<T>`. Adding them as real interface members would have broken every existing implementation of `IEnumerable<T>` in the world. Extension methods let Microsoft add ~50 methods to an interface that shipped in .NET 1.0, with zero breaking changes.

That is the case they are genuinely for: **adding behaviour to a type you cannot change** — an interface, a BCL type, a third-party library type.
:::

## What they can and cannot do

```csharp
public static class Ext
{
    // ✅ Can be called on null — it is just a static method
    public static bool IsEmpty(this string? s) => string.IsNullOrEmpty(s);

    // ❌ Cannot access private members of the type
    // ❌ Cannot be overridden — no virtual dispatch
    // ❌ Loses to an instance method with the same signature
}
```

That third rule matters:

```csharp
public class Foo { public void Bar() => Console.WriteLine("instance"); }
public static class E { public static void Bar(this Foo f) => Console.WriteLine("extension"); }

new Foo().Bar();     // "instance" — always
```

An instance method always wins. So if a library later adds a real method with your extension's name, your call sites silently change behaviour. Rare, but it happens.

## Extending interfaces is where it pays off

```csharp
public static class TaskQueryExtensions
{
    public static IEnumerable<TaskItem> Open(this IEnumerable<TaskItem> tasks) =>
        tasks.Where(t => t.IsOpen);

    public static IEnumerable<TaskItem> WithLabel(this IEnumerable<TaskItem> tasks, string label) =>
        tasks.Where(t => t.Labels.Contains(label, StringComparer.OrdinalIgnoreCase));

    public static IEnumerable<TaskItem> DueBefore(this IEnumerable<TaskItem> tasks, DateOnly date) =>
        tasks.Where(t => t.DueDate is { } due && due < date);
}
```

Because each returns `IEnumerable<TaskItem>`, they chain:

```csharp
var report = store.All()
    .Open()
    .WithLabel("security")
    .DueBefore(nextFriday)
    .OrderByDescending(t => t.Priority);
```

That reads like the requirement it implements. This is the single most useful pattern in the lesson, and Phase 7 shows the same technique producing SQL.

## Discovery: extensions need a `using`

An extension method is only visible if its namespace is imported. This is why:

```csharp
using System.Linq;          // without this, .Where() does not exist
```

and why a method "disappears" when you move a file to a different namespace. If IntelliSense cannot see an extension you know exists, the missing `using` is the first thing to check. Putting widely-used extensions in a namespace that is already imported — or adding a `global using` — solves it.

::: exercise Level 1 — Guided · Extend types you do not own
Write these in a static class and use each one:

1. `string.Truncate(int max, string suffix = "…")` — shortens and appends the suffix only if it actually truncated.
2. `DateTime.ToRelative()` — "3 minutes ago", "2 days ago", "just now".
3. `IEnumerable<T>.Batch(int size)` returning `IEnumerable<IReadOnlyList<T>>` — chunks a sequence. (Then discover that .NET already has `Chunk` and compare yours.)
4. `TaskStatus.IsTerminal()` — true for `Completed` and `Cancelled`.
5. `decimal.ToMoney(string currency)` — formatted with a currency symbol.
:::

::: solution
```csharp
public static class StringExtensions
{
    public static string Truncate(this string value, int max, string suffix = "…")
    {
        ArgumentNullException.ThrowIfNull(value);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(max);

        return value.Length <= max
            ? value
            : value[..Math.Max(0, max - suffix.Length)].TrimEnd() + suffix;
    }
}

public static class DateTimeExtensions
{
    public static string ToRelative(this DateTime utc) => (DateTime.UtcNow - utc) switch
    {
        { TotalSeconds: < 45 }  => "just now",
        { TotalMinutes: < 2 }   => "a minute ago",
        { TotalMinutes: < 60 } t => $"{(int)t.TotalMinutes} minutes ago",
        { TotalHours: < 2 }     => "an hour ago",
        { TotalHours: < 24 } t  => $"{(int)t.TotalHours} hours ago",
        { TotalDays: < 2 }      => "yesterday",
        { TotalDays: < 30 } t   => $"{(int)t.TotalDays} days ago",
        var t                   => $"{(int)(t.TotalDays / 30)} months ago"
    };
}
```

`value[..Math.Max(0, max - suffix.Length)]` is a **range expression** — `value[..n]` is "from the start up to n". `value[^1]` is the last character, `value[1..^1]` drops the first and last. Worth having in your fingers.

The switch expression over `TimeSpan` uses property patterns on a value type. Reading it as a table of ranges is exactly why pattern matching is worth learning.

On (3): `Enumerable.Chunk(size)` has shipped since .NET 6. Writing yours first and then finding the built-in one is a useful habit — **before writing a general-purpose helper, check whether the BCL already has it.** It usually does, and its version handles more edge cases than yours.
:::

::: challenge Level 3 · A fluent validation extension
Build a chainable validator using extension methods:

```csharp
var errors = new CreateTaskRequest("", null, "Inbox")
    .Check()
    .NotEmpty(r => r.Title, "Title is required")
    .MaxLength(r => r.Title, 200)
    .NotEmpty(r => r.ProjectName, "Project is required")
    .MaxLength(r => r.Description, 2000)   // must tolerate null
    .Errors;
```

Requirements:
- Works for any type, not just `CreateTaskRequest`.
- Collects **all** errors, not just the first.
- `MaxLength` on a null value passes rather than throwing.
- The error message names the property automatically when none is supplied. (Hint: `Expression<Func<T, string?>>`, or `[CallerArgumentExpression]`.)
:::

::: solution
```csharp
public sealed class Validation<T>(T value)
{
    private readonly List<string> _errors = [];
    public T Value { get; } = value;
    public IReadOnlyList<string> Errors => _errors;
    public bool IsValid => _errors.Count == 0;
    internal Validation<T> Fail(string message) { _errors.Add(message); return this; }
}

public static class ValidationExtensions
{
    public static Validation<T> Check<T>(this T value) => new(value);

    public static Validation<T> NotEmpty<T>(
        this Validation<T> v,
        Func<T, string?> selector,
        string? message = null,
        [CallerArgumentExpression(nameof(selector))] string? expr = null) =>
        string.IsNullOrWhiteSpace(selector(v.Value))
            ? v.Fail(message ?? $"{Name(expr)} is required.")
            : v;

    public static Validation<T> MaxLength<T>(
        this Validation<T> v,
        Func<T, string?> selector,
        int max,
        [CallerArgumentExpression(nameof(selector))] string? expr = null)
    {
        var value = selector(v.Value);
        return value is { Length: var len } && len > max
            ? v.Fail($"{Name(expr)} must be at most {max} characters.")
            : v;
    }

    // "r => r.Title"  ->  "Title"
    private static string Name(string? expr) =>
        expr?.Split('.').LastOrDefault()?.Trim() ?? "Value";
}
```

Key moves:
- **Every method returns `Validation<T>`**, which is what makes chaining work. A fluent API is just "return the thing you were given".
- **`[CallerArgumentExpression]`** gives you the literal source text of the argument at the call site, at compile time, for free. `Name` then extracts the property name from `"r => r.Title"`.
- `MaxLength` on null returns `v` unchanged, because "no value" is not "too long" — absence is `NotEmpty`'s job. Keeping rules orthogonal is what lets them compose.

In Phase 6 you replace this with FluentValidation, which is this idea taken to its conclusion. Having built a small one, you will understand what that library is doing rather than treating it as magic.
:::

::: project Give TaskFlow a query extension library
Create `Domain/TaskQueryExtensions.cs` with chainable filters over `IEnumerable<TaskItem>`:

`Open()`, `Completed()`, `WithStatus(status)`, `WithPriority(priority)`, `WithLabel(label)`, `AssignedTo(userId)`, `Unassigned()`, `DueBefore(date)`, `Overdue(today)`, `CreatedAfter(when)`.

Plus two terminal helpers: `MostUrgentFirst()` and `IReadOnlyList<TaskItem> ToReport()`.

Then rewrite the reporting code in `Program.cs` to use chains. Compare it with what you wrote in Phase 1, side by side, and put both in `DECISIONS.md`.

Commit. In Phase 7 you write the identical-looking extensions over `IQueryable<TaskItem>` and they become SQL — at which point the value of having designed the API this way becomes obvious.
:::

::: interview What is an extension method and when would you use one?
A static method in a static class whose first parameter is marked `this`, which the compiler lets you call with instance-method syntax. It does not modify the type — `x.Foo()` compiles to `Ext.Foo(x)`.

The primary use is adding behaviour to a type you cannot change: an interface, a BCL type, or a third-party class. LINQ is the canonical example — it adds fifty operators to `IEnumerable<T>` without breaking any existing implementation.

Worth adding: they cannot access private state, they are not polymorphic, an instance method with the same signature always wins, and they are only visible when their namespace is imported.
:::

::: checkpoint
- [ ] I wrote five extension methods on types I do not own
- [ ] I can explain why LINQ had to be extension methods
- [ ] I know the three rules for declaring one
- [ ] I used `[CallerArgumentExpression]` at least once
- [ ] TaskFlow has a chainable query extension library
:::

## Common mistakes

::: mistake
**Extending `object`.** `public static void Dump(this object o)` appears on every type in every file that imports the namespace. It pollutes IntelliSense for everyone.

**Using extensions to reach around encapsulation.** They cannot access private members, so what you actually get is an extension that reimplements logic using public state — a second source of truth. Put the method on the type if you own the type.

**Hiding expensive work behind property-like syntax.** `task.FullHistory()` that makes a database call reads as a cheap accessor. Name it so the cost is visible.

**Forgetting the `using`.** "The method exists but IntelliSense cannot see it" is nearly always a missing namespace import.
:::
