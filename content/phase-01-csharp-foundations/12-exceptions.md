---
title: Exception handling
summary: When to throw, when to catch, what never to do, and how not to destroy a stack trace.
minutes: 35
stage: Stage 1
---

## What are we learning?

Exception mechanics in C#, and the judgement about when an exception is the right tool at all.

## The syntax, quickly

```csharp
try
{
    var task = store.Get(id) ?? throw new TaskNotFoundException(id);
    task.Complete();
}
catch (TaskNotFoundException ex)          // most specific first
{
    logger.LogWarning(ex, "Task {Id} not found", id);
}
catch (InvalidOperationException ex) when (ex.Message.Contains("already complete"))
{
    // exception filter — only enters the catch if the condition is true
}
catch (Exception ex)                      // least specific last
{
    logger.LogError(ex, "Unexpected failure completing {Id}", id);
    throw;                                // rethrow, preserving the stack trace
}
finally
{
    // always runs — even on an exception, even on a return
}
```

## The three rethrow forms, and why only one is right

```csharp
catch (Exception ex)
{
    throw;                          // ✅ preserves the original stack trace
    throw ex;                       // ❌ RESETS the stack trace to this line
    throw new Exception("failed", ex);  // ✅ wraps — original kept as InnerException
}
```

`throw ex;` is the classic. It compiles, it looks equivalent, and it destroys the information you need to find the bug. The stack trace will point at your catch block instead of at the line that actually failed.

::: warn How to lose a production incident
```csharp
catch (Exception ex)
{
    logger.LogError("Something went wrong: " + ex.Message);
}
```
Three separate mistakes in three lines:
1. **The exception is swallowed.** Execution continues as if nothing happened, with the program in an unknown state.
2. **Only `ex.Message` is logged.** No stack trace, no inner exception, no type. You know that something failed and nothing about where.
3. **String concatenation into the log message.** Structured logging (Phase 14) needs `logger.LogError(ex, "Failed to complete {TaskId}", id)` — the exception as the first argument, and named placeholders you can search on.

Catching `Exception` at all is only defensible at a top-level boundary: a request handler, a background job loop, `Main`. Everywhere else, catch the specific type you can actually do something about.
:::

## Custom exceptions

```csharp
public class TaskNotFoundException(Guid taskId)
    : Exception($"Task {taskId} was not found.")
{
    public Guid TaskId { get; } = taskId;
}

public class TaskStateException(TaskItem task, string action)
    : InvalidOperationException($"Cannot {action} task '{task.Title}' in state {task.Status}.")
{
    public Guid TaskId { get; } = task.Id;
    public TaskStatus Status { get; } = task.Status;
}
```

Put the **data** on the exception, not only in the message. A caller can branch on `ex.Status`; it cannot reasonably parse `ex.Message`.

## Which built-in exception to throw

| Situation | Type |
|---|---|
| A parameter is null | `ArgumentNullException` |
| A parameter's value is invalid | `ArgumentException` |
| A numeric/enum parameter is out of range | `ArgumentOutOfRangeException` |
| The object is in the wrong state for this call | `InvalidOperationException` |
| The operation is not supported at all | `NotSupportedException` |
| Not written yet | `NotImplementedException` |
| Something in your domain went wrong | Your own exception type |

Never throw `Exception`, `SystemException` or `ApplicationException` — a caller cannot catch them selectively.

Modern guard helpers, which produce the right type and message for free:

```csharp
ArgumentNullException.ThrowIfNull(task);
ArgumentException.ThrowIfNullOrWhiteSpace(title);
ArgumentOutOfRangeException.ThrowIfNegative(count);
ObjectDisposedException.ThrowIf(_disposed, this);
```

## When *not* to use exceptions

::: design Exception or return value?
Exceptions are for the **exceptional** — conditions the caller could not reasonably have prevented and usually cannot recover from locally.

"The user typed an invalid email" is not exceptional. It is the expected outcome of accepting user input, it will happen thousands of times a day, and throwing costs roughly a microsecond plus a stack walk.

| Condition | Mechanism |
|---|---|
| Validation failure on user input | Return a result / validation errors |
| "Not found" in a lookup you expect to miss | `TryGet` pattern or a nullable return |
| "Not found" for something that must exist | Throw |
| Programming error (null argument, bad state) | Throw |
| Network/database failure | Let it throw; handle at a boundary with retry |
| Business rule violation mid-operation | Throw a domain exception |

The `Try` pattern is the C# convention for "this failing is normal":
```csharp
public bool TryComplete(Guid id, [NotNullWhen(true)] out TaskItem? task)
```
:::

::: exercise Level 1 — Guided · Stack traces, felt rather than described
1. Write a three-deep call chain: `Top()` calls `Middle()` calls `Bottom()`, and `Bottom()` throws.
2. Catch in `Top()` and print `ex.StackTrace`. Note that all three frames appear.
3. Add a catch in `Middle()` that does `throw ex;`. Print again. Count the frames.
4. Change it to `throw;`. Print again. Compare.
5. Change it to `throw new InvalidOperationException("middle failed", ex);` and print `ex.ToString()` (not `ex.Message`) in `Top()`. Note that `ToString()` includes the full inner exception chain — this is why you log the exception object, never just its message.
:::

