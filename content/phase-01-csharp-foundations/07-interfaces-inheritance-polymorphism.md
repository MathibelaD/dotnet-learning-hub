---
title: Interfaces, abstract classes and polymorphism
summary: What each abstraction buys you, what it costs, and how to choose between them without cargo-culting.
minutes: 45
stage: Stage 1
---

## What are we learning?

Interfaces, abstract classes, `virtual`/`override`/`new`, and the actual decision criteria between them. You know what polymorphism is — this is about the C# mechanics and the design judgement.

## Interfaces: a contract with no implementation (mostly)

```csharp
public interface ITaskRepository
{
    Task<TaskItem?> GetAsync(Guid id, CancellationToken ct = default);
    Task<IReadOnlyList<TaskItem>> ListAsync(CancellationToken ct = default);
    Task AddAsync(TaskItem task, CancellationToken ct = default);
}
```

Key facts:

- A class can implement **many** interfaces but inherit from **one** class.
- Interface members are implicitly `public` and `abstract`.
- Interfaces can declare properties, methods, events and indexers — not fields.
- Since C# 8 they can have **default implementations**, which you should almost never use (see below).

```csharp
public class InMemoryTaskRepository : ITaskRepository
{
    private readonly Dictionary<Guid, TaskItem> _tasks = [];

    public Task<TaskItem?> GetAsync(Guid id, CancellationToken ct = default) =>
        Task.FromResult(_tasks.GetValueOrDefault(id));
    // ...
}
```

### Explicit implementation

```csharp
public class Repo : ITaskRepository, IAuditable
{
    // Both interfaces declare Save(). Implement each separately:
    Task ITaskRepository.SaveAsync() => SaveTasksAsync();
    Task IAuditable.SaveAsync()      => SaveAuditAsync();
}
```

An explicitly implemented member is only callable through the interface, not through the concrete type. Useful for name collisions, and for hiding a member that is required by an interface but is not part of your type's natural API.

## Abstract classes: partial implementation plus state

```csharp
public abstract class NotificationChannel
{
    protected NotificationChannel(ILogger logger) => Logger = logger;

    protected ILogger Logger { get; }             // shared state
    public abstract string Name { get; }          // subclass must supply
    protected abstract Task DeliverAsync(Notification n, CancellationToken ct);

    // Shared algorithm — the template method pattern, which you get for free here
    public async Task SendAsync(Notification n, CancellationToken ct)
    {
        Logger.LogInformation("Sending via {Channel}", Name);
        try
        {
            await DeliverAsync(n, ct);
        }
        catch (Exception ex)
        {
            Logger.LogError(ex, "Delivery failed on {Channel}", Name);
            throw;
        }
    }
}

public sealed class EmailChannel(ILogger<EmailChannel> logger) : NotificationChannel(logger)
{
    public override string Name => "email";
    protected override Task DeliverAsync(Notification n, CancellationToken ct) => /* ... */;
}
```

Note `: NotificationChannel(logger)` — a primary constructor passing an argument to the base.

## `virtual`, `override`, `new`, `sealed`

```csharp
public class Base
{
    public virtual string Describe() => "base";      // may be overridden
    public string Fixed() => "fixed";                // may not
}

public class Derived : Base
{
    public override string Describe() => "derived";  // real polymorphism
    public new string Fixed() => "shadowed";         // HIDING, not overriding
}

Base b = new Derived();
Console.WriteLine(b.Describe());   // "derived"  — dispatched on the runtime type
Console.WriteLine(b.Fixed());      // "fixed"    — dispatched on the compile-time type
```

::: warn `new` is almost always a bug
Method hiding means the behaviour depends on the *declared* type of the variable, not the actual object. Two references to the same object can behave differently. If you find yourself writing `new` to silence warning `CS0108`, you almost certainly wanted `virtual`/`override` on the base, or a different name.

`sealed` is the opposite and is underused. `public sealed class EmailChannel` says "do not derive from this", which makes the type easier to reason about and lets the JIT devirtualise calls. Sealing by default and unsealing when needed is a reasonable habit.
:::

## Choosing between them

::: design Interface or abstract class?
| | Interface | Abstract class |
|---|---|---|
| Multiple inheritance | Yes | No |
| Can hold fields/state | No | Yes |
| Can have a constructor | No | Yes |
| Can define non-public members | No (all public) | Yes |
| Adding a member later | Breaks implementers | Fine if non-abstract |
| Expresses | "can do this" | "is a kind of this" |

**Default to an interface** when the abstraction exists so that something can be *substituted* — a repository, a clock, an email sender, anything you will mock in a test. This is almost every abstraction in an application.

**Use an abstract class** when several implementations genuinely share code and state, and there is a real "is-a" relationship. The template-method shape above is the honest case.

**Use both** when it helps: `IPaymentProvider` interface, `PaymentProviderBase` abstract class implementing it with shared retry logic, concrete providers deriving from the base. Consumers depend on the interface; implementers optionally reuse the base.

**Default interface implementations** exist so that library authors can add a member to a published interface without breaking every implementer. In application code, reach for an abstract base class instead — it is clearer and it can hold state.
:::

::: exercise Level 1 — Guided · Build a small polymorphic hierarchy
1. Define `interface INotifier { string Channel { get; } Task NotifyAsync(string message); }`
2. Implement `ConsoleNotifier` and `FileNotifier` (append to a text file).
3. Write `async Task NotifyAll(IEnumerable<INotifier> notifiers, string message)` that calls each one.
4. In `Program.cs`, put both into a `List<INotifier>` and call it.
5. Add a third implementation — `NullNotifier` that does nothing — **without changing any existing code**. That "without changing existing code" is the whole point of the interface.
:::

