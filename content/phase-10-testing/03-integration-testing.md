---
title: Integration testing the API
summary: WebApplicationFactory — testing the real pipeline, real routing, real serialisation, real auth.
minutes: 40
---

## What are we learning?

Testing your API through HTTP, in-process, with everything that middleware, model binding and filters actually do.

## What unit tests cannot catch

A fully unit-tested application can still be broken in all of these ways:

- routing (`{id:guid}` does not match), status codes, content negotiation
- model binding, JSON casing, enum conversion
- middleware order, authentication, authorization, CORS
- validation filters, exception handlers
- dependency injection — a missing registration only fails at resolution
- serialisation: a cycle, a missing property, a `DateTime` in the wrong kind

Every one of those is an outage, and none is visible to a unit test.

## `WebApplicationFactory`

```bash
dotnet add tests/TaskFlow.Integration.Tests package Microsoft.AspNetCore.Mvc.Testing
```

```csharp
public sealed class ApiFactory : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");

        builder.ConfigureServices(services =>
        {
            // replace the real database with one for this test run
            services.RemoveAll<DbContextOptions<TaskFlowDbContext>>();
            services.AddDbContext<TaskFlowDbContext>(o => o.UseNpgsql(_connectionString));

            // replace real outbound dependencies
            services.RemoveAll<IEmailSender>();
            services.AddSingleton<IEmailSender, RecordingEmailSender>();
        });
    }
}
```

```csharp
public sealed class TasksEndpointTests(ApiFactory factory) : IClassFixture<ApiFactory>
{
    [Fact]
    public async Task Get_returns_404_for_an_unknown_id()
    {
        var client = factory.CreateClient();

        var response = await client.GetAsync($"/api/tasks/{Guid.NewGuid()}");

        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
        var problem = await response.Content.ReadFromJsonAsync<ProblemDetails>();
        problem!.Title.ShouldBe("Task not found");
    }
}
```

No network is involved. `WebApplicationFactory` hosts the app in-process with a `TestServer`, and `HttpClient` talks to it through an in-memory transport — so it is fast, and there is no port to allocate.

::: note `public partial class Program;`
`WebApplicationFactory<Program>` needs `Program` to be accessible, and top-level statements generate an `internal` one. Adding

```csharp
public partial class Program;
```

at the bottom of `Program.cs` fixes it. This was in the Phase 8 `Program.cs`; here is where it pays off.
:::

## Authenticating in tests

Three approaches, in increasing fidelity:

**1. Real login** — most faithful, slowest:
```csharp
var login = await client.PostAsJsonAsync("/api/auth/login", new { email, password });
var tokens = await login.Content.ReadFromJsonAsync<TokenResponse>();
client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", tokens!.AccessToken);
```

**2. Issue a token directly** — fast and still exercises real validation:
```csharp
var tokenService = factory.Services.GetRequiredService<ITokenService>();
var token = tokenService.Create(user, ["Member"]).Value;
```

**3. A test authentication scheme** — fastest, but it bypasses your real JWT validation:
```csharp
services.AddAuthentication("Test").AddScheme<AuthenticationSchemeOptions, TestAuthHandler>("Test", _ => { });
```

Prefer **2**. It is nearly as fast as 3 and still runs your real token validation — which is exactly the code you most want covered. Use 1 for the auth tests themselves.

A helper keeps tests readable:

```csharp
public static class ClientExtensions
{
    public static HttpClient As(this ApiFactory factory, User user, params string[] roles)
    {
        var client = factory.CreateClient();
        var token = factory.Services.GetRequiredService<ITokenService>().Create(user, roles);
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token.Value);
        return client;
    }
}

var client = factory.As(alice);
```

## Isolating tests from each other

The hardest part of integration testing is that tests share a database.

::: design Four strategies for test isolation
**1. Transaction rollback per test.** Begin a transaction, run the test, roll back. Fast and thorough — but it breaks when the code under test manages its own transactions, which yours does.

**2. Truncate between tests.** `TRUNCATE tasks, projects, users CASCADE` before each. Simple, reliable, and fast on small tables. **This is usually the right default.**

**3. A fresh database per test class.** Complete isolation, and tests can run in parallel. Slower to set up; a template database makes it fast.

**4. Unique data per test.** Every test creates its own user and project and touches nothing else. No cleanup at all, and tests run fully parallel — but any test asserting on a global count or list becomes fragile.

TaskFlow uses **2 plus 4**: truncate between classes for a clean slate, and give each test its own user and project so that even within a class nothing collides.

```csharp
public sealed class DatabaseFixture : IAsyncLifetime
{
    public async Task ResetAsync()
    {
        await using var connection = new NpgsqlConnection(ConnectionString);
        await connection.OpenAsync();
        await connection.ExecuteAsync("""
            TRUNCATE users, projects, tasks, comments, labels,
                     task_labels, refresh_tokens, outbox_messages RESTART IDENTITY CASCADE;
            """);
    }
}
```

`RESTART IDENTITY CASCADE` resets sequences and follows foreign keys, so you do not have to get the truncation order right.
:::

## Testing the whole shape

```csharp
[Fact]
public async Task Create_task_returns_201_with_a_location_header_and_the_created_body()
{
    var client = factory.As(alice);

    var response = await client.PostAsJsonAsync("/api/tasks",
        new { title = "Write integration tests", projectId = project.Id, priority = "High" });

    response.StatusCode.ShouldBe(HttpStatusCode.Created);
    response.Headers.Location.ShouldNotBeNull();

    var created = await response.Content.ReadFromJsonAsync<TaskResponse>();
    created!.Title.ShouldBe("Write integration tests");
    created.Priority.ShouldBe("High");            // string, not 2 — serialisation verified
    created.Status.ShouldBe("Todo");

    // and it is really there
    var fetched = await client.GetAsync(response.Headers.Location);
    fetched.StatusCode.ShouldBe(HttpStatusCode.OK);
}
```

