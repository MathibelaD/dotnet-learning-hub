---
title: Claims, roles and policies
summary: Expressing real authorization rules — including the ones that depend on the specific resource.
minutes: 40
stage: Stage 5
---

## What are we learning?

Role checks, policy-based authorization, and resource-based authorization — which is what most real rules turn out to need.

## Roles are the simple case

```csharp
[Authorize(Roles = "Admin")]
[Authorize(Roles = "Admin,Manager")]              // either
if (User.IsInRole("Admin")) { }
```

Roles are just claims of type `ClaimTypes.Role`. They work well when permissions are coarse and stable.

They stop working when rules become conditional: "a manager may edit a task **in a project they own**". A role cannot express "in a project they own", because that depends on which task.

## Policies

A policy is a named, reusable set of requirements.

```csharp
builder.Services.AddAuthorization(options =>
{
    options.AddPolicy("EmailVerified", p => p.RequireClaim("email_verified", "true"));

    options.AddPolicy("Manager", p => p.RequireRole("Manager", "Admin"));

    options.AddPolicy("Adult", p => p.RequireAssertion(context =>
        context.User.FindFirst("dob") is { } dob &&
        DateOnly.Parse(dob.Value).AddYears(18) <= DateOnly.FromDateTime(DateTime.UtcNow)));

    options.AddPolicy("MinimumSeniority", p => p.Requirements.Add(new SeniorityRequirement(years: 2)));
});
```

```csharp
[Authorize(Policy = "EmailVerified")]
```

Policies beat scattered role strings because the rule has a name and one definition. Changing who counts as a manager is one edit, not forty.

### A custom requirement and handler

```csharp
public sealed record SeniorityRequirement(int Years) : IAuthorizationRequirement;

public sealed class SeniorityHandler(TimeProvider clock) : AuthorizationHandler<SeniorityRequirement>
{
    protected override Task HandleRequirementAsync(
        AuthorizationHandlerContext context, SeniorityRequirement requirement)
    {
        if (context.User.FindFirst("hired_on") is { } claim &&
            DateOnly.TryParse(claim.Value, out var hired) &&
            hired.AddYears(requirement.Years) <= DateOnly.FromDateTime(clock.GetUtcNow().Date))
        {
            context.Succeed(requirement);
        }

        return Task.CompletedTask;     // NOT calling Fail() lets another handler succeed
    }
}
```

::: note `Succeed` and `Fail` are not symmetric
A requirement is satisfied if **any** handler calls `Succeed`. Calling `Fail` is a **veto** — it fails the whole policy regardless of what any other handler says.

So: call `Succeed` when your condition is met, and simply return otherwise. Only call `Fail` for a hard denial that nothing should override, such as "this account is suspended".
:::

## Resource-based authorization

This is the one that matters, and the one most tutorials skip.

The question is not "may this user edit tasks?" but "may this user edit **this** task?" — which cannot be answered until the task is loaded.

```csharp
public sealed class TaskAuthorizationHandler(IProjectRepository projects)
    : AuthorizationHandler<OperationAuthorizationRequirement, TaskItem>
{
    protected override async Task HandleRequirementAsync(
        AuthorizationHandlerContext context,
        OperationAuthorizationRequirement requirement,
        TaskItem task)
    {
        var userId = context.User.GetUserId();
        if (userId is null) return;

        if (context.User.IsInRole("Admin")) { context.Succeed(requirement); return; }

        var project = await projects.GetAsync(task.ProjectId, CancellationToken.None);
        if (project is null) return;

        var isOwner = project.OwnerId == userId;
        var isMember = project.IsMember(userId.Value);
        var isAssignee = task.AssigneeId == userId;

        var allowed = requirement.Name switch
        {
            nameof(TaskOperations.Read)   => isMember,
            nameof(TaskOperations.Update) => isAssignee || isOwner,
            nameof(TaskOperations.Delete) => isOwner,
            nameof(TaskOperations.Assign) => isOwner,
            _ => false
        };

        if (allowed) context.Succeed(requirement);
    }
}

public static class TaskOperations
{
    public static readonly OperationAuthorizationRequirement Read   = new() { Name = nameof(Read) };
    public static readonly OperationAuthorizationRequirement Update = new() { Name = nameof(Update) };
    public static readonly OperationAuthorizationRequirement Delete = new() { Name = nameof(Delete) };
    public static readonly OperationAuthorizationRequirement Assign = new() { Name = nameof(Assign) };
}
```

