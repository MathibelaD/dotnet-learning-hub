---
title: Value types, boxing and performance
summary: The hidden allocations that come from treating a value type as an object.
minutes: 35
---

## What are we learning?

Boxing: what it is, where it happens invisibly, and how to see it and remove it.

## Boxing

```csharp
int number = 42;              // 4 bytes, on the stack
object boxed = number;        // heap allocation: header + type pointer + 4 bytes ≈ 24 bytes
int unboxed = (int)boxed;     // copied back out
```

Boxing wraps a value type in a heap object. It costs an allocation, a copy, and later a GC. Unboxing costs a type check and a copy.

24 bytes for a 4-byte integer, and worse: that object must later be collected.

## Where it happens without you noticing

```csharp
// 1. Assigning to object or a non-generic interface
object o = 42;
IComparable c = 42;

// 2. Non-generic collections (rare now, but they exist in old code)
var list = new ArrayList();
list.Add(42);                                  // boxed

// 3. String formatting with object parameters
string.Format("{0}", 42);                      // boxed
Console.WriteLine("Value: " + 42);             // boxed for ToString via object

// 4. Calling an interface method on a struct through the interface
IEnumerator<int> e = list.GetEnumerator();     // struct enumerator boxed

// 5. LINQ over value types — enumerators and delegates
numbers.Where(n => n > 5);                     // enumerator boxed into IEnumerable

// 6. An unconstrained generic that compares to null or uses object members
void Log<T>(T value) => Console.WriteLine(value);   // boxes if T is a struct

// 7. Nullable value types in some conversions
int? maybe = 42;
object o2 = maybe;                             // boxes the int, not the Nullable<int>
```

::: warn The one that surprises everyone: `Equals` and `GetHashCode` on a struct
```csharp
public struct Point { public int X, Y; }

var a = new Point { X = 1, Y = 2 };
var b = new Point { X = 1, Y = 2 };
Console.WriteLine(a.Equals(b));      // true — but it BOXES and uses reflection
```

`ValueType.Equals` has no way to know your fields, so the default implementation reflects over them and boxes each one. For a struct used as a dictionary key that is catastrophic: every lookup allocates and reflects.

The fix is to implement `IEquatable<T>`:
```csharp
public readonly struct Point(int x, int y) : IEquatable<Point>
{
    public int X { get; } = x;
    public int Y { get; } = y;

    public bool Equals(Point other) => X == other.X && Y == other.Y;
    public override bool Equals(object? obj) => obj is Point p && Equals(p);
    public override int GetHashCode() => HashCode.Combine(X, Y);
    public static bool operator ==(Point a, Point b) => a.Equals(b);
    public static bool operator !=(Point a, Point b) => !a.Equals(b);
}
```

Or — far simpler — use `readonly record struct`, which the compiler generates all of this for, correctly:
```csharp
public readonly record struct Point(int X, int Y);
```

That is the practical advice: **every struct you write should be a `readonly record struct` unless you have a reason otherwise.** The Phase 1 guidance, with its performance reason now visible.
:::

## Generic constraints prevent boxing

```csharp
// boxes when T is a struct
void Process<T>(T value) => Console.WriteLine(value.ToString());

// does not box — the constraint lets the JIT call the struct's method directly
void Process<T>(T value) where T : IFormattable =>
    Console.WriteLine(value.ToString(null, CultureInfo.InvariantCulture));
```

Generics over value types are specialised by the JIT: `List<int>` stores real `int`s with no boxing, unlike Java's `List<Integer>`. That is the reification point from Phase 1 paying off — but only if you do not force the value through `object` or a non-generic interface.

## Seeing boxing

```bash
# see the IL — 'box' instructions are explicit
dotnet tool install -g dotnet-ildasm
```

Or read it online with sharplab.io, which shows the IL and the lowered C# side by side. `box` in the IL is an allocation.

The `[MemoryDiagnoser]` attribute in BenchmarkDotNet will show it as allocated bytes where you expected zero.

## Struct copying — the other cost

```csharp
public readonly struct LargeValue
{
    public readonly Guid A, B, C, D, E, F, G, H;      // 128 bytes
}

void Process(LargeValue value) { }                    // copies 128 bytes per call
void Process(in LargeValue value) { }                 // passes a reference, read-only
```