Following the `Location` header is a small move with high value: it verifies routing, `CreatedAtAction` and persistence in one step.

::: exercise Level 1 — Guided · Build the harness
1. `tests/TaskFlow.Integration.Tests` with `Microsoft.AspNetCore.Mvc.Testing`.
2. `ApiFactory` overriding the database and outbound dependencies.
3. `DatabaseFixture` with truncation.
4. The `As(user)` helper.
5. Tests for the full CRUD lifecycle: create → read → update → complete → delete.
6. Tests for every error shape: 400 validation, 404, 409 conflict, 401, 403.
7. Assert on the exact JSON shape — casing, string enums, absent nulls.
8. Deliberately break something (remove a DI registration, reorder middleware) and confirm a test catches it.
:::

::: challenge Level 3 · Test the cross-cutting behaviour
Unit tests cannot reach any of these. Write an integration test for each:

1. Middleware order — `[Authorize]` returns 401 not 500 when no token is present.
2. The correlation id in the response header matches the one in the request.
3. Validation returns **all** errors at once, with camelCase keys.
4. A production-mode error response contains no stack trace, file path or library name.
5. CORS preflight from an allowed origin succeeds; from a disallowed one it does not.
6. The `ETag` from a `GET` works as `If-Match` on a `PUT`, and a stale one gives 412.
7. Rate limiting returns 429 with a `Retry-After` header.
8. A missing DI registration fails at **startup**, not at first request — `ValidateOnBuild`.
9. The OpenAPI document is generated and every endpoint appears in it.
10. `GET /api/tasks` never returns another user's data — across search, filter and paging.

Number 10 should be a `[Theory]` over many query combinations, not one case.
:::

::: solution
Number 8 is the most valuable and the least obvious:

```csharp
[Fact]
public void The_container_can_resolve_everything_at_startup()
{
    // ValidateOnBuild is enabled, so building the host is the assertion.
    using var factory = new ApiFactory();
    _ = factory.Services;                      // forces the host to build

    // and explicitly, for the services that matter
    using var scope = factory.Services.CreateScope();
    scope.ServiceProvider.GetRequiredService<ITaskService>();
    scope.ServiceProvider.GetRequiredService<ITaskRepository>();
    scope.ServiceProvider.GetRequiredService<ITokenService>();
}
```

A missing registration otherwise surfaces as a 500 on whichever endpoint happens to need it — possibly one nobody exercises until a week after deployment. This test turns that into a build failure.

Number 10 as a theory:

```csharp
[Theory]
[InlineData("")]
[InlineData("?q=secret")]
[InlineData("?status=Todo")]
[InlineData("?page=1&pageSize=100")]
[InlineData("?sort=-createdAt")]
[InlineData("?label=confidential")]
[InlineData("?overdue=true")]
public async Task List_never_leaks_another_users_tasks(string query)
{
    await SeedAsync(bob, "Bob's secret task", labels: ["confidential"]);

    var response = await factory.As(alice).GetAsync($"/api/tasks{query}");
    var page = await response.Content.ReadFromJsonAsync<PagedResponse<TaskSummaryResponse>>();

    page!.Items.ShouldAllBe(t => t.Title != "Bob's secret task");
    page.TotalCount.ShouldBe(await CountTasksFor(alice));   // the COUNT must not leak either
}
```

The last assertion is the one that matters and the one people omit. A `totalCount` computed before the authorization scope tells Alice exactly how many tasks Bob has — and by varying the filters, she can determine their labels and titles one query at a time. That is a genuine data-leak class, it is invisible in the response body, and only an assertion on the count catches it.
:::

::: project Integration tests for TaskFlow
1. The harness: `ApiFactory`, `DatabaseFixture`, auth helpers.
2. Every endpoint covered for its happy path and every error status.
3. All ten cross-cutting tests.
4. The authorization matrix as a `[Theory]`: user type × operation × endpoint.
5. Query-budget assertions (from Phase 7) wired into the harness.
6. The whole suite runs in under 30 seconds.
7. `dotnet test` in the build script, and in CI.

Commit.
:::

::: interview How do you test an ASP.NET Core API?
With `WebApplicationFactory<Program>`, which hosts the real application in-process with a `TestServer` and gives you an `HttpClient` over an in-memory transport. That exercises the real pipeline — routing, model binding, middleware order, authentication, filters, serialisation and dependency injection — none of which a unit test touches.

In the factory I replace only what needs replacing: point the `DbContext` at a test database and swap outbound dependencies like email for recording fakes. Authentication I handle by issuing a real token through the app's own token service, so the real JWT validation still runs.

Isolation is the hard part. I truncate tables between test classes and give each test its own user and project, so tests do not interfere and most can run in parallel.

The highest-value tests there are the ones unit tests cannot reach: exact status codes, the validation error shape, that production errors leak nothing, and that list endpoints never return another user's data — including in the total count.
:::

::: checkpoint
- [ ] `WebApplicationFactory` hosts my real application
- [ ] Tests are isolated and can run repeatedly without cleanup by hand
- [ ] I test the exact JSON shape, not just the status code
- [ ] A missing DI registration fails a test
- [ ] `totalCount` is asserted, not just the item list
:::

## Common mistakes

::: mistake
**Replacing too much in the factory.** Substitute your service layer and you are testing the framework, not your application.

**Tests that share state.** Passes alone, fails in the suite, or vice versa.

**Only asserting the status code.** The shape, casing and content are where the breaking changes are.

**A test authentication scheme that bypasses real JWT validation.** The code you most want covered is the code you skipped.

**No production-mode error test.** Information disclosure regresses silently.
:::
