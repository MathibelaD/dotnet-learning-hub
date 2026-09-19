---
title: Events
summary: Delegates with access control — and why modern .NET often reaches for something else instead.
minutes: 30
stage: Stage 1
---

## What are we learning?

The `event` keyword, the standard .NET event pattern, the memory leak it famously causes, and when you should use something else entirely.

## An event is a delegate with two restrictions

```csharp
public class TaskStore
{
    public event Action<TaskItem>? TaskAdded;       // an event

    public void Add(TaskItem task)
    {
        _tasks.Add(task);
        TaskAdded?.Invoke(task);                    // only this class can raise it
    }
}
```

Without `event`, the field would be a public delegate, and any caller could:

```csharp
store.TaskAdded = null;              // wipe out everyone else's subscriptions
store.TaskAdded.Invoke(fakeTask);    // raise it on the store's behalf
```

`event` makes both of those compile errors. From outside the declaring class, only `+=` and `-=` are allowed. That is the entire feature.

## The standard pattern

.NET has a convention that every framework event follows, and you should too when writing library-style code:

```csharp
public class TaskCompletedEventArgs(TaskItem task, TimeSpan duration) : EventArgs
{
    public TaskItem Task { get; } = task;
    public TimeSpan Duration { get; } = duration;
}

public class TaskStore
{
    public event EventHandler<TaskCompletedEventArgs>? TaskCompleted;

    protected virtual void OnTaskCompleted(TaskCompletedEventArgs e) =>
        TaskCompleted?.Invoke(this, e);
}
```

The convention: `EventHandler<TArgs>`, the sender first, arguments deriving from `EventArgs`, and a `protected virtual On...` method so subclasses can intercept. It is verbose, and the reason for it is consistency across the whole framework.

For internal application code, `event Action<TaskItem>?` is perfectly acceptable and much less ceremony.

## Subscribing

```csharp
store.TaskAdded += OnTaskAdded;                 // method group
store.TaskAdded += t => Console.WriteLine(t.Title);   // lambda

static void OnTaskAdded(TaskItem t) => Console.WriteLine($"Added {t.Title}");

store.TaskAdded -= OnTaskAdded;                 // works
store.TaskAdded -= t => Console.WriteLine(t.Title);   // DOES NOT WORK
```

::: warn You cannot unsubscribe a lambda you did not keep
`-=` removes a delegate equal to the one you pass. Two identical-looking lambdas are different delegate instances, so the second `-=` above silently does nothing — no error, no effect.

If you need to unsubscribe, keep a reference:
```csharp
Action<TaskItem> handler = t => Console.WriteLine(t.Title);
store.TaskAdded += handler;
// later
store.TaskAdded -= handler;
```
:::

## The event memory leak

This is the classic .NET memory leak and it is worth understanding properly.

```csharp
public class TaskNotifier
{
    public TaskNotifier(TaskStore store)
    {
        store.TaskAdded += OnAdded;      // the STORE now holds a reference to THIS
    }

    private void OnAdded(TaskItem t) { /* ... */ }
}
```

The subscription creates a delegate that holds a reference to the `TaskNotifier` instance. The store holds the delegate. So **the publisher keeps the subscriber alive.** If the store is long-lived (a singleton, a static, a cache) and notifiers come and go, every notifier ever created stays in memory forever.

Symptoms in production: memory climbs steadily, garbage collection never reclaims it, and eventually the process is killed. This is one of the most common real .NET memory leaks.

Fixes:
1. **Unsubscribe.** Implement `IDisposable` on the subscriber and `-=` in `Dispose` (Phase 13).
2. **Do not subscribe long-lived publishers from short-lived subscribers** — invert it so the short-lived object is the publisher.
3. **Use weak event patterns** — rarely worth the complexity in application code.

::: predict Find the leak
```csharp
var store = new TaskStore();      // lives for the whole program

for (int i = 0; i < 100_000; i++)
{
    var report = new BigReport();          // 1 MB each
    store.TaskAdded += report.Record;
}
// nothing else references 'report'
```
How much memory is retained after this loop, and why?
:::

::: solution
All 100 GB of it — the process dies first.

Each `+=` adds a delegate to the store's invocation list, and each delegate holds a strong reference to its `BigReport`. The loop variable going out of scope is irrelevant; the store is the one keeping them alive, and the store is still reachable.

Additionally, every `TaskAdded?.Invoke(...)` now calls 100,000 handlers, so the application gets slower and slower. A gradual slowdown combined with a memory climb is the signature of an event leak.
:::

## When not to use events

::: design Events, or something else?
Events are an in-process, synchronous, fire-and-forget notification from one object to whoever is listening. They are a good fit for UI frameworks and for library components that need to announce something.

They are usually the **wrong** tool in a server application, for four reasons:

1. **They are synchronous.** `TaskAdded?.Invoke(t)` blocks until every handler finishes. An `async void` handler makes it worse — exceptions from it cannot be caught and will crash the process.
2. **Subscription is invisible.** You cannot tell from reading `Add()` what happens when a task is added. Dependency injection makes the collaborators explicit in the constructor.
3. **Error handling is ambiguous.** One handler throwing prevents the others from running.
4. **They do not survive a restart.** A notification that must actually happen belongs in a queue or an outbox table.

