---
title: Span&lt;T&gt;, Memory&lt;T&gt; and allocation-free code
summary: Working with slices of memory without copying — and an honest view of when it matters.
minutes: 40
---

## What are we learning?

`Span<T>`, `ReadOnlySpan<T>`, `Memory<T>` and the allocation-free string and buffer techniques they enable.

## The problem

```csharp
var csv = "3f2a,Fix the bug,Urgent,2026-09-20";
var parts = csv.Split(',');          // allocates: a string[] AND four strings
var id = parts[0];
var title = parts[1];
```

Five allocations to read a line. For one line that is irrelevant. For a million-line import it is five million allocations and significant GC pressure.

```csharp
ReadOnlySpan<char> line = csv;
var comma = line.IndexOf(',');
var id = line[..comma];                       // a VIEW — zero allocations
line = line[(comma + 1)..];
```

## What a `Span<T>` is

A `ref struct` holding a pointer and a length: a **window onto memory you already have**. Slicing does not copy; it adjusts the pointer and the length.

It works over anything contiguous:

```csharp
Span<byte> fromArray = new byte[1024];
Span<char> fromString = stackalloc char[64];       // stack-allocated, no heap at all
ReadOnlySpan<char> fromLiteral = "hello";
Span<int> fromList = CollectionsMarshal.AsSpan(list);
```

::: warn `Span<T>` is a `ref struct`, with hard restrictions
The compiler enforces that a span can never outlive the memory it points at. Consequently a `Span<T>`:

- **cannot be a field of a class** (only of another `ref struct`)
- **cannot be boxed** or stored in `object`
- **cannot be captured by a lambda**
- **cannot be used in an `async` method** across an `await`
- **cannot be a generic type argument** (`List<Span<char>>` is illegal)

That last group is what `Memory<T>` exists for: it is the heap-safe equivalent that *can* live in a field and cross an `await`, and you call `.Span` on it to get a span for the synchronous part of the work.

```csharp
public async Task ProcessAsync(Memory<byte> buffer, CancellationToken ct)
{
    await stream.ReadAsync(buffer, ct);       // Memory crosses the await
    Parse(buffer.Span);                        // Span for the synchronous work
}
```
:::

## Allocation-free string work

```csharp
ReadOnlySpan<char> text = input;

text.Trim();
text.StartsWith("task:");
text.IndexOf(',');
text.Slice(5, 10);
text[5..15];
text.SequenceEqual(other);
text.Split(destination, ',');                 // .NET 8+, writes ranges into a span

int.TryParse(text, out var number);           // parses a span directly — no substring
DateOnly.TryParse(text, out var date);
Guid.TryParse(text, out var id);
```

Every BCL `TryParse` has a span overload. `int.Parse(s.Substring(0, 4))` allocates a string to throw away; `int.Parse(s.AsSpan(0, 4))` does not.

## Building strings without allocating

```csharp
// ❌ allocates a new string per concatenation
var result = "";
foreach (var label in labels) result += label + ",";

// ✅ one buffer
var builder = new StringBuilder();
foreach (var label in labels) builder.Append(label).Append(',');

// ✅✅ no heap allocation at all for short results
Span<char> buffer = stackalloc char[256];
var handler = new DefaultInterpolatedStringHandler(20, 2, null, buffer);
handler.AppendFormatted(task.Id);
handler.AppendLiteral(": ");
handler.AppendFormatted(task.Title);
var line = handler.ToStringAndClear();
```

And for formatting into a caller's buffer:

```csharp
public bool TryFormat(Span<char> destination, out int written)
{
    return destination.TryWrite($"{Id}: {Title} [{Priority}]", out written);
}
```

::: warn `stackalloc` has a hard limit
The stack is about 1 MB per thread. `stackalloc` beyond a few hundred bytes risks a `StackOverflowException`, which **cannot be caught** — the process dies.

The standard guard:
```csharp
const int MaxStack = 256;
char[]? rented = null;
Span<char> buffer = length <= MaxStack
    ? stackalloc char[MaxStack]
    : (rented = ArrayPool<char>.Shared.Rent(length));

try { /* use buffer */ }
finally { if (rented is not null) ArrayPool<char>.Shared.Return(rented); }
```

Never `stackalloc` a length derived from input without a bound. That is a denial-of-service vector: a caller supplying a large length crashes the process.
:::

## `ArrayPool<T>`

```csharp
var buffer = ArrayPool<byte>.Shared.Rent(8192);        // may return a LARGER array
try
{
    var read = await stream.ReadAsync(buffer.AsMemory(0, 8192), ct);
    Process(buffer.AsSpan(0, read));
}
finally
{
    ArrayPool<byte>.Shared.Return(buffer, clearArray: true);   // clear if it held secrets
}
```

