---
title: Delegates and lambdas
summary: Passing behaviour as a value — the foundation under LINQ, events, DI and every callback you will write.
minutes: 40
stage: Stage 1
---

## What are we learning?

Delegates: type-safe function pointers. You have used lambdas in other languages; what you need here is the C# type system around them, because it explains LINQ, events and most of ASP.NET Core's configuration API.

## A delegate is a type

```csharp
public delegate bool TaskFilter(TaskItem task);       // declares a TYPE

TaskFilter isUrgent = task => task.Priority == Priority.Urgent;
bool result = isUrgent(someTask);
```

`TaskFilter` is a type whose values are methods taking a `TaskItem` and returning `bool`. Anything with that signature can be assigned to it.

In practice you almost never declare your own delegate type, because .NET ships three generic families that cover everything:

```csharp
Func<TaskItem, bool>        predicate;   // takes TaskItem, returns bool
Func<int>                   supplier;    // takes nothing, returns int
Func<int, string, bool>     two;         // last type parameter is ALWAYS the return type
Action<TaskItem>            handler;     // takes TaskItem, returns void
Action                      nothing;     // takes nothing, returns void
Predicate<TaskItem>         legacy;      // same as Func<TaskItem, bool>; older APIs use it
```

`Func<,,,>` goes up to 16 parameters. If you need more, you need a class.

## Four ways to produce one

```csharp
// 1. Lambda expression — the default
Func<TaskItem, bool> a = t => t.IsComplete;

// 2. Lambda with a block body
Func<TaskItem, bool> b = t =>
{
    var age = DateTime.UtcNow - t.CreatedAt;
    return t.IsComplete && age.TotalDays < 7;
};

// 3. Method group — no lambda at all
static bool IsDone(TaskItem t) => t.IsComplete;
Func<TaskItem, bool> c = IsDone;          // note: no parentheses

// 4. Local function, then method group
bool Recent(TaskItem t) => t.CreatedAt > cutoff;
Func<TaskItem, bool> d = Recent;
```

Method group conversion (3) is worth knowing: `tasks.Where(IsDone)` reads better than `tasks.Where(t => IsDone(t))` and allocates less.

## Closures

A lambda can capture variables from the enclosing scope.

```csharp
var cutoff = DateTime.UtcNow.AddDays(-7);
Func<TaskItem, bool> recent = t => t.CreatedAt > cutoff;   // 'cutoff' is captured
```

The compiler generates a hidden class holding the captured variables, and the lambda becomes a method on it. Two consequences:

1. **Capturing allocates.** In a hot loop this matters (Phase 13).
2. **Capture is by reference, not by value.** This is the source of a classic bug:

::: predict What does this print?
```csharp
var actions = new List<Action>();
for (int i = 0; i < 3; i++)
    actions.Add(() => Console.Write(i));

foreach (var a in actions) a();
```
And what about this version?
```csharp
var actions = new List<Action>();
foreach (var t in new[] { "a", "b", "c" })
    actions.Add(() => Console.Write(t));

foreach (var a in actions) a();
```
:::

::: solution
The first prints `333`. The second prints `abc`.

In the `for` loop, `i` is **one variable** for the entire loop. All three lambdas capture that same variable, and by the time they run, it holds 3.

In the `foreach` loop, `t` is a **fresh variable per iteration** — the C# team changed this in C# 5 precisely because the old behaviour caused so many bugs. So each lambda captures a different variable.

Fix for the `for` loop: copy into a loop-local variable.
```csharp
for (int i = 0; i < 3; i++)
{
    var copy = i;
    actions.Add(() => Console.Write(copy));   // 012
}
```

This bites people in real code whenever callbacks are registered in a loop — event handlers, timers, background tasks. If a set of callbacks all behave as if they got the last value, this is why.
:::

## Multicast delegates

```csharp
Action<string> log = m => Console.WriteLine($"console: {m}");
log += m => File.AppendAllText("log.txt", m);    // now two subscribers
log("hello");                                    // both run, in order
log -= someHandler;                              // removes ONE matching subscriber
```