A struct is copied on assignment, on being passed, on being returned and on being read from a collection. For anything over about 16–24 bytes that copying can exceed the cost of an allocation you were trying to avoid.

`in` passes by reference without allowing mutation — worth it for large readonly structs, pointless for small ones where the copy is one register move.

::: design Class or struct, with the performance reasoning
Microsoft's guidance, and it holds up:

**Use a struct when all of these are true:**
- It logically represents a single value.
- It is under about 16 bytes.
- It is immutable.
- It will not be boxed frequently.

**Otherwise use a class.**

Applied to TaskFlow:
- `TaskId(Guid)` — 16 bytes, one value, immutable → `readonly record struct` ✅
- `DateRange(DateOnly, DateOnly)` — 8 bytes → `readonly record struct` ✅
- `Money(decimal, string)` — contains a reference (the string), so it is not really a pure value; 24 bytes → either works; `record` is fine
- `TaskItem` — mutable, has identity, large → `class` ✅
- `TaskSummary` with ten properties — too large → `record` (class) ✅

**The honest summary: you will rarely write a struct, and that is correct.** The wins are real but narrow, and a wrongly-chosen struct — mutable, or large, or boxed in a loop — is slower than the class would have been.
:::

::: exercise Level 1 — Guided · Find the boxing
1. Write a struct without `IEquatable<T>`, put a million of them in a `HashSet<T>`, and benchmark with `[MemoryDiagnoser]`.
2. Add `IEquatable<T>` and benchmark again. Record both.
3. Replace it with a `readonly record struct` and benchmark a third time.
4. Paste each version into sharplab.io and find the `box` instructions.
5. Benchmark passing a 128-byte struct by value versus `in`, ten million times.
6. Benchmark `string.Format("{0}", 42)` against `$"{42}"` against `42.ToString()`.
7. Write a generic method that boxes, then fix it with a constraint. Confirm in the IL.
:::

::: solution
`HashSet<Point>` with one million lookups:

```text
| Method                    |        Mean | Allocated |
|-------------------------- |------------:|----------:|
| Struct_NoIEquatable       | 1,240.00 ms |  48.00 MB |
| Struct_WithIEquatable     |     8.20 ms |       0 B |
| ReadonlyRecordStruct      |     8.10 ms |       0 B |
```

**150× faster and 48 MB less allocated**, from implementing one interface. The default `ValueType.Equals` reflects over fields and boxes each one, per comparison — and a hash set does several comparisons per lookup.

This is the most dramatic single-interface performance difference in .NET, and it is invisible in the source. The code looks identical; one version is 150 times slower.

`in` versus by value for a 128-byte struct, ten million calls:
```text
| ByValue |  38.00 ms |
| ByIn    |   4.10 ms |
```
Roughly 9×, purely from not copying 128 bytes per call. For an 8-byte struct the difference is nil — the copy is a single register move and `in` adds a dereference.

String formatting, ten million iterations:
```text
| StringFormat     | 620.00 ms | 640 MB |   boxes, parses the format string
| Interpolation    | 180.00 ms | 240 MB |   uses the interpolated handler, no boxing
| ToString         | 145.00 ms | 240 MB |
```
The 240 MB in the last two is the result strings themselves, which you asked for. The extra 400 MB in `string.Format` is boxing plus format-string parsing.

Note this does **not** contradict the Phase 5 logging advice. `logger.LogInformation($"...")` is bad not because of allocation but because it destroys the structured data. `logger.LogInformation("{TaskId}", id)` does box the `id` into an `object[]` — and `[LoggerMessage]` source generation removes even that, which is why it exists.
:::

::: challenge Level 3 · Optimise a hot path, with evidence
Find the hottest allocation path in TaskFlow — likely search-result mapping or export formatting — and remove the avoidable allocations.

Requirements:
1. Profile first; identify the top three allocation sources with real numbers.
2. Fix them in order of impact.
3. For each fix, record time and allocation before and after.
4. Change nothing where the measurement says it does not matter.
5. Confirm behaviour is unchanged — all tests still pass.
6. Write up what you changed, what you deliberately did not, and why.

