---
title: Recognising patterns — and resisting them
summary: The skill is not knowing patterns. It is knowing which problem you have, and when the answer is "none of them".
minutes: 35
---

## What are we learning?

How to go from a problem to a pattern rather than from a pattern to a problem, and how to recognise over-engineering in your own code.

## Problem shapes, not pattern names

Learn to recognise the **shape** of the problem. The name comes after.

| The problem you have | The pattern |
|---|---|
| A switch that grows with every new variant | **Strategy** |
| "Which concrete type do I create?" decided at runtime | **Factory** |
| Behaviour to add around an existing implementation | **Decorator** |
| A third-party type with the wrong shape | **Adapter** |
| "Something happened and an unknown set of things care" | **Observer** |
| Many optional construction parameters with validation | **Builder** |
| The same algorithm with one varying step | **Template Method** |
| A query rule duplicated and drifting | **Specification** |
| An expensive object that should be created once, lazily | **Lazy&lt;T&gt;** / singleton lifetime |
| A tree of things treated uniformly with their leaves | **Composite** |
| A complex subsystem with an awkward API | **Facade** |
| Coordinating several components without them knowing each other | **Mediator** |
| Several repositories that must commit together | **Unit of Work** |
| A collection-like abstraction over storage | **Repository** |

You have implemented most of these already, mostly before learning their names. That order is the correct one.

## The .NET framework already implements many of them

Before writing a pattern, check whether the platform has it:

| Pattern | In the box |
|---|---|
| Factory | The DI container; `IHttpClientFactory`; keyed services |
| Strategy | `Func<T, TResult>`; any interface with one implementation per case |
| Decorator | Middleware; `DelegatingHandler`; Scrutor's `Decorate` |
| Observer | `IObservable<T>`; `event`; DI-resolved handler lists |
| Singleton | `AddSingleton` — **never** write the double-checked-locking class |
| Builder | `WebApplicationBuilder`; `StringBuilder`; object initialisers |
| Iterator | `yield return` |
| Template Method | An abstract base with a `protected abstract` step |
| Adapter | Any wrapper around a third-party client |
| Repository / Unit of Work | `DbSet<T>` and `DbContext` |

::: warn Never write the singleton pattern in C#
```csharp
public sealed class TaskCache          // ❌ the classic Singleton
{
    private static TaskCache? _instance;
    private static readonly object Lock = new();
    public static TaskCache Instance
    {
        get { lock (Lock) { return _instance ??= new TaskCache(); } }
    }
    private TaskCache() { }
}
```
This gives you global mutable state, untestable code, no way to substitute it, and hidden dependencies.

```csharp
services.AddSingleton<ITaskCache, TaskCache>();     // ✅
```
One instance per application, injected explicitly, substitutable in tests, with its lifetime managed for you. The DI container *is* the singleton pattern, done properly.

The only remaining use for `Lazy<T>` in this area is an expensive value inside a class, not a global instance.
:::

## Signs you are over-engineering

::: design The over-engineering checklist
Go through your own code and look for these:

**1. Interfaces with exactly one implementation and no test double.** Ask what the second implementation is. "In case we need it" is not an answer — you are paying now for an option you may never exercise.

**2. Abstract base classes with one subclass.** Merge them.

**3. A factory that only calls `new`.** Delete it.

**4. A generic type parameter used once, in one place, with one type argument.** It is not generic.

**5. Configuration for something that has never changed and will not.** Every setting is a branch in behaviour and a thing to document.

**6. A pattern applied because it appears in a book.** If you cannot state the problem it solves *in this codebase*, remove it.

**7. More than two levels of indirection between a request and the work.** Controller → mediator → handler → service → repository → context is six hops. Some of those are probably not earning their place.

**8. "We might need to switch databases."** Almost nobody does. The abstraction has a real cost today for a benefit that is usually hypothetical — and when a switch does happen, the query dialect differences are the actual work, not the code shape.

**The question to ask about every abstraction: what would break if I deleted it?** If the answer is "nothing, I would just have to edit one more file when X changes", and X has never changed, delete it.
:::

## The counter-signal: under-engineering

Equally real, and equally costly:

- A 400-line method.
- Business rules duplicated in four places, slightly differently.
- A change that requires editing eleven files because nothing is grouped.
- Code that cannot be tested without a database, a network and a clock.
- A switch statement with fourteen cases that has been edited by six people.
- No way to substitute anything, so every test is an integration test.

**Both failure modes come from the same root cause: applying a rule instead of thinking about this specific code.**

## The refactoring trigger

::: design When to introduce an abstraction
**Not the first time.** You have one case; you do not know the axis of variation.

**Not the second time.** Two cases is a coincidence. Duplicating is cheaper than guessing wrong, and a wrong abstraction is harder to remove than duplication is to consolidate.

**The third time.** Now you can see the axis of variation, because you have three examples of it. This is the "rule of three", and it is the most reliable heuristic in this phase.

The exception: when the abstraction is needed for **testing**, one implementation plus a test double is two cases, and that is enough.