Two rules: `Rent` may return an array **larger** than requested, so always track the length yourself; and always `Return` in a `finally`, or you have simply made allocation slower.

## When does any of this matter?

::: design Be honest about this
For most application code — an API handling a few hundred requests per second, each doing database I/O — `Span<T>` is irrelevant. A `Substring` costing 50 nanoseconds is invisible next to a 2-millisecond database query. Rewriting readable code into span-based code for no measured reason makes it harder to maintain and faster by an amount nobody can perceive.

**Where it genuinely matters:**
- Parsers and serialisers over large inputs
- Bulk import and export (your million-line CSV)
- Network protocol handling
- Anything in a loop running millions of times
- Library code used by many callers
- Memory-constrained environments

**Where it does not:**
- Request handlers that do I/O
- Startup code
- Anything running fewer than thousands of times per second

The framework already uses spans everywhere internally, so you benefit without writing any. Reach for them when a profiler says allocation is your bottleneck — not before.
:::

::: exercise Level 1 — Guided · Measure the difference
Benchmark parsing one million CSV lines three ways:

1. `string.Split(',')` plus `int.Parse` on the substrings.
2. `IndexOf` and `Substring`.
3. `ReadOnlySpan<char>` slicing with span-based `TryParse`.

Use `[MemoryDiagnoser]`. Record time and allocated bytes for each.

Then:
4. Build a 10,000-item report with `+=`, with `StringBuilder`, and with a pooled buffer. Benchmark all three.
5. Write a `TryFormat` on `TaskItem` that writes into a caller's span.
6. Demonstrate the `ref struct` restrictions: try to put a `Span<char>` in a field, capture it in a lambda, and use it across an `await`. Read each compiler error.
:::

::: solution
Representative results for one million lines:

```text
| Method          |       Mean | Allocated |
|---------------- |-----------:|----------:|
| Split           | 420.000 ms |  366.2 MB |
| IndexOfSubstring| 180.000 ms |  198.4 MB |
| Span            |  48.000 ms |       0 B |
```

Roughly 9× faster and — the more important number — **zero allocations**, which means zero GC pressure, which means no gen-2 collections and no latency spikes during the import.

String building for 10,000 items:
```text
| Concatenation   | 2,100.00 ms | 1,024.0 MB |
| StringBuilder   |     0.85 ms |      1.2 MB |
| PooledBuffer    |     0.61 ms |      0.0 MB |
```

`+=` in a loop is O(n²) in both time and allocation — each concatenation copies the whole accumulated string. That one is worth internalising: it is the single most common performance mistake in string handling, and it is invisible with ten items and catastrophic with ten thousand.

The compiler errors from step 6 are worth reading properly:
```text
CS8345: Field or auto-implemented property cannot be of type 'Span<char>' unless it is an instance member of a ref struct.
CS8175: Cannot use ref local 'span' inside an anonymous method, lambda expression, or query expression.
CS4013: Instance of type 'Span<char>' cannot be used inside a nested function, query expression, iterator block or async method.
```
Each is the compiler preventing a span from outliving its memory. These are not arbitrary restrictions — they are what makes `Span<T>` safe without a runtime check.
:::

::: challenge Level 3 · A zero-allocation importer
Rewrite TaskFlow's CSV import to allocate nothing per row except the `TaskItem` itself.

Requirements:
1. Read the file with `PipeReader` or a pooled buffer, never `ReadAllLines`.
2. Parse each line with spans; no `Substring`, no `Split` that allocates.
3. Parse `Guid`, `DateOnly`, enums and `int` from spans directly.
4. Handle a line split across buffer boundaries.
5. Malformed rows are reported with a line number and skipped.
6. Benchmark against your existing importer for a one-million-row file: time, allocation, peak working set.
7. The zero-allocation claim is verified by `[MemoryDiagnoser]`, not asserted.

Requirement 4 is what makes this a real exercise rather than a toy.
:::