Point 4 is the requirement being graded. Restraint backed by measurement is the skill.
:::

::: solution
Typical findings for a search endpoint returning 20 results:

**1. Enum `ToString()` in mapping — 40% of the allocation.**
```csharp
Status = task.Status.ToString(),          // allocates a string per row, every time
```
Enum `ToString` goes through reflection over the enum's names. Fix with a cached lookup:
```csharp
private static readonly FrozenDictionary<TaskStatus, string> StatusNames =
    Enum.GetValues<TaskStatus>().ToFrozenDictionary(s => s, s => s.ToString());
```
`FrozenDictionary` (.NET 8) is optimised for a fixed set built once and read many times — faster lookups than `Dictionary` at the cost of slower construction, which is exactly this shape.

**2. LINQ chains in the mapping loop — 25%.** Each `Where`/`Select` allocates an enumerator and a closure. For 20 items that is 40 small allocations to avoid a `for` loop. Fix only if this is genuinely hot — and for 20 items per request, **it is not**. Measure the endpoint, not the microbenchmark.

**3. String interpolation for the ETag — 15%.** `$"\"{task.Version}\""` per row. Fix with `TryFormat` into a pooled buffer, or accept it.

**What to actually change:** number 1, because it is a one-line fix with no readability cost and it applies everywhere. Leave 2 and 3 alone: they total a few hundred bytes per request against a 2ms database query, and the fixes make the code worse.

**The write-up is the deliverable:**
> "Profiling showed enum `ToString()` accounting for 40% of allocation on the search path — 1.2KB per request across 20 rows. Replaced with a `FrozenDictionary` cache: allocation on that path fell from 3.1KB to 1.9KB per request, end-to-end latency unchanged at 2.1ms because the endpoint is database-bound. I left the LINQ enumerators and the ETag interpolation alone; together they are under 400 bytes per request and removing them would mean hand-rolled loops for no measurable gain."

That paragraph demonstrates more engineering judgement than any amount of optimisation would.
:::

::: project Measure TaskFlow's allocations
1. Every struct in TaskFlow is a `readonly record struct`, or has a written reason not to be.
2. `[MemoryDiagnoser]` benchmarks for search, export and import.
3. Fix the top allocation source only.
4. Record before and after for every change.
5. `DECISIONS.md`: what you changed, what you left, and the measurements behind both.

Commit.
:::

::: interview What is boxing and why does it matter?
Boxing is wrapping a value type in a heap-allocated object so it can be treated as `object` or as a non-generic interface. It costs an allocation, a copy, and eventually a garbage collection — about 24 bytes for a 4-byte integer.

It happens in places that are not obvious: assigning to `object`, `string.Format` with value-type arguments, calling an interface method on a struct through the interface, and unconstrained generic methods that use `object` members.

The one worth knowing is struct equality. A struct that does not implement `IEquatable<T>` falls back to `ValueType.Equals`, which reflects over the fields and boxes each one — I measured a `HashSet` of one million structs going from 1.2 seconds and 48MB to 8 milliseconds and zero allocation just by implementing the interface. The practical advice is to declare structs as `readonly record struct`, which makes the compiler generate all of it correctly.

Generics avoid boxing because .NET reifies type arguments — `List<int>` stores real integers — so the fix is usually a generic constraint rather than a cast.
:::

::: checkpoint
- [ ] I measured the `IEquatable<T>` difference myself
- [ ] I found `box` instructions in the IL
- [ ] Every struct I write is a `readonly record struct`
- [ ] I know when `in` helps and when it does not
- [ ] I optimised only what I measured, and wrote down what I left alone
:::

## Common mistakes

::: mistake
**A struct without `IEquatable<T>` used as a dictionary key.** 150× slower, invisibly.

**Mutable structs.** Copies mean mutations go to the wrong object.

**Large structs passed by value in a hot loop.** The copy exceeds what an allocation would have cost.

**`string.Format` with value types in a hot path.** Boxing plus format parsing.

**Optimising a microbenchmark rather than the endpoint.** 40 enumerator allocations are irrelevant next to a database round trip.
:::
