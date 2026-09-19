---
title: OpenAPI and documentation
summary: Generated, accurate, executable documentation — and why hand-written API docs always rot.
minutes: 30
stage: Stage 3
---

## What are we learning?

Producing an OpenAPI description of your API, making it accurate rather than merely present, and what you get downstream for free.

## Built-in OpenAPI

.NET 9 added first-party OpenAPI document generation, so Swashbuckle is no longer required for the document itself.

```bash
dotnet add src/TaskFlow.Api package Microsoft.AspNetCore.OpenApi
```

```csharp
builder.Services.AddOpenApi();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();                  // serves /openapi/v1.json
    app.MapScalarApiReference();       // interactive UI at /scalar/v1
}
```

For the UI you have choices: **Scalar** (`Scalar.AspNetCore`) is the modern default, **Swagger UI** (`Swashbuckle.AspNetCore.SwaggerUI`) is the one everyone recognises. Either works against the same document.

::: warn Do not expose the UI in production without thinking
An OpenAPI document is a complete map of your attack surface: every endpoint, every parameter, every shape. For a public API that is the point. For an internal one it is reconnaissance.

Default to Development-only, and if you do expose it in production, put it behind authentication.
:::

## Making the document accurate

A generated document is only as good as what the generator can see. By default it will describe a `POST` as returning `200 OK` with no body, which is wrong.

```csharp
/// <summary>Creates a task in the given project.</summary>
/// <param name="request">The task to create.</param>
/// <response code="201">The task was created.</response>
/// <response code="400">The request was invalid.</response>
/// <response code="404">The project does not exist.</response>
[HttpPost]
[ProducesResponseType<TaskResponse>(StatusCodes.Status201Created)]
[ProducesResponseType<ValidationProblemDetails>(StatusCodes.Status400BadRequest)]
[ProducesResponseType<ProblemDetails>(StatusCodes.Status404NotFound)]
public async Task<ActionResult<TaskResponse>> Create(CreateTaskRequest request, CancellationToken ct)
```

For minimal APIs:

```csharp
app.MapPost("/api/tasks", Handler)
   .WithName("CreateTask")
   .WithSummary("Creates a task")
   .Produces<TaskResponse>(StatusCodes.Status201Created)
   .ProducesValidationProblem()
   .ProducesProblem(StatusCodes.Status404NotFound);
```

To include your XML doc comments, enable the file and feed it in:

```xml
<GenerateDocumentationFile>true</GenerateDocumentationFile>
<NoWarn>$(NoWarn);CS1591</NoWarn>
```

## Examples and schema detail

```csharp
public sealed record CreateTaskRequest
{
    /// <summary>A short description of the work. 1–200 characters.</summary>
    /// <example>Fix the login redirect loop</example>
    public required string Title { get; init; }

    /// <example>High</example>
    public Priority Priority { get; init; } = Priority.Normal;
}
```

An example value is worth more than a paragraph of prose — it is what people copy.

## What the document buys you

1. **An interactive UI** your consumers can try requests from.
2. **Generated clients** in any language:
   ```bash
   dotnet tool install -g Microsoft.dotnet-openapi
   npx @openapitools/openapi-generator-cli generate -i openapi.json -g typescript-fetch -o ./client
   ```
3. **Contract tests.** Commit the generated JSON, regenerate it in CI, and fail the build on an unintended diff. This turns "we accidentally broke the API" into a pull-request comment.
4. **Import into Postman, Insomnia, Bruno** — one click.
5. **Mock servers** — Prism and others serve a fake API straight from the document, so front-end work can start before the backend exists.

Point 3 is the underrated one.

::: exercise Level 1 — Guided · Document the API
1. Add `AddOpenApi` and `MapOpenApi` plus a UI.
2. Open the UI and execute each endpoint from it.
3. Note how many responses are documented as `200` when they are not.
4. Add `[ProducesResponseType]` for every real response of every action, including error responses.
5. Enable XML documentation and add `<summary>` and `<example>` to your DTOs.
6. Reload and compare — the difference is substantial.
7. Save the document: `curl localhost:5080/openapi/v1.json > openapi.json` and commit it.
:::

::: challenge Level 3 · Documentation that cannot rot
Requirements:

