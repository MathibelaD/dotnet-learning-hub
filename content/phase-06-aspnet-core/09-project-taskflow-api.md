---
title: "Checkpoint: the TaskFlow API"
summary: Assemble everything from Phase 6 into a complete, documented, correctly-behaving REST API.
minutes: 120
stage: Stage 3
---

## What are we learning?

Nothing new. This is **Stage 3** of the project, complete.

::: stop
Allow two hours. Do not read the solution notes until your version runs.
:::

## The deliverable

A REST API over your existing in-memory store, with:

```text
GET    /api/tasks                      list, filter, sort, page
POST   /api/tasks                      create
GET    /api/tasks/{id}                 read one
PUT    /api/tasks/{id}                 replace
PATCH  /api/tasks/{id}                 partial update
DELETE /api/tasks/{id}                 delete
POST   /api/tasks/{id}/complete        transition
POST   /api/tasks/{id}/start           transition
POST   /api/tasks/{id}/block           transition, takes a reason
POST   /api/tasks/{id}/cancel          transition
POST   /api/tasks/{id}/assign          assign to a user
DELETE /api/tasks/{id}/assign          unassign
GET    /api/tasks/{id}/comments        sub-collection
POST   /api/tasks/{id}/comments        add a comment
POST   /api/tasks/{id}/labels          add a label
DELETE /api/tasks/{id}/labels/{label}  remove a label

GET    /api/projects                   list
POST   /api/projects                   create
GET    /api/projects/{id}              read
GET    /api/projects/{id}/tasks        tasks in a project
GET    /api/projects/{id}/stats        the Phase 3 statistics

GET    /health                         liveness
GET    /openapi/v1.json                the document
```

## Requirements

### Contract
- Every request and response is a DTO. No domain type in any signature.
- JSON: camelCase, string enums, nulls omitted, unknown members rejected.
- `PagedResponse<T>` for every collection, echoing the effective page and size.

### Behaviour
- Correct status codes throughout — reuse your table from lesson 1.
- `201 Created` with a `Location` header from `CreatedAtAction` on every create.
- `204 No Content` on delete and on successful transitions that return nothing.
- `409 Conflict` for illegal state transitions.
- `422` for business-rule rejections.
- `404` for missing resources, and for sub-resources of missing parents.

### Validation
- FluentValidation on every request DTO, run by a filter.
- All errors returned at once, with camelCase field keys.

### Errors
- No try/catch in any controller.
- Global `IExceptionHandler` chain producing `ProblemDetails`.
- No internal detail in Production responses; `traceId` on every error.

### Pipeline
- Explicit, commented, in the canonical order.
- Correlation id middleware.
- Request timing with a warning over 500ms.
- Security headers.

### Documentation
- `[ProducesResponseType]` for every response of every action.
- XML summaries and examples.
- OpenAPI generated at build time and committed.
- A `.http` file exercising every endpoint, including failure cases.

### Quality
- `TreatWarningsAsErrors`, nullable enabled, no `!` operators.
- The domain project still references nothing.

## Checkpoint

::: checkpoint Work through this honestly
- [ ] Every endpoint in the table exists and works
- [ ] Every status code is deliberate and I can justify it
- [ ] `curl` with a bad body returns all validation errors at once
- [ ] `curl` for a missing id returns 404 with `ProblemDetails`
- [ ] Completing an already-completed task returns 409
- [ ] Running in Production leaks nothing in an error response
- [ ] The OpenAPI UI lets me execute every endpoint successfully
- [ ] The `.http` file covers every endpoint and every error case
- [ ] The build is warning-free
- [ ] No controller contains a try/catch
- [ ] No domain type appears in a controller signature
:::

::: project Build it
```bash
cd ~/taskflow
dotnet run --project src/TaskFlow.Api
```

Commit in logical steps — one per controller is reasonable. When it is all working:

```bash
git commit -am "Stage 3 complete: TaskFlow REST API"
git tag stage-3
```

Tag each stage. In Phase 16 you will walk back through the tags to see how the application evolved, which is genuinely the best interview preparation available.
:::

::: solution Notes on the parts people get wrong
**State transitions as sub-resources.** `POST /api/tasks/{id}/complete` with no body, returning `204` or the updated task. The alternative — `PUT /api/tasks/{id}` with `{"status": "Completed"}` — forces the API to infer intent from a state diff, cannot express "block with a reason", and lets a client set any status directly, bypassing your transition rules. The sub-resource approach makes each legal operation an explicit endpoint.

```csharp
[HttpPost("{id:guid}/complete")]
[ProducesResponseType<TaskResponse>(StatusCodes.Status200OK)]
[ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
[ProducesResponseType<ProblemDetails>(StatusCodes.Status409Conflict)]
public async Task<ActionResult<TaskResponse>> Complete(Guid id, CancellationToken ct)
{
    var task = await service.CompleteAsync(id, ct);    // throws TaskNotFound / TaskState
    return Ok(task.ToResponse());
}
```

Three lines. The 404 and the 409 come from your exception handler, which is exactly why you built it.

**Sub-resources of a missing parent.** `GET /api/tasks/{missingId}/comments` must be 404, not 200 with `[]`. An empty array says "this task exists and has no comments", which is a different and false statement.

**`PUT` vs `PATCH` semantics.** `PUT` replaces: a field absent from the body is *cleared*, not left alone. If your `PUT` leaves absent fields alone, it is a `PATCH` wearing a `PUT`'s name, and a client that omits `description` to mean "clear it" will be confused. Either implement replace semantics properly or only offer `PATCH`.

**The label sub-resource.** `DELETE /api/tasks/{id}/labels/{label}` needs URL encoding for labels with spaces. Test it: `curl -X DELETE "localhost:5080/api/tasks/$ID/labels/needs%20review"`.

**Pagination metadata.** Echo the *effective* page and page size, not what was requested. If a client asks for `pageSize=5000` and you clamp to 100, the response must say 100 — otherwise the client computes `totalPages` wrongly and loops forever.

**`GET /api/projects/{id}/stats`.** Reuse `TaskStatistics.From(...)` from Phase 3 unchanged. That it plugs in with no modification is the payoff for keeping it in the application layer rather than the API.
:::

::: interview Walk me through your API design
Practise saying this out loud about your own code:

> "It is a REST API over a task management domain. Resources are nouns — tasks, projects, comments — and state transitions that are not CRUD are modelled as sub-resources, so `POST /tasks/{id}/complete` rather than a `PUT` with a status field. That keeps the domain's transition rules in the domain: the API cannot set a status directly.
>
> Every endpoint has its own request and response DTOs, so the wire contract is decoupled from the entities — no over-posting, and a domain rename is not a breaking change. Validation runs at the boundary with FluentValidation via a filter, and the domain keeps its own invariants so the rules hold for any caller.
>
> There is no error handling in the controllers. Domain exceptions map to status codes in a global `IExceptionHandler` chain, and everything returns RFC 9457 `ProblemDetails` with a trace id that correlates to the logs. In production the response carries no exception detail.
>
> The OpenAPI document is generated at build time and committed, and CI fails if it changes without being reviewed."

If every sentence of that is true of code you wrote, you are in good shape.
:::

::: checkpoint Phase 6 complete
- [ ] Stage 3 is committed and tagged
- [ ] I can demo the whole API from the `.http` file in two minutes
- [ ] I can justify every status code, every DTO and every pipeline ordering decision
- [ ] I am ready to replace the in-memory store with a real database
:::
