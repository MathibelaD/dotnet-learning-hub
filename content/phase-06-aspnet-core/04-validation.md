---
title: Validation
summary: Rejecting bad input at the boundary, with error messages a client can act on.
minutes: 35
stage: Stage 3
---

## What are we learning?

Data annotations, FluentValidation, and where validation belongs relative to your domain rules.

## Data annotations

```csharp
public sealed record CreateTaskRequest
{
    [Required(AllowEmptyStrings = false)]
    [StringLength(200, MinimumLength = 1)]
    public required string Title { get; init; }

    [StringLength(2000)]
    public string? Description { get; init; }

    [EnumDataType(typeof(Priority))]
    public Priority Priority { get; init; } = Priority.Normal;

    [Required]
    public Guid ProjectId { get; init; }

    [MaxLength(10)]
    public IReadOnlyList<string>? Labels { get; init; }
}
```

With `[ApiController]`, an invalid model automatically produces a 400 with a `ValidationProblemDetails` body — you write no code for it:

```json
{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "errors": {
    "Title": ["The Title field is required."],
    "Description": ["The field Description must be a string with a maximum length of 2000."]
  }
}
```

That shape is worth knowing — it is a standard (RFC 9457 `ProblemDetails`), and clients can parse it generically.

::: warn Data annotations run out quickly
They cannot express:
- "`DueDate` must be after `StartDate`" — cross-field
- "`AssigneeId` must be a member of the project" — needs a database
- "`Title` must be unique within the project" — needs a database
- "if `Recurring` is true, `Cron` is required" — conditional
- Different rules for create versus update

You *can* implement `IValidatableObject`, but the result is a method full of `if` statements that is awkward to test. For anything beyond shape checks, use FluentValidation.
:::

## FluentValidation

```bash
dotnet add src/TaskFlow.Api package FluentValidation.DependencyInjectionExtensions
```

```csharp
public sealed class CreateTaskRequestValidator : AbstractValidator<CreateTaskRequest>
{
    public CreateTaskRequestValidator(IProjectStore projects)
    {
        RuleFor(x => x.Title)
            .NotEmpty().WithMessage("A title is required.")
            .MaximumLength(200);

        RuleFor(x => x.Description)
            .MaximumLength(2000);

        RuleFor(x => x.Priority)
            .IsInEnum().WithMessage("Priority must be one of: Low, Normal, High, Urgent.");

        RuleFor(x => x.ProjectId)
            .NotEmpty()
            .MustAsync(async (id, ct) => await projects.ExistsAsync(id, ct))
            .WithMessage(x => $"Project {x.ProjectId} does not exist.");

        RuleFor(x => x.DueDate)
            .GreaterThanOrEqualTo(_ => DateOnly.FromDateTime(DateTime.UtcNow))
            .When(x => x.DueDate is not null)
            .WithMessage("Due date cannot be in the past.");

        RuleForEach(x => x.Labels)
            .NotEmpty()
            .MaximumLength(50)
            .Must(l => !TaskRules.ReservedLabels.Contains(l))
            .WithMessage((_, label) => $"'{label}' is a reserved label.");

        RuleFor(x => x.Labels)
            .Must(l => l is null || l.Count <= 10)
            .WithMessage("A task may have at most 10 labels.");
    }
}
```

Registration:

```csharp
builder.Services.AddValidatorsFromAssemblyContaining<CreateTaskRequestValidator>();
```

Validators are classes, so they take constructor dependencies (that `IProjectStore`), and they are trivially unit-testable — which data annotations are not.

## Running validators

FluentValidation no longer auto-integrates with MVC's pipeline by default. Wire it with a filter (lesson 6) so it applies everywhere without repetition:

```csharp
public sealed class ValidationFilter<T>(IValidator<T> validator) : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext ctx, EndpointFilterDelegate next)
    {
        var model = ctx.Arguments.OfType<T>().FirstOrDefault();
        if (model is null) return await next(ctx);

        var result = await validator.ValidateAsync(model, ctx.HttpContext.RequestAborted);
        return result.IsValid
            ? await next(ctx)
            : Results.ValidationProblem(result.ToDictionary());
    }
}
```

For controllers, an `IAsyncActionFilter` doing the same thing — lesson 6 builds it.

## Where does validation belong?

::: design Three layers, three different jobs
```text
1. REQUEST VALIDATION      "Is this input well-formed and plausible?"
   Title not empty, ≤200 chars, priority is a real enum value, project exists.
   Lives in: the API layer, on DTOs.
   Result: 400 with field-level errors.

2. DOMAIN INVARIANTS       "Can this object ever be in this state?"
   A completed task cannot be completed again. Status transitions are legal.
   Lives in: the domain entity's constructor and methods (Phase 1).
   Result: a domain exception -> 409 or 422.

3. AUTHORISATION           "Is this caller allowed to do this?"
   Can this user edit this task? (Phase 9.)
   Result: 403.
```

**These overlap deliberately, and that is not duplication.** Request validation gives the client a good error message before any work happens. Domain invariants make the rule true *no matter who calls* — including a background job, a migration, or a future second API. If you only validate in the API, the first non-API caller breaks your data.

The test for whether a rule belongs in the domain: "would this still have to be true if the request came from somewhere other than HTTP?" Title length — arguably not, it is a wire-format concern. Status transitions — absolutely yes.
:::

## Error response shape

```csharp
// 400 — malformed or invalid input
return ValidationProblem(new ValidationProblemDictionary { ["title"] = ["Title is required."] });

// 422 — well-formed and understood, but semantically unprocessable
return UnprocessableEntity(new ProblemDetails { Title = "Task already complete" });

// 409 — conflicts with the current state of the resource
return Conflict(new ProblemDetails { Title = "Cannot complete a cancelled task" });
```