::: solution
```csharp
public async Task<ImportResult> ImportAsync(Stream stream, CancellationToken ct)
{
    var reader = PipeReader.Create(stream);
    var imported = 0; var failed = 0; var lineNumber = 0;

    while (true)
    {
        var result = await reader.ReadAsync(ct);
        var buffer = result.Buffer;

        while (TryReadLine(ref buffer, out var line))
        {
            lineNumber++;
            if (TryParseTask(line, out var task)) { await _store.AddAsync(task, ct); imported++; }
            else failed++;
        }

        reader.AdvanceTo(buffer.Start, buffer.End);     // ← tells the pipe what was consumed
        if (result.IsCompleted) break;
    }

    await reader.CompleteAsync();
    return new ImportResult(imported, failed);
}

private static bool TryReadLine(ref ReadOnlySequence<byte> buffer, out ReadOnlySequence<byte> line)
{
    var position = buffer.PositionOf((byte)'\n');
    if (position is null) { line = default; return false; }

    line = buffer.Slice(0, position.Value);
    buffer = buffer.Slice(buffer.GetPosition(1, position.Value));
    return true;
}
```

**`PipeReader` solves requirement 4 for you.** `AdvanceTo(buffer.Start, buffer.End)` says "I consumed nothing beyond what I sliced off, but I examined everything" — so when a line is incomplete, the pipe retains the partial data and appends the next read to it. Doing that by hand with a `Stream` means managing a growable buffer and copying leftovers, which is exactly the fiddly code that produces off-by-one bugs.

The other subtlety is `ReadOnlySequence<byte>` rather than `ReadOnlySpan<byte>`: a pipe's buffer may be several discontiguous segments, so a line can straddle them. `sequence.IsSingleSegment` is the fast path; otherwise you copy into a stack or pooled buffer first:

```csharp
private static bool TryParseTask(ReadOnlySequence<byte> line, out TaskItem task)
{
    if (line.IsSingleSegment) return TryParseTask(line.FirstSpan, out task);

    Span<byte> scratch = line.Length <= 256 ? stackalloc byte[(int)line.Length] : default;
    byte[]? rented = null;
    if (scratch.IsEmpty) scratch = rented = ArrayPool<byte>.Shared.Rent((int)line.Length);

    try
    {
        line.CopyTo(scratch);
        return TryParseTask(scratch[..(int)line.Length], out task);
    }
    finally { if (rented is not null) ArrayPool<byte>.Shared.Return(rented); }
}
```

Typical results for one million rows:
```text
| Method    |      Mean | Allocated | Peak working set |
|---------- |----------:|----------:|-----------------:|
| Original  |  8,400 ms |    2.1 GB |           980 MB |
| Pipelines |  1,900 ms |    142 MB |            84 MB |
```

The 142 MB is the `TaskItem` objects themselves, which you genuinely need. Everything else is gone. And the peak working set — the number that decides your container's memory limit — drops by more than a factor of ten.
:::

::: project Optimise TaskFlow's bulk paths
1. Benchmark import and export before changing anything.
2. Rewrite import with `PipeReader` and span parsing.
3. Rewrite CSV export to write into a pooled buffer.
4. `[MemoryDiagnoser]` proving the allocation reduction.
5. Leave every other path alone, and say so in `DECISIONS.md` — a request handler doing one database query has nothing to gain.
6. Record before and after: time, allocation and peak working set.

Commit.
:::

::: interview What is Span&lt;T&gt; and when would you use it?
`Span<T>` is a `ref struct` representing a contiguous window over memory — an array, a string, a stack buffer or unmanaged memory — as a pointer and a length. Slicing a span does not copy, so you can parse and process without allocating substrings or intermediate arrays.

Because it is a `ref struct`, the compiler guarantees it cannot outlive its memory: it cannot be a class field, be boxed, be captured in a lambda, or cross an `await`. `Memory<T>` is the heap-safe counterpart for those cases, and you take `.Span` from it for the synchronous work.

Where it matters is parsers, serialisers, bulk import and export, and anything in a very hot loop — I measured a CSV import going from 420ms and 366MB allocated to 48ms and zero. Where it does not matter is ordinary request handling that does I/O, where a substring's 50 nanoseconds is invisible next to a database round trip. I would reach for it when a profiler points at allocation, not by default.
:::

::: checkpoint
- [ ] I benchmarked span parsing against `Split` and recorded both numbers
- [ ] I saw `+=` in a loop behave quadratically
- [ ] I read all three `ref struct` compiler errors
- [ ] I know when to use `Memory<T>` instead of `Span<T>`
- [ ] I optimised only the paths where I measured a problem
:::

## Common mistakes

::: mistake
**`stackalloc` with an unbounded length.** An uncatchable crash, and a DoS vector.

**Renting from `ArrayPool` and not returning in a `finally`.** You made allocation slower.

**Assuming `Rent(1024)` returns exactly 1024 elements.** It may be larger. Track your own length.

**Rewriting everything with spans.** Unreadable code, unmeasurable gains.

**`+=` in a loop.** Quadratic time and allocation.
:::
