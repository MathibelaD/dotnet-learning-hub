---
title: Value types, structs and records
summary: class vs struct vs record — the decision you make every time you create a type, and how to make it on purpose.
minutes: 45
stage: Stage 1
---

## What are we learning?

C# gives you three ways to declare a data type, and picking the wrong one causes bugs that are very hard to see. The rules are simple once you separate two independent questions:

```text
Where does it live / how is it copied?   ->  value type (struct) or reference type (class)
How does it compare for equality?        ->  reference equality or value equality
```

`record` changes the second. `struct` changes the first. They are orthogonal — you can have all four combinations.

## Reference vs value, demonstrated

```csharp
class  PointClass  { public int X; }
struct PointStruct { public int X; }

var c1 = new PointClass  { X = 1 };
var c2 = c1;
c2.X = 99;
Console.WriteLine(c1.X);     // 99  — one object, two references

var s1 = new PointStruct { X = 1 };
var s2 = s1;
s2.X = 99;
Console.WriteLine(s1.X);     // 1   — assignment COPIED the whole value
```

A struct is copied on: assignment, passing to a method, returning, adding to a collection, and capturing. Every one of those is a full field-by-field copy.

## Equality, demonstrated

```csharp
class  TaskClass(string title)  { public string Title => title; }
record TaskRecord(string Title);

var a = new TaskClass("Ship");
var b = new TaskClass("Ship");
Console.WriteLine(a == b);    // False — different objects

var x = new TaskRecord("Ship");
var y = new TaskRecord("Ship");
Console.WriteLine(x == y);    // True  — same values
Console.WriteLine(x);         // TaskRecord { Title = Ship }
```

A `record` makes the compiler generate `Equals`, `GetHashCode`, `==`, `!=`, `ToString` and a `Deconstruct` method, all based on the members. Writing those five by hand correctly takes about forty lines and people get `GetHashCode` wrong constantly.

## Records in full

```csharp
// positional record — concise, immutable by default
public record TaskSummary(Guid Id, string Title, Priority Priority);

// with a body, for validation and extra members
public record Money(decimal Amount, string Currency)
{
    public Money
    {
        // 'init' accessors run this; throws before the object exists
        if (Amount < 0) throw new ArgumentOutOfRangeException(nameof(Amount));
    }

    public static Money Zero(string currency) => new(0, currency);
    public Money Plus(Money other) => other.Currency == Currency
        ? this with { Amount = Amount + other.Amount }
        : throw new InvalidOperationException("Currency mismatch");
}

// record struct — value semantics AND value equality
public readonly record struct TaskId(Guid Value);
```

### `with` expressions

```csharp
var original = new TaskSummary(id, "Write docs", Priority.Normal);
var promoted = original with { Priority = Priority.High };
// original is untouched; promoted is a new object with one field changed
```

This is *non-destructive mutation* and it is the main reason records feel good to work with. In Phase 6 every DTO you write will be a record for exactly this reason.

## Choosing

::: design The decision procedure
Ask in this order:

**1. Is this thing defined by its identity, or by its values?**
A `User` with the same name as another user is still a different user → identity → `class`.
A `DateRange(start, end)` with the same two dates is the *same range* → values → `record`.

**2. Will it be mutated after construction?**
Mutable → `class` (records can have `set` accessors but you are fighting the design).
Immutable → `record`.

**3. Is it small, short-lived, and allocated in enormous quantities?**
Only then consider `struct`. The guidance from Microsoft: under ~16 bytes, immutable, logically a single value, not boxed frequently.

Default answers that will serve you well:
- Domain entities with an `Id` → **class**
- DTOs, API request/response models, query results, events → **record**
- Value objects (`Money`, `EmailAddress`, `TaskId`) → **readonly record struct** if tiny, otherwise **record**
- Everything else → **class**

You will use `struct` perhaps three times in a normal application. That is correct. Do not go looking for reasons.
:::

::: warn The mutable struct trap
```csharp
struct Counter { public int Value; public void Increment() => Value++; }

var list = new List<Counter> { new() };
list[0].Increment();          // CS1612: cannot modify the return value
                              // because list[0] returns a COPY

var array = new Counter[1];
array[0].Increment();         // compiles! arrays give direct access — and this one works
```

Same-looking code, two different behaviours, one of which silently does nothing in older C# versions. This is why the rule is: **make structs `readonly`**. `readonly struct Counter` makes the compiler reject any mutating member, and the problem disappears.
:::

::: exercise Level 1 — Guided · Feel the difference
Create a scratch file with these four types and prove each behaviour with `Console.WriteLine`:

```csharp
class  CTask  { public string Title { get; set; } = ""; }
record RTask(string Title);
struct STask { public string Title { get; set; } }
readonly record struct RSTask(string Title);
```

For each, demonstrate:
1. What happens when you assign to a second variable and mutate it (where mutation is possible).
2. What `==` returns for two separately-created instances with the same title.
3. What `ToString()` prints.
4. What happens when you pass one to `void Mutate(X item)` and change it inside.

Make a four-by-four table of your results. Keep it — you will refer back to it.
:::

::: challenge Level 3 · Records are not deeply immutable
Predict the output, then run it.

```csharp
record Basket(string Owner, List<string> Items);

var a = new Basket("me", ["apple"]);
var b = a with { Owner = "you" };
b.Items.Add("pear");

Console.WriteLine(a.Items.Count);
Console.WriteLine(a == new Basket("me", ["apple", "pear"]));
```

Then fix the type so that neither surprise is possible.
:::

::: solution
Output:
```text
2
False
```

**First surprise:** `with` performs a *shallow* copy. `b.Items` and `a.Items` are the same `List<string>` object, so adding to one adds to both. Records give you immutable *references*, not immutable *graphs*.