Every delegate is multicast — `+=` and `-=` build an invocation list. This is the mechanism `event` is built on, which is the next lesson.

::: warn Two gotchas with multicast
1. **Only the last return value survives.** `Func<int> f = A; f += B; f();` returns B's result and silently discards A's. Multicast is really for `Action`.
2. **An exception in one subscriber stops the rest.** If the first handler throws, handlers two and three never run. If that matters, invoke the list manually:
```csharp
foreach (Action<string> handler in log.GetInvocationList())
{
    try { handler(m); } catch (Exception ex) { /* log and continue */ }
}
```
:::

## Where you will actually meet delegates

```csharp
tasks.Where(t => t.IsOpen)                        // Func<TaskItem, bool>        — Phase 3
services.AddScoped<ITaskStore>(sp => new Store()) // Func<IServiceProvider, T>  — Phase 5
app.Use(async (ctx, next) => { await next(); })   // middleware                  — Phase 6
options.Configure(o => o.Timeout = 30)            // Action<TOptions>            — Phase 5
builder.HasQueryFilter(t => !t.IsDeleted)         // Expression<Func<T, bool>>   — Phase 7
```

That last one is **not** a delegate — `Expression<Func<T, bool>>` is a data structure describing the lambda, which EF Core translates to SQL. Same syntax, completely different mechanism. Phase 13 pulls it apart.

::: exercise Level 1 — Guided · Build a filter pipeline
1. Write `IReadOnlyList<TaskItem> Filter(IEnumerable<TaskItem> tasks, Func<TaskItem, bool> predicate)` **with a loop** — no LINQ.
2. Call it with three different lambdas: open tasks, urgent tasks, tasks with a due date in the past.
3. Write `Func<TaskItem, bool> And(Func<TaskItem, bool> a, Func<TaskItem, bool> b)` that combines two predicates.
4. Use it: `Filter(tasks, And(IsOpen, IsUrgent))`.
5. Now write `Func<TaskItem, bool> All(params Func<TaskItem, bool>[] predicates)` that combines any number.
:::

::: solution
```csharp
static Func<TaskItem, bool> And(Func<TaskItem, bool> a, Func<TaskItem, bool> b) =>
    t => a(t) && b(t);

static Func<TaskItem, bool> All(params Func<TaskItem, bool>[] predicates) =>
    t => predicates.All(p => p(t));

static Func<TaskItem, bool> Any(params Func<TaskItem, bool>[] predicates) =>
    t => predicates.Any(p => p(t));
```

Notice what `And` is: a function that takes two functions and returns a function. That is the whole idea behind composable query builders, middleware pipelines and validation chains — all three appear later in this course, and all three are this same three-line shape.

`All` with an empty array returns `true` for everything, which is exactly right: "match all of no conditions" is "match everything". Getting that edge case right for free is a sign the abstraction fits.
:::

::: challenge Level 3 · A retry helper
Write:

```csharp
static T Retry<T>(Func<T> operation, int maxAttempts = 3, Action<int, Exception>? onRetry = null)
```

Requirements:
- Call `operation`. If it throws, wait and try again, up to `maxAttempts`.
- Back off: attempt 1 waits 100ms, attempt 2 waits 200ms, attempt 3 waits 400ms.
- Call `onRetry(attemptNumber, exception)` before each retry, if supplied.
- After the last failure, rethrow the **original** exception with its stack trace intact.
- Do not retry `ArgumentException` or any of its subclasses — those are bugs, not transient failures.

Test it with an operation that fails twice then succeeds.
:::

::: solution
```csharp
static T Retry<T>(Func<T> operation, int maxAttempts = 3, Action<int, Exception>? onRetry = null)
{
    ArgumentOutOfRangeException.ThrowIfLessThan(maxAttempts, 1);

    for (var attempt = 1; ; attempt++)
    {
        try
        {
            return operation();
        }
        catch (ArgumentException)
        {
            throw;                                  // a bug: never retry
        }
        catch (Exception ex) when (attempt < maxAttempts)
        {
            onRetry?.Invoke(attempt, ex);
            Thread.Sleep(100 * (int)Math.Pow(2, attempt - 1));
        }
    }
}
```