1. The OpenAPI document is generated in CI and compared against the committed copy; an unintended change fails the build.
2. A deliberate change requires regenerating and committing the file, so it appears in code review.
3. The document includes every error `type` your API can return, with examples.
4. A TypeScript client is generated from it and compiles.
5. A test asserts that every action has at least one `[ProducesResponseType]` — so a new endpoint cannot be added undocumented.
6. The document is versioned; a breaking change requires a version bump.

Point 5 is the clever one. Think about how to enumerate the actions.
:::

::: solution
For point 1, generate the document at build time rather than by hitting a running server:

```xml
<PackageReference Include="Microsoft.Extensions.ApiDescription.Server" Version="10.0.0" />
<PropertyGroup>
  <OpenApiGenerateDocuments>true</OpenApiGenerateDocuments>
  <OpenApiDocumentsDirectory>$(MSBuildProjectDirectory)/../../docs</OpenApiDocumentsDirectory>
</PropertyGroup>
```

Then in CI:
```bash
dotnet build src/TaskFlow.Api
git diff --exit-code docs/TaskFlow.Api.json || {
  echo "The OpenAPI document changed. Review the diff and commit it."
  exit 1
}
```

For point 5 — enumerate the actions through MVC's own description provider:

```csharp
[Fact]
public void Every_action_documents_its_responses()
{
    using var factory = new WebApplicationFactory<Program>();
    var provider = factory.Services.GetRequiredService<IApiDescriptionGroupCollectionProvider>();

    var undocumented = provider.ApiDescriptionGroups.Items
        .SelectMany(g => g.Items)
        .Where(d => d.SupportedResponseTypes.All(r => r.IsDefaultResponse))
        .Select(d => $"{d.HttpMethod} /{d.RelativePath}")
        .ToList();

    Assert.True(undocumented.Count == 0,
        $"These actions have no [ProducesResponseType]:\n  {string.Join("\n  ", undocumented)}");
}
```

`IApiDescriptionGroupCollectionProvider` is what the OpenAPI generator itself uses, so the test sees exactly what the document will. `IsDefaultResponse` is true for the inferred fallback, so requiring at least one non-default response is the same as requiring an explicit attribute.

The broader principle, and it is the point of the whole challenge: **documentation that is not checked is documentation that is wrong.** Hand-written API docs describe what the API did when someone last remembered to update them. A generated document checked into source control and diffed in CI describes what the API does now, and makes every change to it visible in review.
:::

::: project Document TaskFlow
1. OpenAPI generated at build time into `docs/`, committed.
2. Scalar or Swagger UI in Development only.
3. `[ProducesResponseType]` on every action including error responses.
4. XML summaries and examples on every DTO.
5. The "every action is documented" test.
6. A generated TypeScript client in `clients/ts/`, plus a README line on regenerating it.
7. CI step failing on an uncommitted document change.

Commit. **Phase 6 is nearly done** — one checkpoint lesson to go.
:::

::: interview What is OpenAPI and why does it matter?
A machine-readable description of an HTTP API — endpoints, parameters, request and response schemas, status codes — in a standard JSON or YAML format. ASP.NET Core generates it from your code, from route metadata, DTO types and `[ProducesResponseType]` attributes.

It matters because it gives you an interactive UI for consumers, generated client libraries in any language, import into tools like Postman, and mock servers so front-end work can start early.

The practice worth mentioning: commit the generated document and regenerate it in CI, failing the build on an unexpected diff. That turns an accidental breaking change into a visible line in a pull request instead of a support ticket.
:::

::: checkpoint
- [ ] Every action declares every response it can produce
- [ ] The document is generated at build time and committed
- [ ] CI fails on an undocumented change
- [ ] I generated a client from the document and it compiled
- [ ] The UI is not exposed in Production
:::

## Common mistakes

::: mistake
**Assuming the generated document is accurate.** Without `[ProducesResponseType]` it claims every endpoint returns 200 with no body.

**Exposing Swagger UI publicly in production.** A complete map of your attack surface.

**Hand-written API docs in a wiki.** Wrong within a month, and nobody notices.

**No examples.** Users copy examples; they do not read schemas.

**Forgetting `<GenerateDocumentationFile>`.** Your XML comments are silently ignored.
:::
