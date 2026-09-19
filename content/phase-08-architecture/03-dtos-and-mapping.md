---
title: DTOs, commands and mapping
summary: The types that cross each boundary, and whether a mapping library earns its place.
minutes: 30
---

## What are we learning?

Which type belongs at which boundary, and an honest evaluation of AutoMapper-style tools.

## The types

```text
HTTP request  ──▶ CreateTaskRequest     (API layer — the wire contract)
                       ↓ map
              ──▶ CreateTaskCommand     (Application layer — the use case input)
                       ↓
              ──▶ TaskItem              (Domain — the entity)
                       ↓
              ──▶ tasks table           (Infrastructure)
                       ↓ project
HTTP response ◀── TaskResponse          (API layer)
```

That looks like a lot of types for one operation. Each one exists for a reason:

- **`CreateTaskRequest`** is your public contract. It changes when clients need it to, and it is versioned.
- **`CreateTaskCommand`** is the use case's input. It may carry things the request does not — the authenticated user id, a correlation id — and it does not carry HTTP concerns.
- **`TaskItem`** is the thing with rules.
- **`TaskResponse`** is shaped for display: flattened names, computed flags, no internal fields.

::: design When to collapse them
Three types per operation is right when the layers genuinely differ. It is ceremony when they do not.

**Collapse `Request` and `Command`** when the use case input is exactly the request plus the current user. Many teams do this and it is fine — pass the request to the service and add the user id as a separate parameter. You lose the ability to change the wire contract independently, which matters for a public API and rarely for an internal one.

**Never collapse the entity into either.** That is the Phase 6 rule and it does not bend: over-posting, over-exposure and a contract you cannot refactor.

**Never collapse the response into the entity.** Same reasons, plus serialisation cycles.

For TaskFlow: keep `Request` and `Command` separate for `POST`/`PUT` where the shapes differ, and collapse them where they are identical. Note the choice; do not apply a rule mechanically.
:::

## Mapping: by hand

```csharp
public static class TaskMapping
{
    public static CreateTaskCommand ToCommand(this CreateTaskRequest request, Guid currentUserId) =>
        new(request.Title, request.Description, request.Priority,
            request.ProjectId, request.DueDate, request.Labels ?? [], currentUserId);

    public static TaskResponse ToResponse(this TaskItem task, string projectName, DateOnly today) =>
        new(task.Id, task.Title, task.Description,
            task.Status.ToString(), task.Priority.ToString(),
            task.ProjectId, projectName, task.AssigneeId,
            task.DueDate, task.IsOverdue(today), task.Labels, task.Comments.Count,
            task.CreatedAt, task.CompletedAt);
}
```

Verbose. Also: debuggable, greppable, compile-time checked, and obvious to a new reader.

## Mapping: with a library

```csharp
// AutoMapper
CreateMap<TaskItem, TaskResponse>()
    .ForMember(d => d.Status, o => o.MapFrom(s => s.Status.ToString()))
    .ForMember(d => d.ProjectName, o => o.MapFrom(s => s.Project.Name))
    .ForMember(d => d.IsOverdue, o => o.MapFrom(s => s.DueDate < DateOnly.FromDateTime(DateTime.UtcNow)));

var response = mapper.Map<TaskResponse>(task);
```

