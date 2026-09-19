---
title: Collections
summary: Which collection to reach for, what each costs, and the interfaces you should be declaring instead.
minutes: 35
stage: Stage 1
---

## What are we learning?

The .NET collection types, their real performance characteristics, and — more important day to day — which *interface* to use in a signature.

## The types you actually use

| Type | Use it for | Lookup | Insert | Ordered? |
|---|---|---|---|---|
| `T[]` | Fixed size, known at creation | O(1) by index | — | Yes |
| `List<T>` | The default resizable sequence | O(1) by index, O(n) by value | O(1) amortised at end | Insertion order |
| `Dictionary<K,V>` | Lookup by key | O(1) | O(1) | No guarantee |
| `HashSet<T>` | Uniqueness, set operations | O(1) | O(1) | No guarantee |
| `Queue<T>` | FIFO | — | O(1) | FIFO |
| `Stack<T>` | LIFO | — | O(1) | LIFO |
| `SortedDictionary<K,V>` | Sorted by key, frequent inserts | O(log n) | O(log n) | Yes |
| `SortedList<K,V>` | Sorted by key, read-heavy | O(log n) | O(n) | Yes |
| `LinkedList<T>` | Genuinely need node splicing | O(n) | O(1) at a node | Yes |
| `ConcurrentDictionary<K,V>` | Multi-threaded access | O(1) | O(1) | No |
| `ImmutableArray<T>` | Shared, never-changing data | O(1) | O(n) copy | Yes |

`List<T>` and `Dictionary<TKey, TValue>` cover the overwhelming majority of real code. `LinkedList<T>` is almost never the right answer despite what data-structures courses suggest — cache locality means an array-backed `List<T>` beats it even for middle insertions at small sizes.

## Collection expressions

```csharp
List<string> labels = ["bug", "urgent"];
int[] numbers = [1, 2, 3];
HashSet<int> set = [1, 2, 2, 3];              // {1, 2, 3}
Span<char> chars = ['a', 'b'];

int[] more = [..numbers, 4, 5];               // spread
List<TaskItem> all = [..completed, ..pending];
```

The `[...]` syntax works for any collection type the compiler can build, which is nearly all of them. It replaces `new List<string> { ... }` and `new[] { ... }`.

## Declare the interface, return the concrete type

::: design Which type goes in a signature?
```csharp
//                                   parameter                    return
void Process(IEnumerable<TaskItem> tasks)                       // most permissive input
IReadOnlyList<TaskItem> GetAll()                                // honest output
```

**For parameters**, ask for the least you need:
- `IEnumerable<T>` — you will iterate, once, forwards. Most permissive.
- `IReadOnlyCollection<T>` — you also need `.Count` without enumerating.
- `IReadOnlyList<T>` — you also need indexing.
- `ICollection<T>` / `IList<T>` — you intend to **modify** the caller's collection. Rare, and say so in the name.

**For return values**, return the most specific thing that does not over-promise:
- `IReadOnlyList<T>` is the usual right answer for "here are the results".
- Returning `IEnumerable<T>` from a method that has already materialised a list is a small lie — the caller cannot tell whether enumerating it twice costs twice. Worse, if you return a lazy LINQ query, the caller may enumerate it after your `DbContext` is disposed. Phase 3 covers this properly.
- Returning `List<T>` lets callers mutate your internal state. Only do it if the list is a fresh copy.
:::

## Equality, again

```csharp
var set = new HashSet<TaskSummary>();   // record -> value equality -> works as expected
var bad = new HashSet<TaskItemClass>(); // class  -> reference equality -> duplicates survive
```

Every hash-based collection depends on `GetHashCode` and `Equals`. This is the practical payoff of the records lesson.

Also control string comparison explicitly:

```csharp
var labels = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
labels.Add("Bug");
labels.Contains("bug");     // true

var dict = new Dictionary<string, TaskItem>(StringComparer.Ordinal);
```

`StringComparer.Ordinal` is a fast byte comparison. `StringComparer.CurrentCulture` respects locale rules and is what `"a" < "B"` uses in sorting. Choosing `OrdinalIgnoreCase` for identifiers and `CurrentCulture` for user-visible sorting is the habit to build.

## Small things that save you

```csharp
dict.TryGetValue(key, out var value)          // no exception, no double lookup
dict.GetValueOrDefault(key)                   // null / default if absent
dict.TryAdd(key, value)                       // returns false instead of throwing
list.AsReadOnly()                             // genuine read-only wrapper
new List<TaskItem>(capacity: 1000)            // pre-size when you know the count
```

::: predict What does this print?
```csharp
var d = new Dictionary<string, int>();
d["a"] = 1;
Console.WriteLine(d["b"]);

var l = new List<int> { 1, 2, 3 };
Console.WriteLine(l[3]);
```
:::

::: solution
The first line throws `KeyNotFoundException: The given key 'b' was not present in the dictionary.` The second never runs; if it did it would throw `ArgumentOutOfRangeException`.