::: predict What does this print?
```csharp
Console.WriteLine(Run());

static string Run()
{
    try
    {
        return "try";
    }
    finally
    {
        Console.WriteLine("finally");
    }
}
```
And what about this one?
```csharp
static int Counter()
{
    var i = 0;
    try { return i; }
    finally { i = 99; }
}
```
:::

::: solution
First:
```text
finally
try
```
The return value is evaluated first, then `finally` runs, then control actually returns. `finally` always runs — that is its entire purpose, and it runs *before* the caller sees the return.

Second: `Counter()` returns **0**. The return value was already copied out of `i` before `finally` ran. Assigning to `i` afterwards changes the variable, not the already-captured return value.

If `finally` contained `return 99;` instead, it *would* win — but returning from a `finally` block is a compiler error in C# precisely because it is so confusing. (It is legal in IL, which is why the rule exists.)
:::

::: debug Level 4 · Four bugs in eight lines
```csharp
public TaskItem Complete(Guid id)
{
    try
    {
        var task = _store.Get(id);
        task.Complete();
        return task;
    }
    catch (Exception ex)
    {
        Console.WriteLine("Error: " + ex.Message);
        throw ex;
    }
}
```
Find all four. Then rewrite it properly.
:::

::: solution
1. **`_store.Get(id)` can return null** and `task.Complete()` then throws `NullReferenceException` — a useless exception that says nothing about the actual problem (a missing task).
2. **`catch (Exception)`** catches everything, including bugs that should propagate untouched.
3. **`Console.WriteLine` for error reporting** — not structured, not routed to a log sink, invisible in production.
4. **`throw ex;`** resets the stack trace, so the log points at this method rather than at the failure.

A fifth, subtler one: the catch adds nothing. It logs and rethrows. A catch block that does not *handle* anything should usually not exist — let the exception travel to the boundary that knows what to do with it.

```csharp
public TaskItem Complete(Guid id)
{
    var task = _store.Get(id) ?? throw new TaskNotFoundException(id);
    task.Complete();      // throws TaskStateException if already complete — correct, let it fly
    return task;
}
```

Four lines, no try/catch, better diagnostics. The logging belongs in one place at the boundary (Phase 6's exception-handling middleware), not scattered through every method.
:::

::: project Give TaskFlow a proper exception vocabulary
1. Create `Domain/Exceptions/` with:
   - `TaskFlowException` — an abstract base so callers can catch all of your domain's exceptions with one clause
   - `TaskNotFoundException(Guid id)`
   - `TaskStateException(TaskItem task, string action)`
   - `ValidationException(IReadOnlyList<string> errors)` carrying the list, not a joined string
2. Replace every `throw new InvalidOperationException("...")` and `ArgumentException` in your domain with the right one of these — where it is genuinely a *domain* error. Argument guards stay as `ArgumentException`.
3. In `Program.cs`, wrap your top-level logic in a single try/catch that handles `TaskFlowException` with a friendly message and `Exception` with "unexpected error" plus the full `ToString()`.
4. Add a `TryComplete(Guid id, out TaskItem? task)` alongside `Complete` and use each where appropriate.

Commit. That single top-level handler is the ancestor of the exception middleware you write in Phase 6.
:::

::: interview When should you catch an exception?
Only when you can do something useful: retry, fall back, add context, translate it to another layer's vocabulary, or report it at a boundary and stop.

Catching to log and rethrow duplicates logs and adds nothing. Catching `Exception` broadly hides bugs — it should appear only at top-level boundaries like a request pipeline, a background-service loop or `Main`.

The detail interviewers listen for: `throw;` preserves the original stack trace, `throw ex;` resets it to the rethrow point. Getting that wrong turns a debuggable incident into a mystery.
:::

::: checkpoint
- [ ] I saw the stack trace difference between `throw;` and `throw ex;` with my own eyes
- [ ] I can name the right built-in exception for six different situations
- [ ] I found all four bugs in the eight-line method
- [ ] I can argue when a validation failure should *not* be an exception
- [ ] TaskFlow has a domain exception hierarchy and one top-level handler
:::

## Common mistakes

::: mistake
**`catch (Exception ex) { }`** — an empty catch. The program continues in a corrupted state and you will never find out why.

**Using exceptions for control flow.** Throwing to exit a loop, or to signal "not found" in a lookup that misses half the time, is slow and hides intent.

**`throw ex;`**. The most common single mistake in .NET exception handling.

**Logging `ex.Message` only.** You lose the type, the stack trace and every inner exception. Log the exception object.

**Catching and rethrowing at every layer.** You get five copies of the same error in the log and no additional information.
:::
