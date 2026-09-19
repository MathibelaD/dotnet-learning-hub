---
title: Observer and Mediator
summary: Decoupling "something happened" from "here is what to do about it" — and the cost of doing it.
minutes: 35
---

## What are we learning?

Two behavioural patterns that reduce coupling, and an honest look at what they cost in readability.

## The problem shapes

```text
OBSERVER   "Something happened here, and an unknown set of things care about it."
MEDIATOR   "Several components need to coordinate, and I do not want them to know each other."
```

## Observer

You built this in Phase 11 as domain events:

```csharp
public interface IDomainEvent;
public sealed record TaskCompleted(Guid TaskId, Guid ProjectId, string Title, DateTimeOffset At) : IDomainEvent;

public interface IEventHandler<in TEvent> where TEvent : IDomainEvent
{
    Task HandleAsync(TEvent domainEvent, CancellationToken ct);
}

public sealed class SendCompletionEmail(IEmailSender email) : IEventHandler<TaskCompleted> { }
public sealed class UpdateProjectStats(IStatsCache cache) : IEventHandler<TaskCompleted> { }
public sealed class WriteAuditRecord(IAuditLog audit) : IEventHandler<TaskCompleted> { }
```

The publisher:

```csharp
public sealed class DomainEventPublisher(IServiceProvider services, ILogger<DomainEventPublisher> logger)
    : IDomainEventPublisher
{
    public async Task PublishAsync<TEvent>(TEvent domainEvent, CancellationToken ct)
        where TEvent : IDomainEvent
    {
        foreach (var handler in services.GetServices<IEventHandler<TEvent>>())
        {
            try
            {
                await handler.HandleAsync(domainEvent, ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogError(ex, "Handler {Handler} failed for {Event}",
                    handler.GetType().Name, typeof(TEvent).Name);
            }
        }
    }
}
```

C# also has the language-level version (`event`, Phase 2) and `IObservable<T>`/Rx. For server applications, the DI-resolved handler list above is usually the right shape: handlers are ordinary classes with injected dependencies, testable in isolation, with no subscription lifetime to manage.

::: warn What Observer costs you
The benefit is real: the completion logic does not know that emails exist, and adding a handler touches nothing.

The cost is equally real, and people understate it:

**1. Control flow becomes invisible.** Reading `CompleteAsync` tells you nothing about what happens next. Finding out means searching for handlers of `TaskCompleted` — and in a large codebase that is genuinely hard.

**2. Ordering is implicit.** If the audit record must be written before the email, nothing in the code says so, and DI registration order is not a specification.

**3. Debugging is harder.** A stack trace shows the publisher, not the caller's intent.

**4. Failures are ambiguous.** Is a failed handler fatal? Partially fatal? The publisher above swallows and logs, which is right for a notification and wrong for something that must happen.

**Use it when:** the set of reactions genuinely varies, is optional, or belongs to other modules.

**Do not use it when:** there are two reactions, both mandatory, both owned by the same team. `await email.SendAsync(); await audit.WriteAsync();` is clearer, ordered, and its failures are unambiguous. A direct call is not a design failure.
:::

## Mediator

```csharp
public interface IRequest<TResponse>;
public interface IRequestHandler<in TRequest, TResponse> where TRequest : IRequest<TResponse>
{
    Task<TResponse> HandleAsync(TRequest request, CancellationToken ct);
}

public sealed record CompleteTaskCommand(Guid TaskId) : IRequest<TaskResponse>;

public sealed class CompleteTaskHandler(ITaskRepository tasks, IUnitOfWork uow, TimeProvider clock)
    : IRequestHandler<CompleteTaskCommand, TaskResponse>
{
    public async Task<TaskResponse> HandleAsync(CompleteTaskCommand request, CancellationToken ct)
    {
        var task = await tasks.GetAsync(request.TaskId, ct) ?? throw new TaskNotFoundException(request.TaskId);
        task.Complete(clock);
        await uow.SaveChangesAsync(ct);
        return task.ToResponse();
    }
}
```

The controller becomes uniform:

```csharp
[HttpPost("{id:guid}/complete")]
public async Task<ActionResult<TaskResponse>> Complete(Guid id, CancellationToken ct) =>
    Ok(await mediator.SendAsync(new CompleteTaskCommand(id), ct));
```

The real payoff is the **pipeline**, which lets you add cross-cutting behaviour to every command in one place:

```csharp
public interface IPipelineBehaviour<TRequest, TResponse>
{
    Task<TResponse> HandleAsync(TRequest request, Func<Task<TResponse>> next, CancellationToken ct);
}

public sealed class ValidationBehaviour<TRequest, TResponse>(IEnumerable<IValidator<TRequest>> validators)
    : IPipelineBehaviour<TRequest, TResponse>
{
    public async Task<TResponse> HandleAsync(TRequest request, Func<Task<TResponse>> next, CancellationToken ct)
    {
        var failures = (await Task.WhenAll(validators.Select(v => v.ValidateAsync(request, ct))))
            .SelectMany(r => r.Errors).Where(f => f is not null).ToList();

        if (failures.Count > 0) throw new ValidationException(failures);
        return await next();
    }
}

public sealed class LoggingBehaviour<TRequest, TResponse> : IPipelineBehaviour<TRequest, TResponse> { }
public sealed class TransactionBehaviour<TRequest, TResponse> : IPipelineBehaviour<TRequest, TResponse> { }
```

Validation, logging, transactions and metrics now apply to every command automatically, and they are the Decorator pattern applied generically.

::: design Is MediatR worth it?
MediatR is the library that implements this, and it is one of the most common in .NET — and one of the most argued about. (Note it moved to a commercial licence for larger organisations in 2025, which has pushed some teams to alternatives or to hand-rolling it, as above.)

**For:**
- Uniform controllers; no service with fifteen methods.
- Pipeline behaviours for cross-cutting concerns, applied once.
- A command is a class, so it is trivially testable and self-documenting.
- Handlers are small and single-purpose — SRP by construction.

**Against:**
- **"Go to definition" stops working.** `mediator.SendAsync(new CompleteTaskCommand(id))` does not navigate to the handler; you search by type name.
- **Two types per operation** — a command and a handler — where a service method was one method.
- **It is not really a mediator.** Nothing is being mediated between peers; it is a dispatcher with a pipeline. The pipeline is the actual value.
- **It can hide a missing design.** Fifty commands with no organising structure is not better than five cohesive services.

**An honest position:** the pipeline is worth a lot; the dispatch is worth little. If you want validation, logging and transactions applied uniformly, MediatR gives you that cheaply. If you already have filters doing validation and a unit of work handling transactions, it adds indirection for no gain.

**For TaskFlow: it is a reasonable choice and not a necessary one.** Build it by hand as in this lesson so you understand what it does, then decide. Being able to argue either side is what an interviewer is actually probing.
:::

::: exercise Level 1 — Guided · Build a small mediator
1. `IRequest<TResponse>`, `IRequestHandler<,>`, `IPipelineBehaviour<,>` and a dispatcher that resolves from DI.
2. Convert three endpoints to commands and handlers.
3. Add validation, logging and timing behaviours.
4. Confirm all three apply to every command with no per-command code.
5. Compare a converted controller action with the original.
6. Time a request before and after — measure the dispatch overhead.
7. Decide whether you are keeping it, and write down why.
:::

::: challenge Level 3 · Events plus mediator, done carefully
Requirements:

1. Commands go through the mediator with validation, logging, transaction and metrics behaviours.
2. Domain events raised inside a handler publish **after** the transaction commits.
3. Handlers that must not be lost use the outbox.
4. Handler ordering is explicit where it matters, and documented where it does not.
5. A failing optional handler does not fail the command; a failing required handler does.
6. A diagnostic endpoint listing every command, its handler and its behaviours — so control flow is discoverable again.
7. A test proving an event handler failure does not roll back the command.

Requirement 6 is the mitigation for the biggest cost of these patterns. Take it seriously.
:::

::: solution
Requirement 5 needs the distinction to be in the type system, not in a comment:

```csharp
public interface IEventHandler<in TEvent> where TEvent : IDomainEvent
{
    Task HandleAsync(TEvent domainEvent, CancellationToken ct);
}

/// <summary>A handler whose failure fails the whole operation.</summary>
public interface IRequiredEventHandler<in TEvent> : IEventHandler<TEvent> where TEvent : IDomainEvent;
```

```csharp
foreach (var handler in handlers)
{
    try { await handler.HandleAsync(e, ct); }
    catch (Exception ex) when (handler is not IRequiredEventHandler<TEvent>)
    {
        logger.LogError(ex, "Optional handler {Handler} failed", handler.GetType().Name);
    }
}
```

The exception filter means a required handler's exception is not caught at all and propagates — which is exactly the intent, expressed once rather than as an `if` in every handler.

Requirement 6, the discoverability endpoint, is the piece that makes this architecture liveable:

```csharp
app.MapGet("/diagnostics/commands", (IServiceProvider services) =>
{
    var commands = typeof(CompleteTaskCommand).Assembly.GetTypes()
        .Where(t => t.GetInterfaces().Any(i => i.IsGenericType &&
                    i.GetGenericTypeDefinition() == typeof(IRequest<>)))
        .Select(t => new
        {
            Command = t.Name,
            Handler = FindHandler(services, t)?.Name,
            Behaviours = FindBehaviours(services, t).Select(b => b.Name),
            Events = FindRaisedEvents(t).Select(e => new
            {
                Event = e.Name,
                Handlers = FindEventHandlers(services, e).Select(h => h.Name)
            })
        });

    return Results.Ok(commands);
}).RequireAuthorization("Admin");
```

The output is the control-flow map that the patterns took away:

```json
{
  "command": "CompleteTaskCommand",
  "handler": "CompleteTaskHandler",
  "behaviours": ["LoggingBehaviour", "ValidationBehaviour", "TransactionBehaviour"],
  "events": [{ "event": "TaskCompleted",
               "handlers": ["SendCompletionEmail", "UpdateProjectStats", "WriteAuditRecord"] }]
}
```

**This is the principle worth taking away: if a pattern removes information a reader needs, give it back deliberately.** Indirection is a trade, not a free improvement, and paying the cost without recovering any of it is how codebases become unnavigable. Generate documentation, add a diagnostic endpoint, or write an architecture decision record — but do something.
:::

::: project Observer and Mediator in TaskFlow
1. Domain events with optional and required handlers.
2. Events published after commit; durable ones via the outbox.
3. Either a hand-rolled mediator or MediatR for commands, with validation, logging, transaction and metrics behaviours.
4. The `/diagnostics/commands` endpoint, admin-only.
5. A test proving an optional handler failure does not roll back.
6. `DECISIONS.md`: whether you kept the mediator, and the argument both ways.

Commit.
:::

::: interview When would you use MediatR or a mediator pattern?
The genuine value is the pipeline, not the dispatch. Wrapping every command in behaviours — validation, logging, transaction management, metrics — means those concerns are written once and applied uniformly, and each handler stays small and single-purpose.

The cost is discoverability. `mediator.Send(new CompleteTaskCommand(id))` does not navigate to the handler, so control flow becomes something you search for rather than something you read. And you get two types per operation where a service method was one.

So I would use it when there are enough commands for the pipeline to pay for itself and cross-cutting concerns that would otherwise be duplicated. I would not add it to a service with a handful of operations where filters already handle validation and a unit of work already handles transactions. And if I did use it, I would add something — a diagnostic endpoint or generated documentation — to give back the control-flow visibility it removes.
:::

::: checkpoint
- [ ] I built a mediator by hand and understand what the library does
- [ ] Pipeline behaviours apply to every command with no per-command code
- [ ] Required and optional event handlers are distinguished in the type system
- [ ] I have a way to discover control flow that the indirection removed
- [ ] I decided for or against keeping the mediator, with an argument
:::

## Common mistakes

::: mistake
**Events for two mandatory, same-team reactions.** A direct call is clearer and ordered.

**Implicit handler ordering.** Registration order is not a specification.

**Every handler failure treated the same.** Some are fatal; say which.

**Adopting a mediator for uniformity alone.** Uniform indirection is still indirection.

**Indirection with nothing given back.** If readers cannot follow the flow, add a way for them to.
:::