Used in a controller:

```csharp
[HttpPut("{id:guid}")]
public async Task<ActionResult<TaskResponse>> Update(Guid id, UpdateTaskRequest request, CancellationToken ct)
{
    var task = await tasks.GetAsync(id, ct);
    if (task is null) return NotFound();

    var authorised = await authorization.AuthorizeAsync(User, task, TaskOperations.Update);
    if (!authorised.Succeeded) return Forbid();

    // ...
}
```

::: warn 404 or 403 for a resource you may not see?
If a user may not read task `X`, should `GET /api/tasks/X` return 403 or 404?

**403** is truthful and helps a legitimate user understand they need access.

**404** hides existence. With 403, an attacker can enumerate which ids exist by observing 403 versus 404 — which leaks how many tasks you have, and whether a specific one exists.

The usual rule: **404 when the resource's existence is itself sensitive; 403 when it is not.** For TaskFlow, a task in another user's private project should be 404. For a resource in a project you are a member of but lack permission on, 403 is right and more useful.

Whichever you choose, be consistent, and make sure the timing does not leak what the status code hides.
:::

## Getting the user id

```csharp
public static class ClaimsPrincipalExtensions
{
    public static Guid? GetUserId(this ClaimsPrincipal principal) =>
        Guid.TryParse(principal.FindFirstValue(JwtRegisteredClaimNames.Sub), out var id) ? id : null;

    public static Guid GetRequiredUserId(this ClaimsPrincipal principal) =>
        principal.GetUserId() ?? throw new UnauthorizedAccessException("No subject claim.");
}
```

::: warn `ClaimTypes.NameIdentifier` versus `sub`
`JwtSecurityTokenHandler` historically **remaps** short JWT claim names to long WS-Federation URIs, so `sub` arrives as `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier`. This is why `User.FindFirstValue("sub")` returns null and everyone loses an hour.

Turn the remapping off:
```csharp
JwtSecurityTokenHandler.DefaultInboundClaimTypeMap.Clear();
```
or use the newer `JsonWebTokenHandler`, which does not remap. Do this once, at startup, before anything else.
:::

::: exercise Level 1 — Guided · Build up the layers
1. Disable inbound claim mapping and confirm `sub` is readable directly.
2. Add a `Role` claim at login; protect an endpoint with `[Authorize(Roles = "Admin")]`.
3. Convert it to a named policy and use `[Authorize(Policy = "...")]`.
4. Write a custom requirement and handler (email verified, say).
5. Implement `TaskAuthorizationHandler` for read, update, delete and assign.
6. Wire it into your task endpoints.
7. Test every combination: owner, member, assignee, admin, outsider — for each operation. That is 20 cases; write them as a `[Theory]`.
:::

::: challenge Level 3 · Authorization that scales past one resource
Resource-based checks are per-object. `GET /api/tasks` returns a list — you cannot run 20 authorization checks per page and you must not return tasks the caller cannot see.

Requirements:
1. List endpoints return only what the caller may read, **filtered in SQL**, not in memory.
2. No N+1 authorization checks.
3. The filter is defined once and reused across every list endpoint.
4. Admins see everything.
5. A test proving that user A never sees user B's private project's tasks — including through search, filters and pagination.
6. The count and the facets also reflect the filter, so a user cannot infer hidden data from a total.

Point 6 is the subtle one. Think about what `totalCount` leaks.
:::