**Second surprise:** record equality compares members with `EqualityComparer<T>.Default`. For `List<string>` that is reference equality — two different lists with identical contents are not equal. So even when the contents match, the records do not.

Fix — use an immutable collection whose equality you control, or expose a sequence and compare explicitly:

```csharp
using System.Collections.Immutable;

record Basket(string Owner, ImmutableList<string> Items)
{
    public virtual bool Equals(Basket? other) =>
        other is not null && Owner == other.Owner && Items.SequenceEqual(other.Items);

    public override int GetHashCode() =>
        Items.Aggregate(Owner.GetHashCode(), (h, i) => HashCode.Combine(h, i));
}
```

Note `public virtual bool Equals(Basket? other)` — that exact signature is what the compiler generates, so writing it yourself replaces it. If you override `Equals` you **must** override `GetHashCode` or you will get objects that are equal but land in different hash buckets, which breaks `Dictionary` and `HashSet` in ways that look like corruption.

`dotnet add package System.Collections.Immutable` is not needed — it ships in the shared framework.
:::

::: debug Level 4 · The dictionary that loses keys
```csharp
class TaskKey
{
    public Guid ProjectId { get; init; }
    public string Title { get; init; } = "";
}

var map = new Dictionary<TaskKey, int>();
map[new TaskKey { ProjectId = id, Title = "a" }] = 1;

var found = map.TryGetValue(new TaskKey { ProjectId = id, Title = "a" }, out var v);
Console.WriteLine(found);   // False. Why?
```
:::

::: solution
`TaskKey` is a `class` with no `Equals`/`GetHashCode` override, so it uses **reference equality**. The second `TaskKey` is a different object, so it hashes to a different bucket and compares unequal.

One-word fix:

```csharp
record TaskKey
{
    public Guid ProjectId { get; init; }
    public string Title { get; init; } = "";
}
```

`record` generates value-based `Equals` and `GetHashCode`, and the lookup works.

**This is the single most practical reason records exist.** Any type used as a dictionary key, a `HashSet` member, or compared with `.Distinct()` / `.Contains()` in LINQ needs value equality. You will hit this in Phase 3 the first time `Distinct()` returns duplicates.
:::

::: project Introduce value objects and DTOs to TaskFlow
Two additions:

**1. A value object.** Create `Domain/DateRange.cs` as a `readonly record struct` with `Start` and `End` (both `DateOnly`), which:
- throws in its constructor if `End < Start`
- exposes `int Days`
- exposes `bool Contains(DateOnly date)`
- exposes `bool Overlaps(DateRange other)`

**2. A projection type.** Create `Domain/TaskSummary.cs` as a positional `record` with `Id`, `Title`, `Priority` and `bool IsComplete`, plus a static `From(TaskItem task)`.

In `Program.cs`: build a few tasks, project them to summaries, put the summaries in a `HashSet<TaskSummary>` and prove that two identical summaries collapse to one. Commit.
:::

::: solution
```csharp
namespace TaskFlow.Domain;

public readonly record struct DateRange
{
    public DateOnly Start { get; }
    public DateOnly End { get; }

    public DateRange(DateOnly start, DateOnly end)
    {
        if (end < start)
            throw new ArgumentException("End must not be before start.", nameof(end));
        Start = start;
        End = end;
    }

    public int Days => End.DayNumber - Start.DayNumber + 1;
    public bool Contains(DateOnly date) => date >= Start && date <= End;
    public bool Overlaps(DateRange other) => Start <= other.End && other.Start <= End;
}
```

`readonly record struct` is the right call here: two dates is 8 bytes, it is logically one value, it is immutable, and comparing two ranges for equality should compare the dates.

Note the `Overlaps` condition — `Start <= other.End && other.Start <= End`. Write out two ranges on paper and check all six relative positions. Interval overlap is one of those things everyone gets wrong on the first attempt.

```csharp
public record TaskSummary(Guid Id, string Title, Priority Priority, bool IsComplete)
{
    public static TaskSummary From(TaskItem task) =>
        new(task.Id, task.Title, task.Priority, task.IsComplete);
}
```
:::

::: interview What is the difference between a class, a struct and a record?
`class` is a reference type: variables hold references, assignment copies the reference, equality defaults to reference identity, instances are heap-allocated and garbage collected.

`struct` is a value type: the data is stored inline (on the stack, or inside the containing object), assignment copies all fields, and equality is member-wise by default. Good for small immutable values; costly when large or when boxed.

`record` is not a third category — it is a *modifier* on a class (or on a struct, as `record struct`) that makes the compiler generate value-based `Equals`, `GetHashCode`, `==`, `ToString`, `Deconstruct` and a `with`-expression clone.

The follow-up to expect: "When would you use a struct?" Answer honestly — rarely. Small, immutable, single-value types allocated in bulk, where you have measured that heap allocation is a problem.
:::

::: checkpoint
- [ ] I built the four-by-four comparison table myself
- [ ] I can state the decision procedure for class vs record vs struct
- [ ] I understand why `with` is a shallow copy
- [ ] I fixed the dictionary-losing-keys bug and know why records solve it
- [ ] TaskFlow has a `DateRange` value object and a `TaskSummary` record
:::

## Common mistakes

::: mistake
**Making everything a record because it is shorter.** Entities with identity and a lifecycle — `User`, `Order`, `TaskItem` — should be classes. Two users named "Sam" are not the same user, and record equality would say they are.

**Mutable structs.** Always `readonly struct` unless you have a specific, measured reason.

**Using a class as a dictionary key without overriding equality.** Silent lookup failures.

**Assuming `record` means immutable.** `record Foo { public string Bar { get; set; } }` is a perfectly mutable record. Positional records are immutable because their generated properties are `init`-only, not because `record` implies immutability.
:::
