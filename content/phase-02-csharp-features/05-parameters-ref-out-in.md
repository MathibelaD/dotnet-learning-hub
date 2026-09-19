---
title: Parameters — ref, out, in, params and named arguments
summary: Every way to pass a value into a method, and what each one actually does to memory.
minutes: 30
stage: Stage 1
---

## What are we learning?

The full parameter vocabulary. Most of it you will use rarely, but you must be able to read it, and two of them (`out`, named arguments) you will use constantly.

## Default: pass by value

```csharp
void Rename(TaskItem task, string title)
{
    task.Title = title;          // ✅ mutates the object both variables point at
    task = new TaskItem("other");// ❌ reassigns the local copy of the reference only
}
```

For a **reference type**, the *reference* is copied. You can mutate the object; you cannot make the caller's variable point somewhere else.

For a **value type**, the whole value is copied. Nothing you do affects the caller.

## `ref` — pass the variable itself

```csharp
void Replace(ref TaskItem task) => task = new TaskItem("replaced");

var t = new TaskItem("original");
Replace(ref t);
Console.WriteLine(t.Title);    // "replaced" — the caller's VARIABLE changed
```

`ref` is required at both the declaration and the call site, which makes the mutation visible at the call. That visibility is deliberate.

The argument must be definitely assigned before the call.

## `out` — the method must assign it

```csharp
bool TryGetTask(Guid id, out TaskItem? task)
{
    task = _store.Get(id);
    return task is not null;
}

if (TryGetTask(id, out var task))     // 'var' works; the variable is declared inline
    Console.WriteLine(task.Title);    // ...but the compiler still thinks it may be null
```

The compiler enforces that every code path assigns `task` before returning. The caller does not need to initialise it.

Make the nullability analysis work for you:

```csharp
using System.Diagnostics.CodeAnalysis;

bool TryGetTask(Guid id, [NotNullWhen(true)] out TaskItem? task)
{
    task = _store.Get(id);
    return task is not null;
}

if (TryGetTask(id, out var task))
    Console.WriteLine(task.Title);    // now the compiler knows task is non-null here
```

`[NotNullWhen(true)]` is how `int.TryParse` and `Dictionary.TryGetValue` work with nullable analysis. Add it to every `Try` method you write — it costs one attribute and removes an entire category of warning noise.

## `in` — pass by reference, read-only

```csharp
decimal Distance(in LargeStruct a, in LargeStruct b) { ... }
```

`in` avoids copying a large struct while forbidding modification. It only matters for structs bigger than a pointer or two — for `int` or a reference, passing by value is already cheaper. Phase 13 measures it.

## `params`

```csharp
void AddLabels(TaskItem task, params string[] labels)
{
    foreach (var l in labels) task.AddLabel(l);
}

AddLabels(task, "bug", "urgent", "backend");    // array built for you
AddLabels(task);                                // empty array
AddLabels(task, existingArray);                 // also fine
```

Since C# 13, `params` works with spans and other collection types, which avoids the array allocation:

```csharp
void AddLabels(TaskItem task, params ReadOnlySpan<string> labels)
```

Rules: `params` must be the last parameter, and there can be only one.

## Optional parameters and named arguments

```csharp
TaskItem Create(
    string title,
    Priority priority = Priority.Normal,
    DateOnly? dueDate = null,
    bool notify = true)

Create("Fix bug");
Create("Fix bug", Priority.High);
Create("Fix bug", notify: false);                       // skip the middle ones
Create(title: "Fix bug", dueDate: friday, priority: Priority.Urgent);  // any order
```

Named arguments are the fix for the **boolean parameter problem**:

```csharp
SendReport(user, true, false, true);              // unreadable
SendReport(user, includeArchived: true, asPdf: false, cc: true);   // clear
```

Use named arguments at the call site whenever a literal `true`, `false`, `null` or a bare number would otherwise be a mystery.

::: warn Optional parameter defaults are baked into the caller
Exactly like `const`. The default value is copied into the calling code at *its* compile time.

```csharp
// Library v1
public void Send(string msg, int retries = 3) { }
```
You ship v2 with `retries = 5`. Applications compiled against v1 keep passing 3 until they are recompiled.

Inside one application this never matters. Across a package boundary it does — which is why library authors often prefer overloads to optional parameters.
:::

::: predict What does this print?
```csharp
var numbers = new List<int> { 1, 2, 3 };
Modify(numbers);
Console.WriteLine(string.Join(",", numbers));

Replace(numbers);
Console.WriteLine(string.Join(",", numbers));

static void Modify(List<int> list) => list.Add(4);
static void Replace(List<int> list) => list = new List<int> { 9 };
```
:::

::: solution
```text
1,2,3,4
1,2,3,4
```

`Modify` mutates the object both variables reference — the change is visible.
`Replace` reassigns its own local copy of the reference. The caller's variable is untouched.

"Pass by reference" in the C# sense means `ref`/`out`. Passing a reference type by value still copies the reference. People conflate these constantly, and this two-method example is the clearest way to tell them apart.

To make `Replace` work you would need `static void Replace(ref List<int> list)`.
:::