::: design Is a mapping library worth it?
**For:**
- Less code when shapes match closely.
- `ProjectTo<TDto>()` (AutoMapper's EF Core integration) builds the projection expression for you, so the mapping happens in SQL.
- One place for mapping configuration.

**Against:**
- **Failures are at runtime, not compile time.** Rename a property and hand-written mapping fails to build; AutoMapper fails when that endpoint is called. Its config validation helps and is often not wired up.
- **Debugging is harder.** A wrong value means stepping through reflection or expression-tree machinery.
- **You cannot find usages.** "What produces this field?" has no answer from the IDE.
- **It encourages sloppy shapes.** When mapping is free, people stop asking whether the DTO should look like the entity — and end up with responses that are just entities with extra steps.
- **Performance.** Reflection-based mapping is slower than a constructor call, though `ProjectTo` mitigates this for reads.

**A reasonable position:** hand-write mapping. Modern C# records make it a constructor call, and the compile-time safety is worth the keystrokes. If the codebase is large and mappings are numerous and mechanical, consider **Mapperly** — a source generator that produces the hand-written code at compile time, so you get brevity *and* compile-time checking:

```csharp
[Mapper]
public static partial class TaskMapper
{
    public static partial TaskResponse ToResponse(TaskItem task);
}
```

It generates exactly what you would have written, and errors if a property cannot be mapped. That is strictly better than runtime reflection, and it is where new projects should look first.
:::

## Projections are mapping

The best mapping for a read path is no mapping at all:

```csharp
await db.Tasks
    .Where(t => t.ProjectId == projectId)
    .Select(t => new TaskSummaryResponse(t.Id, t.Title, t.Status.ToString(), t.Project.Name, t.Comments.Count))
    .ToListAsync(ct);
```

The DTO is constructed directly from the query. No entity is materialised, no mapper runs, only the needed columns are fetched. Whenever a read path can do this, it should.

::: exercise Level 1 — Guided · Map the boundaries
1. For your three most complex endpoints, write out every type involved and which layer owns it.
2. Where request and command are identical, collapse them — and note it.
3. Where they differ, keep both and write the mapping.
4. Convert every read endpoint to a direct projection with no mapping step.
5. Rename a property on `TaskItem` and confirm the build breaks everywhere it should.
6. Now do the same with AutoMapper configured for one mapping, and observe that the build succeeds and the endpoint fails at runtime.
:::

::: challenge Level 3 · Mapperly, measured
1. Add Mapperly for your entity-to-response mappings.
2. Look at the generated code (`obj/.../Mapper.g.cs`). Compare it with what you wrote by hand.
3. Rename a property and confirm you get a **compile** error.
4. Benchmark three approaches over 100,000 objects with BenchmarkDotNet: hand-written, Mapperly, AutoMapper.
5. Record the numbers, and decide what you will use.
:::

::: solution
Typical results for a nine-property DTO, 100,000 mappings:

```text
| Method       | Mean      | Allocated |
|------------- |----------:|----------:|
| HandWritten  |   1.42 ms |   7.63 MB |
| Mapperly     |   1.44 ms |   7.63 MB |
| AutoMapper   |  11.80 ms |  10.68 MB |
```

Mapperly is within noise of hand-written, because it *is* hand-written — generated at compile time. AutoMapper is roughly 8× slower and allocates more, because it goes through configuration lookup and compiled delegates per property.

**Is 10ms per 100,000 mappings worth caring about?** For a typical API returning 20 items per request: no, not remotely. Do not choose a mapper on these numbers.

Choose on **compile-time safety**, which is where the real difference is. Rename `TaskItem.Title` to `Name`:
- Hand-written: build error, every call site.
- Mapperly: build error, generated at compile time.
- AutoMapper: builds fine. Fails at runtime, on that endpoint, when someone calls it. `AssertConfigurationIsValid()` in a test catches it — if someone wrote that test.

That is the argument, and it has nothing to do with speed.
:::

::: project Mapping in TaskFlow
1. Every boundary type identified and documented in `DECISIONS.md`.
2. Read paths projecting directly — no mapper on any read.
3. Write paths mapping request → command explicitly.
4. Either hand-written mapping or Mapperly, chosen with a written reason.
5. The rename test: change a domain property name and confirm the build catches every site.

Commit.
:::

::: interview How do you map between layers, and do you use AutoMapper?
For read paths I avoid mapping altogether by projecting directly into the response DTO inside the LINQ query, so the DTO is constructed from the SQL result and no entity is materialised.

For write paths I map explicitly. My preference is hand-written mapping, or a source generator like Mapperly, over reflection-based mapping, because the failure mode matters more than the keystrokes: renaming a property breaks a hand-written or generated mapping at compile time, whereas a reflection-based one fails at runtime on whichever endpoint happens to use it.

AutoMapper is not wrong — it has a configuration validation step that catches this if you wire it into a test — but the default failure mode is worse, and it makes mappings hard to find and debug.
:::

::: checkpoint
- [ ] I can name every type at every boundary and say why it exists
- [ ] Read paths project with no mapping step
- [ ] I proved the compile-time vs runtime failure difference myself
- [ ] I benchmarked mapping and know the numbers are not the reason to choose
- [ ] My mapping choice is written down with reasoning
:::

## Common mistakes

::: mistake
**Entities as DTOs.** Over-posting, over-exposure, cycles.

**A mapping library with no configuration test.** Runtime failures on endpoints nobody exercised.

**Mapping on read paths that could project.** Materialising entities to throw them away.

**A command type identical to the request with no added value.** Delete it.

**DTOs shaped exactly like entities.** If the response mirrors the table, you have not thought about what the client needs.
:::
