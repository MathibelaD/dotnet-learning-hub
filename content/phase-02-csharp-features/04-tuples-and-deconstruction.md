---
title: Tuples and deconstruction
summary: Returning more than one value without inventing a class, and taking things apart in one line.
minutes: 25
stage: Stage 1
---

## What are we learning?

Value tuples, named elements, deconstruction, and the line where a tuple should become a real type.

## Value tuples

```csharp
(int count, decimal total) Summarise(IEnumerable<TaskItem> tasks)
{
    var list = tasks.ToList();
    return (list.Count, list.Sum(t => t.EstimatedHours));
}

var result = Summarise(tasks);
Console.WriteLine($"{result.count} tasks, {result.total} hours");

// or deconstruct straight away
var (count, total) = Summarise(tasks);
```

Facts worth knowing:

- `(int, decimal)` is `System.ValueTuple<int, decimal>` — a **struct**, so no heap allocation.
- Element names are compile-time only. At runtime the fields are `Item1`, `Item2`. Reflection and serialisation see the latter.
- Tuples have value equality: `(1, "a") == (1, "a")` is `true`.
- Do **not** confuse with `System.Tuple<...>` (with a capital T), the old reference-type version with only `Item1`-style names. Avoid it.

## Deconstruction

```csharp
var (id, title, priority) = taskSummary;            // any type with a Deconstruct method
var (_, title2, _) = taskSummary;                   // discard what you do not need
foreach (var (key, value) in dictionary) { }        // KeyValuePair deconstructs
var (min, max) = (numbers.Min(), numbers.Max());
(a, b) = (b, a);                                    // swap, no temp variable
```

Records get `Deconstruct` for free if they are positional. For anything else, write one:

```csharp
public class TaskItem
{
    public void Deconstruct(out Guid id, out string title, out TaskStatus status) =>
        (id, title, status) = (Id, Title, Status);
}
```

Note the body: that is a tuple assignment deconstructing into three `out` parameters in one line.

## Where tuples are genuinely right

```csharp
// 1. A private helper returning two things
private static (bool ok, string? error) TryParseFilter(string input) { ... }

// 2. Grouping in LINQ by more than one key
var byProjectAndStatus = tasks.GroupBy(t => (t.ProjectId, t.Status));

// 3. A dictionary keyed by a pair
var counts = new Dictionary<(Guid ProjectId, TaskStatus Status), int>();

// 4. Switching on several values at once
var result = (status, priority) switch { ... };

// 5. Swapping and multiple assignment
(first, second) = (second, first);
```

Cases 2 and 3 are the ones you will use most. A tuple has value equality and a sensible hash code built in, so it works correctly as a dictionary key or a `GroupBy` key with no extra work — which is exactly the problem records solve for larger shapes.

::: design When a tuple should become a record
Use a tuple when the grouping is **local and temporary**: inside one method, or between a private helper and its single caller.

Switch to a `record` as soon as any of these is true:
- It crosses a public API boundary.
- It is returned from more than one place.
- Someone reading the call site cannot tell what the elements mean.
- It needs validation, a method, or a meaningful name.
- It will be serialised — tuple element names do not survive.

```csharp
// fine — private, one caller, obvious
private (int open, int done) Tally() => ...

// not fine — public, three elements, will grow
public (string, decimal, DateTime, bool) GetInvoice(Guid id)

// do this instead
public record Invoice(string Reference, decimal Total, DateTime IssuedAt, bool Paid);
```

The test: read the call site out loud. `var (a, b, c, d) = GetInvoice(id);` tells the reader nothing.
:::

::: predict What does this print?
```csharp
var a = (Name: "task", Count: 3);
var b = (Label: "task", Total: 3);
Console.WriteLine(a == b);
Console.WriteLine(a.Equals(b));

object boxed = a;
Console.WriteLine(boxed.ToString());
```
:::

::: solution
```text
True
True
(task, 3)
```

Element names are **not part of the type**. `(Name: string, Count: int)` and `(Label: string, Total: int)` are both `ValueTuple<string, int>`, so they compare equal when their values match. The names exist only in your source code and in metadata for IntelliSense.

That is the core reason not to use tuples across public boundaries: the names — the only thing making the code readable — are the part that does not survive. `ToString()` confirms it, printing positions with no names at all.
:::

::: exercise Level 1 — Guided · Use tuples properly
1. Write `(int open, int completed, int overdue) Tally(IEnumerable<TaskItem> tasks, DateOnly today)` with a single pass — one loop, no LINQ, no three separate counts.
2. Call it and deconstruct the result.
3. Write `TryParsePriority(string input, out Priority priority)` the classic way, then write a tuple version `(bool ok, Priority value) ParsePriority(string input)`. Decide which you prefer and why.
4. Build a `Dictionary<(Guid ProjectId, TaskStatus Status), int>` of counts and fill it in one loop.
5. Add a `Deconstruct` to `TaskItem` and use `var (id, title, status) = task;`.
:::