::: exercise Level 1 — Guided · Write a proper Try method
1. Add to your store: `bool TryGet(Guid id, [NotNullWhen(true)] out TaskItem task)`.
2. Confirm that inside `if (store.TryGet(id, out var t))` you can use `t.Title` with no nullable warning.
3. Remove the `[NotNullWhen(true)]` attribute and confirm the warning appears.
4. Write `bool TryParseStatus(string input, out TaskStatus status)` handling case-insensitive names *and* numeric values, returning false rather than throwing.
5. Write a `params` method `AddLabels(TaskItem task, params string[] labels)` that reports how many were actually added.
:::

::: challenge Level 3 · A command-line parser
Build a tiny argument parser for TaskFlow's console app:

```bash
taskflow add "Fix the login bug" --priority urgent --due 2026-10-01 --label bug --label auth
taskflow list --status open --assignee me
taskflow complete 3f2a...
```

Requirements:
- `bool TryParse(string[] args, [NotNullWhen(true)] out Command? command, [NotNullWhen(false)] out string? error)`
- Repeated flags (`--label`) collect into a list.
- Unknown flags produce a clear error, not an exception.
- Missing required values (`--priority` with nothing after it) produce a clear error.
- `Command` should be a closed set of record types, not a bag of nullable fields.

Use `out` where it is right and *do not* use it where a return value is better. Part of the exercise is deciding which is which.
:::

::: solution
```csharp
public abstract record Command
{
    public sealed record Add(string Title, Priority Priority, DateOnly? Due, IReadOnlyList<string> Labels) : Command;
    public sealed record List(TaskStatus? Status, string? Assignee) : Command;
    public sealed record Complete(Guid Id) : Command;
    private Command() { }
}
```

On the signature question: two `out` parameters plus a `bool` is legal, and it is what the BCL would do, but it is worse than the alternative here:

```csharp
public static ParseResult Parse(string[] args);

public abstract record ParseResult
{
    public sealed record Ok(Command Command) : ParseResult;
    public sealed record Error(string Message) : ParseResult;
    private ParseResult() { }
}
```

Why the second is better: with two `out` parameters, the combination "returned true but `command` is null" is representable, and every call site has to remember which `out` is meaningful in which branch. The result type makes the pairing structural.

The rule to take away: **`out` is good for one extra value in a hot, well-known pattern (`TryParse`, `TryGetValue`). Beyond that, return a type.** The BCL uses `out` heavily because `TryParse` predates records by fifteen years and because avoiding an allocation in parsing primitives genuinely matters.

A parsing sketch:
```csharp
for (var i = 0; i < args.Length; i++)
{
    if (!args[i].StartsWith("--")) { positional.Add(args[i]); continue; }

    var flag = args[i][2..];
    if (i + 1 >= args.Length || args[i + 1].StartsWith("--"))
        return new ParseResult.Error($"--{flag} requires a value.");

    var value = args[++i];
    switch (flag)
    {
        case "label": labels.Add(value); break;
        case "priority" when Enum.TryParse<Priority>(value, ignoreCase: true, out var p):
            priority = p; break;
        case "priority": return new ParseResult.Error($"Unknown priority '{value}'.");
        default: return new ParseResult.Error($"Unknown option --{flag}.");
    }
}
```

Note `case "priority" when ...` — a `switch` statement with a guard, so the failure case falls to the next arm and produces a good message.
:::

::: project Give TaskFlow a command line
Wire the parser into `Program.cs` so the console app accepts real commands. `add`, `list`, `complete`, `label` at minimum, plus `--help`.

Requirements:
- No exceptions for bad input — every user error is a message and a non-zero exit code.
- `return 0` on success, `1` on user error, `2` on unexpected failure. (`Main` can return `int`.)
- Use named arguments at every call site where a bare `true`/`false`/`null` would be unclear.

Test it:
```bash
dotnet run --project src/TaskFlow.Console -- add "Write the parser" --priority high --label meta
dotnet run --project src/TaskFlow.Console -- list --status open
```

Note the `--` — it separates `dotnet run`'s arguments from your program's. Forgetting it is a rite of passage.

Commit.
:::

::: interview What is the difference between `ref` and `out`?
Both pass a variable by reference rather than copying its value, so the method can change what the caller's variable refers to. The difference is the definite-assignment rules: `ref` requires the argument to be initialised before the call and the method may or may not change it; `out` does not require initialisation and the compiler *requires* the method to assign it on every path.

`in` is the third form: by reference but read-only, used to avoid copying large structs.

Worth adding: passing a reference type normally already passes a reference *by value* — you can mutate the object but not reassign the caller's variable. `ref` on a reference type is what lets you do the latter, and it is rare.
:::

::: checkpoint
- [ ] I can explain why `Replace(List<int> list)` does not change the caller's variable
- [ ] Every `Try` method I write has `[NotNullWhen(true)]`
- [ ] I used named arguments to kill a boolean-parameter call site
- [ ] I decided between `out` parameters and a result type, with a reason
- [ ] TaskFlow has a working command line with proper exit codes
:::

## Common mistakes

::: mistake
**Thinking objects are "passed by reference" by default.** The *reference* is passed by value. Mutation works; reassignment does not.

**`ref` to "make it faster".** For reference types and small structs it changes nothing and makes the call site noisier.

**Boolean parameters without names at the call site.** `Process(user, true, false)` is a comment waiting to be wrong.

**Optional parameters in a public library API.** The defaults bake into consumers. Use overloads.

**Forgetting `[NotNullWhen(true)]` on `Try` methods.** Callers then get spurious nullable warnings and start writing `!`.
:::