::: exercise Level 2 — Independent · Refactor to an abstract base
Your two notifiers now both need to: prefix every message with a UTC timestamp, refuse empty messages, and count how many notifications they have sent.

Requirements:
- Do not duplicate that logic in each implementation.
- `INotifier` stays exactly as it is — consumers must not be affected.
- Each concrete notifier should end up containing only the part that is genuinely different.

Do it before reading the solution.
:::

::: solution
```csharp
public abstract class NotifierBase : INotifier
{
    private int _sent;

    public abstract string Channel { get; }
    public int SentCount => _sent;

    public async Task NotifyAsync(string message)
    {
        if (string.IsNullOrWhiteSpace(message))
            throw new ArgumentException("Message is required.", nameof(message));

        var stamped = $"[{DateTime.UtcNow:O}] {message}";
        await DeliverAsync(stamped);
        _sent++;
    }

    protected abstract Task DeliverAsync(string message);
}

public sealed class ConsoleNotifier : NotifierBase
{
    public override string Channel => "console";
    protected override Task DeliverAsync(string message)
    {
        Console.WriteLine(message);
        return Task.CompletedTask;
    }
}
```

The shape: the **public** method is non-virtual and holds the invariant logic; the **protected abstract** method is the single extension point. Subclasses cannot forget the validation or the counting because they cannot override the method that does it.

This is the Template Method pattern. You just wrote it without being told its name, which is the right order — Phase 12 names it.

One caveat to notice on your own: `_sent++` is not thread-safe. Fine for a console app; not fine when this runs in an API. Phase 13.
:::

::: debug Level 4 · The override that never runs
This prints `"generic"` twice. Explain and fix.

```csharp
public class Notification
{
    public string Render() => "generic";
}

public class UrgentNotification : Notification
{
    public new string Render() => "URGENT";
}

List<Notification> items = [new Notification(), new UrgentNotification()];
foreach (var i in items) Console.WriteLine(i.Render());
```
:::

::: solution
`Render()` is not `virtual`, so `UrgentNotification.Render()` **hides** it rather than overriding it. The list is typed `List<Notification>`, so the compiler binds to `Notification.Render()` for every element. The object's real type is irrelevant — there is no virtual dispatch to perform.

Fix:
```csharp
public class Notification { public virtual string Render() => "generic"; }
public class UrgentNotification : Notification { public override string Render() => "URGENT"; }
```

Diagnostic habit: if a derived implementation "isn't being called", check for `new` where `override` belongs. The compiler warns (`CS0108: hides inherited member`) — which is why you should never dismiss that warning by adding `new` to make it quiet.
:::

::: project Put TaskFlow's storage behind an interface
This is a pivotal step: it is the seam that everything later plugs into.

1. Create `Domain/ITaskStore.cs`:
   ```csharp
   namespace TaskFlow.Domain;

   public interface ITaskStore
   {
       TaskItem? Get(Guid id);
       IReadOnlyList<TaskItem> All();
       void Add(TaskItem task);
       bool Remove(Guid id);
   }
   ```
   (No `async` yet — Phase 4 changes that, and doing it in two steps teaches you what that change costs.)
2. Implement `InMemoryTaskStore` backed by a `Dictionary<Guid, TaskItem>`.
3. Change `Program.cs` so that **every** variable is typed `ITaskStore`, never `InMemoryTaskStore`. The concrete type should appear exactly once, on the `new`.
4. Write a second implementation, `LoggingTaskStore`, that takes an `ITaskStore` in its constructor, writes a line to the console for every operation, and delegates to the inner store. Wrap your in-memory store in it:
   ```csharp
   ITaskStore store = new LoggingTaskStore(new InMemoryTaskStore());
   ```
   Nothing else in `Program.cs` changes.

Commit. You have just built the Decorator pattern (Phase 12) and the dependency-inversion seam that Phase 8 formalises — from first principles, before either had a name.
:::

::: interview Why would you use an interface?
To depend on a capability rather than on a concrete implementation. Concretely that buys you three things: you can substitute a test double, you can swap implementations without changing consumers, and you can wrap or decorate an implementation without anyone noticing.

The honest counterpoint — worth volunteering — is that an interface with exactly one implementation that will never have another is pure overhead. The value appears when there is a real second implementation, including a test double. "Everything gets an interface" is a habit, not a design.
:::

::: checkpoint
- [ ] I can list four differences between an interface and an abstract class
- [ ] I added a third notifier without touching existing code
- [ ] I refactored shared behaviour into a template-method base class
- [ ] I understand why `new` broke the polymorphic call
- [ ] TaskFlow's storage sits behind `ITaskStore`, with a decorator wrapping it
:::

## Common mistakes

::: mistake
**`IFoo` for every `Foo`, automatically.** An interface is a decision, not a naming convention. Ask what the second implementation is. If the honest answer is "a mock in a test", that is still a valid reason — but say so rather than doing it reflexively.

**Deep inheritance hierarchies.** Three levels is usually one too many. Every level is state and behaviour you must hold in your head to understand the leaf class. The next lesson is about the alternative.

**Putting an abstract class where an interface belongs, because you wanted one shared helper method.** That single base class now consumes your only inheritance slot forever. Extension methods or composition are usually better.

**Forgetting `sealed`.** Not a bug, but sealing types that are not designed for inheritance is free and prevents a class of future problems.
:::