::: challenge Level 3 · Refactor a tuple that grew up
This signature exists in a codebase and is used in eleven places:

```csharp
public static (bool success, TaskItem? task, string? error, int statusCode) TryCreate(
    string title, string? description, Guid projectId, Guid? assigneeId)
```

Requirements:
1. Explain in writing what is wrong with it — at least three distinct problems.
2. Replace it with a design that fixes all of them.
3. Your replacement must make the "success with an error message" and "failure with a task" combinations **impossible to represent**, not merely discouraged.
:::

::: solution
Problems:
1. **Four elements, and the meanings are positional.** `var (a, b, c, d) = TryCreate(...)` at a call site is unreadable.
2. **Illegal states are representable.** `(true, null, "boom", 500)` compiles. Nothing prevents success with an error, or failure with a task.
3. **`statusCode` is an HTTP concern leaking into a domain method.** The domain should not know what a 400 is.
4. **Four parameters of which two are `Guid`-ish.** `TryCreate(title, description, assigneeId, projectId)` compiles with the last two swapped. Nothing catches it.

A design that fixes all four:

```csharp
public abstract record CreateTaskResult
{
    public sealed record Created(TaskItem Task) : CreateTaskResult;
    public sealed record Invalid(IReadOnlyList<string> Errors) : CreateTaskResult;
    public sealed record ProjectNotFound(Guid ProjectId) : CreateTaskResult;

    private CreateTaskResult() { }     // no outside subclasses — the set is closed
}

public static CreateTaskResult Create(CreateTaskCommand command) { ... }
```

Call sites:

```csharp
return service.Create(command) switch
{
    CreateTaskResult.Created c        => Results.Created($"/tasks/{c.Task.Id}", Map(c.Task)),
    CreateTaskResult.Invalid i        => Results.ValidationProblem(ToDictionary(i.Errors)),
    CreateTaskResult.ProjectNotFound  => Results.NotFound(),
    _ => throw new UnreachableException()
};
```

What this buys you:
- Each case carries exactly the data that case has, and nothing else. `(true, null, "boom")` cannot be written.
- The private constructor closes the hierarchy, so the compiler can reason about exhaustiveness.
- HTTP status codes live in the API layer, where they belong. The domain says *what happened*; the API decides *how to express it*.
- `CreateTaskCommand` as a single parameter object removes the swapped-argument bug.

This shape — an abstract record with nested sealed records, matched with a switch expression — is a **discriminated union** done with the tools C# currently has. It is worth recognising; you will meet it in well-written .NET codebases and you will use it in Phase 6.
:::

::: project Use tuples where they fit in TaskFlow
1. Add `(int open, int inProgress, int blocked, int completed, int cancelled) CountByStatus()` to your store, computed in a single pass.
2. Add `IReadOnlyDictionary<(Guid ProjectId, TaskStatus Status), int> CrossTab()` — counts per project per status.
3. Add a `Deconstruct` to `TaskSummary` if it is not positional already.
4. Then find one place where you used a tuple and **should** have used a record, and change it. Note it in `DECISIONS.md`.

Commit.
:::

::: interview When would you use a tuple instead of a class?
For a small, local grouping of values that does not deserve a name: a private helper returning two things, a compound key for a dictionary or `GroupBy`, or a multiple assignment. Value tuples are structs, so they do not allocate, and they have built-in value equality and hashing, which is what makes them good compound keys.

The limit to state: element names are compile-time only — at runtime they are `Item1`, `Item2` — so they do not survive serialisation or reflection, and they do not make a public API readable. Once a tuple crosses a public boundary, is returned from several places, or grows past two or three elements, it should be a record.
:::

::: checkpoint
- [ ] I know that tuple element names are erased at runtime
- [ ] I wrote a single-pass tally returning a named tuple
- [ ] I used a tuple as a dictionary key and as a `GroupBy` key
- [ ] I can state four problems with the four-element result tuple
- [ ] I have seen the discriminated-union shape and understand what it prevents
:::

## Common mistakes

::: mistake
**Public APIs returning tuples of three or more elements.** Unreadable at the call site, and the names vanish in serialisation.

**Using `System.Tuple` instead of `ValueTuple`.** The capital-T version is a class (allocates) with `Item1`-only names. Nothing needs it in new code.

**Returning `(bool, T?)` instead of using the `Try` pattern.** `TryGet(key, out var value)` is the established .NET convention and works with `[NotNullWhen(true)]` so the compiler's null analysis follows it. A tuple does not.

**Tuples that encode illegal combinations.** If `(true, null, "error")` can be constructed, someone will construct it.
:::