Sandi Metz's formulation is worth remembering: *"Duplication is far cheaper than the wrong abstraction."* Removing duplication is mechanical. Removing a wrong abstraction means unpicking every place that bent itself to fit.
:::

::: exercise Level 1 — Guided · Audit your own code
Go through TaskFlow honestly.

1. List every interface. For each, name its implementations — including test doubles.
2. Any with exactly one implementation and no test double: justify it or delete it.
3. List every pattern you applied. For each, write the problem it solves **in this codebase**, in one sentence.
4. Any you cannot justify: remove it and see what breaks.
5. Count the hops from an HTTP request to the database for `POST /api/tasks`. Can any be removed without losing something real?
6. Find the worst duplication and decide whether it has reached three occurrences.

Write the results into `DECISIONS.md`. Removing something you built is harder than building it, and the willingness to do so is a senior trait.
:::

::: challenge Level 3 · Delete something
Pick the abstraction in TaskFlow you are least able to justify, and remove it.

Requirements:
1. All tests still pass.
2. Behaviour is unchanged.
3. Net lines removed, not added.
4. Write down what capability you lost and whether you will miss it.
5. If removing it turns out to be hard, say why — that difficulty is itself information about how much the abstraction was load-bearing.

Then pick the worst duplication and consolidate it, with the same requirements in reverse.
:::

::: solution
The abstractions in a codebase like this that most often fail to justify themselves:

**`IUnitOfWork` with only `SaveChangesAsync`.** It wraps one method of `DbContext`. The argument for it is that the application layer should not reference EF Core — which is real. The argument against is that a one-method interface named after a pattern is close to ceremony. Verdict: **keep it**, but only because it genuinely keeps EF Core out of the application project. If your application layer already referenced EF Core for other reasons, it would be pure overhead.

**`ITaskService` with one implementation.** Justified only if you substitute it in a test. If your controller tests are integration tests using the real service, the interface buys nothing. Verdict: **often delete it** — and notice that this is the opposite of what most tutorials teach.

**A separate `Command` type identical to the `Request` type.** Mapping one record to an identical record. Verdict: **delete**, unless the wire contract needs to version independently of the use case — which for an internal API it usually does not.

**`ICache` wrapping `IMemoryCache`.** `IMemoryCache` is already an interface and already substitutable. Verdict: **delete**, unless you need to swap in a distributed cache later, in which case `HybridCache` (Phase 14) is the framework's answer anyway.

**The generic `InMemoryStore<TEntity, TKey>` from Phase 1.** It was a good exercise; by Phase 8 it has been superseded by concrete fakes per repository, which are simpler and can express per-entity behaviour. Verdict: **probably delete**.

**What makes this challenge worth doing** is that it is genuinely uncomfortable. You built these, they work, and removing them feels like losing ground. Do it anyway, then observe: the code got shorter, nothing broke, and the thing you were protecting against still has not happened.

That experience — deleting an abstraction and finding you do not miss it — is what calibrates your judgement for the next time you are about to add one.
:::

::: project Simplify TaskFlow
1. The audit from the exercise, in `DECISIONS.md`.
2. Remove at least two abstractions you cannot justify.
3. Consolidate at least one triplicated piece of logic.
4. All tests pass; net lines decrease.
5. Add a section to `DECISIONS.md` titled "Things I deliberately did not abstract", with reasons.

Commit. **Phase 12 is complete.**

That last section matters more than it sounds. In an interview, "I considered X and decided against it because Y" is a stronger signal than any amount of structure.
:::

::: interview How do you decide when to introduce an abstraction?
I wait until there is evidence of the axis of variation. The first case tells you nothing; the second could be a coincidence; the third shows you what actually varies. Before that, duplication is cheaper than a wrong abstraction — consolidating duplication is mechanical, whereas removing a wrong abstraction means unpicking everything that bent to fit it.

The exception is testing: if I need to substitute something in a test, one implementation plus a test double is enough reason for an interface.

I also check the framework first. The DI container is a factory and a singleton manager, `DbContext` is a unit of work, middleware is a decorator chain, `yield return` is an iterator. Writing those by hand is work that has already been done better.

And I try to ask the deletion question about abstractions I already have: what would actually break if this were gone? If the honest answer is "I would edit one more file when something changes that has never changed", it is not paying for itself.
:::

::: checkpoint Phase 12 complete
- [ ] I can state the problem shape for ten patterns without their names
- [ ] I audited every interface in TaskFlow for justification
- [ ] I deleted at least two abstractions and nothing broke
- [ ] I consolidated duplication that had reached three occurrences
- [ ] `DECISIONS.md` records what I deliberately did not abstract
:::

## Common mistakes

::: mistake
**Learning pattern names before problem shapes.** You then look for places to apply them.

**Writing the Singleton pattern in C#.** `AddSingleton`.

**An interface per class as a reflex.** Ask what the second implementation is.

**Abstracting on the first occurrence.** You are guessing the axis of variation.

**Never removing anything.** Codebases grow abstractions the way they grow features, and nobody prunes.
:::