::: solution
```csharp
public interface ITaskQueryScope
{
    IQueryable<TaskItem> Visible(IQueryable<TaskItem> query);
}

public sealed class UserTaskQueryScope(ICurrentUser user) : ITaskQueryScope
{
    public IQueryable<TaskItem> Visible(IQueryable<TaskItem> query)
    {
        if (user.IsInRole("Admin")) return query;

        var userId = user.RequiredUserId;
        return query.Where(t =>
            t.Project.OwnerId == userId ||
            t.Project.Members.Any(m => m.UserId == userId));
    }
}
```

Applied first in every query:

```csharp
var q = scope.Visible(db.Tasks.AsNoTracking());
// ... then all the user's filters
var total = await q.CountAsync(ct);
var page = await q.OrderBy(...).Skip(...).Take(...).Select(...).ToListAsync(ct);
```

One place, one `EXISTS` subquery in SQL, no per-row checks, no N+1.

**Requirement 6 is the interesting one.** If `totalCount` were computed before the scope filter, a user could learn how many tasks exist in projects they cannot see — and by varying filters, infer their titles or labels one bit at a time. Applying the scope *first*, before the count and before the facets, closes that. The rule: **authorization filtering is the first operation in the pipeline, never the last.**

An alternative implementation is an EF Core **global query filter** (Phase 7):
```csharp
builder.HasQueryFilter(t => t.Project.OwnerId == _currentUserId || ...);
```
Automatic and impossible to forget — which is its strength and its weakness. It applies to *every* query including background jobs and admin tooling, where the "current user" may not exist, and `IgnoreQueryFilters()` silently disables it with no audit trail. The explicit scope is more typing and far easier to reason about; for a security boundary, explicit wins.

The test for requirement 5 should be a `[Theory]` covering search, filter and page combinations, not a single happy path. Authorization bugs hide in the paths nobody tested.
:::

::: project Authorization for TaskFlow
1. Inbound claim mapping disabled.
2. Roles issued in the token; `Admin`, `Manager`, `Member`.
3. Named policies for every coarse rule.
4. `TaskAuthorizationHandler` and `ProjectAuthorizationHandler` for resource rules.
5. `ITaskQueryScope` applied first in every list and count query.
6. 404 versus 403 decided and documented, and applied consistently.
7. A full `[Theory]` matrix of user type × operation.
8. `DECISIONS.md` updated with the final authorization table from lesson 1 — including anything you changed while implementing it.

Commit.
:::

::: interview How do you implement authorization beyond simple roles?
Roles work when permissions are coarse, but most real rules depend on the specific resource — "may this user edit *this* task" rather than "may this user edit tasks". ASP.NET Core handles that with resource-based authorization: an `AuthorizationHandler<TRequirement, TResource>` that receives both the principal and the loaded object, so it can check ownership, membership or assignment.

For anything that returns a list, per-object checks do not scale, so the same rule is expressed as a query filter applied in SQL — and applied *first*, before counting and before faceting, because otherwise the total count leaks how much data the user cannot see.

Policies are the unit of reuse: a named requirement with a handler, so a rule like "email verified" or "project owner" is defined once and referenced by name rather than duplicated as role strings across forty endpoints.
:::

::: checkpoint
- [ ] `sub` is readable without the claim-type remapping
- [ ] I implemented a custom requirement and handler
- [ ] Resource-based checks cover read, update, delete and assign
- [ ] List endpoints filter in SQL, and the count reflects the filter
- [ ] I have a test matrix covering every user type against every operation
:::

## Common mistakes

::: mistake
**Roles for everything.** They cannot express "belongs to this project".

**Authorization checks after filtering.** The total count leaks hidden data.

**Per-row authorization on a list.** N+1, and unusable past a few dozen rows.

**Calling `context.Fail()` in a handler that simply does not apply.** It vetoes the whole policy, including rules that would have succeeded.

**`User.FindFirstValue("sub")` returning null.** Claim-type remapping. Turn it off.
:::