A dictionary indexer **reads strictly but writes leniently**: `d["b"]` throws when reading, but `d["b"] = 5` silently inserts. That asymmetry catches people. When you are not certain the key exists, use `TryGetValue` or `GetValueOrDefault`.
:::

::: exercise Level 1 — Guided · Pick the right collection
For each requirement, choose a collection type and justify it in one sentence. Then implement each as a small method over `List<TaskItem>`.

1. Tasks in the order the user created them.
2. Look up a task by `Id` in constant time.
3. The set of distinct labels used across all tasks, case-insensitive.
4. Tasks waiting to be processed, oldest first.
5. An undo history where you only ever need the most recent action.
6. Task counts per status, where you will iterate the statuses in enum order.
:::

::: solution
1. `List<TaskItem>` — preserves insertion order, indexable, cheapest.
2. `Dictionary<Guid, TaskItem>` — O(1) hash lookup, and `Guid` has good hashing.
3. `HashSet<string>(StringComparer.OrdinalIgnoreCase)` — uniqueness is the requirement, and the comparer handles "Bug"/"bug".
4. `Queue<TaskItem>` — FIFO is exactly the semantic. Using a `List` and `RemoveAt(0)` is O(n) per dequeue.
5. `Stack<UndoAction>` — LIFO, and `Peek`/`Pop` name the intent.
6. `SortedDictionary<TaskStatus, int>` — enum keys sort by their numeric value, so iteration order is the enum order. `Dictionary` would work but its order is an implementation detail you must not rely on.

The meta-point: choose by **semantics first**, performance second. `Queue<T>` in (4) is right not because it is faster but because the next reader instantly knows what you meant.
:::

::: challenge Level 3 · A bounded, indexed task index
Build `TaskIndex` that maintains, for one project, all of the following simultaneously and keeps them consistent:

- all tasks in creation order
- lookup by `Id` in O(1)
- lookup by label — one label maps to many tasks
- a count per `TaskStatus`
- the 10 most recently completed tasks, newest first

Requirements: `Add`, `Remove`, `MarkComplete` must each keep **every** structure correct. No structure may be rebuilt from scratch on each call. Write a small test in `Program.cs` that adds 1,000 tasks, completes 50, removes 20, and asserts every view agrees.

This is a genuinely fiddly problem, and keeping derived state consistent is most of what caching and indexing work is in real systems.
:::

::: project Give TaskFlow real querying
Add to your in-memory store:

```csharp
IReadOnlyList<TaskItem> ByStatus(TaskStatus status);
IReadOnlyList<TaskItem> ByLabel(string label);          // case-insensitive
IReadOnlyDictionary<TaskStatus, int> CountByStatus();
IReadOnlyList<TaskItem> Overdue(DateOnly today);
```

Implement them with loops for now — **deliberately**. In Phase 3 you rewrite every one of them in LINQ and compare the two versions side by side. Keep this commit so you can diff against it later:

```bash
git commit -am "Stage 1: hand-written query methods (LINQ rewrite in phase 3)"
```
:::

::: interview What is the difference between IEnumerable, ICollection and IList?
`IEnumerable<T>` only promises that you can iterate forwards, once. It has no `Count` and no indexer, and the sequence may be lazily computed or infinite.

`ICollection<T>` adds `Count`, `Add`, `Remove` and `Contains` — a finite, mutable bag.

`IList<T>` adds positional access: an indexer, `Insert` and `RemoveAt`.

There are read-only counterparts — `IReadOnlyCollection<T>` and `IReadOnlyList<T>` — that expose `Count` and indexing without mutation, and those are what you should usually return from a method.

The principle to state: accept the weakest interface you need, return the strongest one you can honestly guarantee.
:::

::: checkpoint
- [ ] I can pick a collection for each of the six scenarios and justify it
- [ ] I know why `d["missing"]` throws on read but not on write
- [ ] I use `IEnumerable<T>` for parameters and `IReadOnlyList<T>` for returns by default
- [ ] I always pass a `StringComparer` to string-keyed dictionaries and sets
- [ ] TaskFlow has hand-written query methods, committed for later comparison
:::

## Common mistakes

::: mistake
**`List<T>.Contains` in a loop.** That is O(n) inside O(n) — a 10,000-item list means 100 million comparisons. Use a `HashSet<T>` or a `Dictionary`.

**`RemoveAt(0)` in a loop to drain a list.** O(n) per removal because everything shifts. Use a `Queue<T>`, or iterate backwards.

**Modifying a collection while iterating it.** `InvalidOperationException: Collection was modified`. Iterate a snapshot (`foreach (var t in list.ToList())`) or collect the items to remove and remove them afterwards.

**Returning `List<T>` from a property.** Callers can mutate your internal state. `IReadOnlyList<T>` at minimum.

**Assuming `Dictionary` iteration order is insertion order.** It very often looks like it is, right up until a resize reorders everything. It is explicitly undefined.
:::