Three details that matter:

- **`when (attempt < maxAttempts)`** is an exception filter. On the final attempt the filter is false, so the catch is not entered at all and the exception propagates with its original stack trace. That is cleaner than catching and calling `throw;`, and — importantly — an exception filter runs *before* the stack unwinds, so a debugger breaks at the original throw site.
- **`onRetry?.Invoke(...)`** — the null-conditional call. `onRetry(attempt, ex)` would throw if the caller passed nothing.
- **`Thread.Sleep` is wrong in real code.** It blocks a thread. Phase 4 rewrites this with `await Task.Delay`, and Phase 14 replaces the whole thing with Polly, which does this properly including jitter.
:::

::: project Make TaskFlow's queries composable
Replace your hand-written `ByStatus` / `ByLabel` / `Overdue` methods with:

```csharp
IReadOnlyList<TaskItem> Find(Func<TaskItem, bool> predicate);
```

and a static class of reusable predicates:

```csharp
public static class TaskFilters
{
    public static Func<TaskItem, bool> Open => t => t.IsOpen;
    public static Func<TaskItem, bool> WithStatus(TaskStatus status) => t => t.Status == status;
    public static Func<TaskItem, bool> WithLabel(string label) =>
        t => t.Labels.Contains(label, StringComparer.OrdinalIgnoreCase);
    public static Func<TaskItem, bool> OverdueOn(DateOnly today) => t => t.IsOverdue(today);
    public static Func<TaskItem, bool> AssignedTo(Guid userId) => t => t.AssigneeId == userId;

    public static Func<TaskItem, bool> All(params Func<TaskItem, bool>[] filters) =>
        t => filters.All(f => f(t));
}
```

Then in `Program.cs`:

```csharp
var urgentOverdue = store.Find(TaskFilters.All(
    TaskFilters.Open,
    TaskFilters.OverdueOn(DateOnly.FromDateTime(DateTime.UtcNow)),
    TaskFilters.WithStatus(TaskStatus.InProgress)));
```

Commit. Note how much less code the store now contains — every future query is a composition rather than a new method. In Phase 7 this exact pattern reappears as `Expression<Func<T, bool>>` and runs as SQL.
:::

::: interview What is a delegate?
A type-safe reference to a method. Declaring a delegate declares a *type*; a value of that type holds a target method (and, for instance methods, the object it applies to). Delegates are multicast — they hold an invocation list, which is what `event` is built on.

In practice you use the built-in generic delegates `Func<...>` and `Action<...>` rather than declaring your own. The reason delegates matter is that they let you pass behaviour as data: LINQ operators take them, dependency injection factories take them, ASP.NET Core middleware is a chain of them.

A good follow-up to offer: a lambda that captures a variable produces a closure — the compiler generates a class holding the captured variables, so capturing allocates and captures are by reference, not by value.
:::

::: checkpoint
- [ ] I can write `Func` and `Action` signatures without checking which position is the return type
- [ ] I predicted the `for` vs `foreach` closure output correctly, or learned why not
- [ ] I wrote a function that takes functions and returns a function
- [ ] I used an exception filter to avoid a `throw;`
- [ ] TaskFlow's store has one `Find` method and a composable filter library
:::

## Common mistakes

::: mistake
**Capturing a `for` loop variable in a callback.** All callbacks see the final value. Copy into a loop-local first.

**`Func<int, string>` confusion.** The last type argument is the return type, always. `Func<int, string>` takes an `int` and returns a `string`.

**Forgetting a delegate can be null.** `handler(x)` throws if nobody assigned it. `handler?.Invoke(x)`.

**Using multicast with `Func`.** Every return value but the last is silently thrown away.
:::