400 vs 422 is debated. A workable rule: **400** when the request could not be understood or bound (bad JSON, wrong type, missing required field); **422** when it was understood perfectly but the business rules reject it. Pick one convention and apply it everywhere.

::: exercise Level 1 — Guided · Validate the create request
1. Add data annotations to `CreateTaskRequest` and confirm the automatic 400 shape.
2. `POST` an empty title and read the `errors` object carefully.
3. Add FluentValidation and write `CreateTaskRequestValidator` with every rule above.
4. Add the endpoint filter (or action filter) so validators run automatically.
5. Write a unit test for the validator — no HTTP involved:
   ```csharp
   var result = new CreateTaskRequestValidator(store).TestValidate(new CreateTaskRequest { Title = "" });
   result.ShouldHaveValidationErrorFor(x => x.Title);
   ```
6. Confirm the response `errors` keys are camelCase and match your JSON property names — a client that cannot map errors back to fields cannot highlight them.
:::

::: challenge Level 3 · Validation that helps the caller
Requirements:

1. Every message says what is wrong **and** what would be right. "Title is required" → "Title is required and must be 1–200 characters."
2. Field names in the response match the JSON casing exactly.
3. Multiple errors on one field are all returned, not just the first.
4. An async rule (project exists) runs only if the synchronous rules passed — no pointless database calls on an obviously invalid request.
5. Different validators for create and update, with shared rules factored out and not duplicated.
6. A `traceId` on every error response so a client can quote it in a support request.
7. Prove it: a request with five distinct problems returns all five in one response.

Point 7 is the real requirement. An API that returns one error at a time forces the client into a guessing loop.
:::

::: solution
For point 4 — FluentValidation runs rules per property in declaration order and `CascadeMode` controls stopping:

```csharp
public CreateTaskRequestValidator(IProjectStore projects)
{
    RuleLevelCascadeMode = CascadeMode.Stop;   // within a property: stop at the first failure

    RuleFor(x => x.ProjectId)
        .NotEmpty()
        .MustAsync(async (id, ct) => await projects.ExistsAsync(id, ct))
        .WithMessage(x => $"Project {x.ProjectId} does not exist.");
}
```

`RuleLevelCascadeMode = Stop` means the async database check never runs when `NotEmpty` already failed — but rules for *other* properties still run, so point 3 and point 7 are preserved. The two class-level and rule-level cascade settings are independent, and getting them the wrong way round is the usual cause of "I only ever see one error".

For point 5, shared rules as an extension method:

```csharp
public static class TaskRuleExtensions
{
    public static IRuleBuilderOptions<T, string> ValidTaskTitle<T>(this IRuleBuilder<T, string> rule) =>
        rule.NotEmpty().WithMessage("Title is required and must be 1–200 characters.")
            .MaximumLength(200).WithMessage("Title must be 1–200 characters; yours was {TotalLength}.");
}

// used in both validators
RuleFor(x => x.Title).ValidTaskTitle();
```

`{TotalLength}` is a FluentValidation placeholder; there are several (`{PropertyName}`, `{PropertyValue}`, `{MaxLength}`). Using them keeps messages accurate when limits change.

For point 6, wire the trace id into every problem response:
```csharp
builder.Services.AddProblemDetails(options =>
{
    options.CustomizeProblemDetails = ctx =>
    {
        ctx.ProblemDetails.Extensions["traceId"] =
            Activity.Current?.Id ?? ctx.HttpContext.TraceIdentifier;
    };
});
```

`Activity.Current?.Id` is the W3C distributed trace id, which is the same identifier your logs carry (Phase 14). A user quoting it lets you find every log line for that exact request in seconds. It is a five-line change with an outsized payoff.
:::

::: project Validate everything in TaskFlow
1. FluentValidation for every request DTO.
2. A filter running validators automatically.
3. Shared rule extensions between create and update.
4. `traceId` on every error response.
5. Unit tests for at least three validators.
6. Domain invariants **kept** — do not delete the constructor guards from Phase 1. Confirm both layers work by calling the domain directly with invalid data.
7. `.http` file examples showing each error shape.
8. In `DECISIONS.md`: for three specific rules, say which layer they live in and why.

Commit.
:::

::: interview Where should validation live in a web API?
At more than one layer, doing different jobs. Input validation belongs at the boundary, on request DTOs, and produces a 400 with field-level errors so the client can fix the request. Domain invariants belong on the entities themselves — a constructor that refuses to build an invalid object, methods that refuse illegal state transitions — so the rule holds regardless of who calls, including background jobs and future callers that are not HTTP.

That is not duplication: the boundary layer exists to give good error messages cheaply, and the domain layer exists to make invalid states impossible.

In ASP.NET Core, `[ApiController]` turns model-state failures into an RFC 9457 `ProblemDetails` response automatically. For rules beyond shape — cross-field conditions, uniqueness, anything needing a database — FluentValidation is the usual choice, because validators are ordinary classes that take dependencies and can be unit tested.
:::

::: checkpoint
- [ ] A request with five problems returns all five
- [ ] Error field names match my JSON casing
- [ ] Async validation rules do not run when cheaper rules already failed
- [ ] Every error response carries a `traceId`
- [ ] I can explain why both request validation and domain invariants exist
:::

## Common mistakes

::: mistake
**Only validating in the API.** The first background job or migration writes invalid data.

**Returning one error at a time.** Forces the client into a guess-and-retry loop.

**Error keys that do not match the JSON field names.** The client cannot highlight the offending field.

**Messages that state the rule but not the remedy.** "Invalid title" tells the user nothing.

**Database lookups in validators with no cascade control.** A request with an empty id still queries for it.
:::