What to use instead, in a .NET web application:
- **Constructor-injected collaborators** for "when X happens, also do Y" — explicit, testable, ordered. This is what TaskFlow uses.
- **`IHostedService` / background queues** (Phase 14) for work that should happen out of band.
- **A message broker** for anything that must survive a process restart or cross a service boundary.

Learn events because you will read them constantly in framework code and in WPF/WinForms/Blazor. Reach for them in your own server code rarely and deliberately.
:::

::: exercise Level 1 — Guided · Add events to the store
1. Add `event Action<TaskItem>? TaskAdded`, `TaskRemoved` and `event EventHandler<TaskCompletedEventArgs>? TaskCompleted` to `InMemoryTaskStore`.
2. Raise each at the right moment, always with `?.Invoke`.
3. In `Program.cs`, subscribe a console logger to all three.
4. Subscribe a second handler that counts completions, and print the count at the end.
5. Unsubscribe the console logger halfway through and confirm the counter keeps working.
:::

::: challenge Level 3 · Make it robust
Extend your store so that:

- A throwing handler does not prevent other handlers from running.
- Every handler exception is collected and reported together after all handlers have run.
- The raise method reports how long the handlers took in total, and warns if any single handler took more than 50ms.

Requirement: consumers must not have to change anything. You are only changing how the event is raised.
:::

::: solution
```csharp
private void Raise<T>(Action<T>? handlers, T arg, string eventName)
{
    if (handlers is null) return;

    List<Exception>? failures = null;
    var sw = Stopwatch.StartNew();

    foreach (var handler in handlers.GetInvocationList().Cast<Action<T>>())
    {
        var before = sw.ElapsedMilliseconds;
        try
        {
            handler(arg);
        }
        catch (Exception ex)
        {
            (failures ??= []).Add(ex);
        }

        var took = sw.ElapsedMilliseconds - before;
        if (took > 50)
            Console.WriteLine($"warn: handler {handler.Method.Name} took {took}ms on {eventName}");
    }

    if (failures is { Count: > 0 })
        throw new AggregateException($"{failures.Count} handler(s) failed on {eventName}.", failures);
}
```

`GetInvocationList()` returns the individual delegates so you can invoke them one at a time. `AggregateException` is the standard way to report several failures as one — you will meet it again in Phase 4 with `Task.WhenAll`.

`(failures ??= []).Add(ex)` allocates the list only when something actually fails, which is the common-path-free style you want in code that runs constantly.

Now notice how much machinery this took. Robustly raising an event requires timing, exception aggregation and invocation-list walking — none of which you would need if the collaborators were injected and called explicitly. That is the argument in the design box, demonstrated rather than asserted.
:::

::: project Compare the two designs in TaskFlow
Do both, then choose.

1. Keep your event-based store from the exercise on a branch:
   ```bash
   git checkout -b events-experiment
   git commit -am "Stage 1: store raises events"
   ```
2. Go back to `main` and implement the same behaviour with an injected collaborator instead:
   ```csharp
   public interface ITaskObserver
   {
       void OnAdded(TaskItem task);
       void OnCompleted(TaskItem task, TimeSpan duration);
   }

   public sealed class InMemoryTaskStore(IReadOnlyList<ITaskObserver> observers) : ITaskStore
   {
       public void Add(TaskItem task)
       {
           _tasks[task.Id] = task;
           foreach (var o in observers) o.OnAdded(task);
       }
   }
   ```
3. Write in `DECISIONS.md` which you chose and why — three sentences minimum.

The injected version is what the rest of the course builds on, because in Phase 5 the DI container supplies that list automatically, and in Phase 10 you can pass a fake observer in a test with no subscription bookkeeping.
:::

::: interview What is an event in C#, and how is it different from a delegate?
An event is a delegate field with restricted access: outside the declaring type, only `+=` and `-=` are permitted. That prevents consumers from clearing other subscribers or raising the event themselves. Internally it is still a multicast delegate.

The practical points worth raising: subscribing creates a strong reference from publisher to subscriber, so a long-lived publisher will keep subscribers alive — the classic .NET memory leak, fixed by unsubscribing in `Dispose`. And you cannot unsubscribe a lambda unless you kept a reference to it, because `-=` compares delegate instances.
:::

::: checkpoint
- [ ] I can explain exactly what `event` restricts compared to a public delegate field
- [ ] I demonstrated that `-=` with a fresh lambda does nothing
- [ ] I can describe the event memory leak and two ways to fix it
- [ ] I built a robust raise method with `GetInvocationList`
- [ ] I implemented the observer alternative and wrote down which I chose and why
:::

## Common mistakes

::: mistake
**`async void` event handlers.** An exception inside one cannot be caught by the raiser and will terminate the process. If a handler must be async, either make the event return `Task` (not really an event any more) or handle every exception inside the handler.

**Raising without `?.Invoke`.** `NullReferenceException` when nobody has subscribed.

**Never unsubscribing from a long-lived publisher.** A slow memory leak that is very hard to find after the fact.

**Using events to implement business logic.** "When a task completes, also update the project stats" is a requirement, not a notification. Make it an explicit call so it is visible, ordered and testable.
:::
