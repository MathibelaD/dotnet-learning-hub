---
title: "Checkpoint: the TaskFlow test suite"
summary: A test suite you would trust to let you refactor anything.
minutes: 90
---

## What are we learning?

Nothing new. Assemble the suite, and then prove it works by breaking things on purpose.

## The deliverable

```text
tests/
├── TaskFlow.Domain.Tests/          pure, no I/O           < 200ms
├── TaskFlow.Application.Tests/     fakes, no I/O          < 1s
├── TaskFlow.Architecture.Tests/    dependency rules       < 500ms
└── TaskFlow.Integration.Tests/     real DB, real HTTP     < 60s
```

## Requirements

### Domain tests
- Every invariant and every state transition
- `[Theory]` for anything table-shaped
- `FakeTimeProvider` for anything time-dependent
- Builders for setup, with the subject of each assertion visible in the test

### Application tests
- Every use case: success, not-found, forbidden, invalid-state, dependency-failure
- Fakes for stateful dependencies, substitutes for one-shot collaborators
- No assertions on call counts unless the call *is* the behaviour

### Architecture tests
- Domain references nothing
- Application does not reference Infrastructure
- Controllers do not reference `DbContext`
- No public setters on domain types
- Every controller action declares its responses

### Integration tests
- Every endpoint, every status code, exact JSON shape
- The authorization matrix: user type × operation × endpoint
- Cross-cutting: middleware order, correlation id, error shape, CORS, ETag, rate limiting
- Query budgets per endpoint
- The DI container resolves everything
- Real PostgreSQL via Testcontainers

## The real test of a test suite

::: stop Mutation testing, by hand
A test suite's value is measured by the bugs it catches, not by its coverage number. Prove yours works.

Make each of these changes, one at a time, run the suite, and record whether it fails:

1. Delete the "already complete" check in `TaskItem.Complete()`.
2. Change a status transition rule to allow `Todo → Completed`.
3. Remove `AsNoTracking` from a read query.
4. Change `>` to `>=` in the overdue comparison.
5. Remove the authorization check from the update endpoint.
6. Change a 404 to a 200 with a null body.
7. Remove the label limit.
8. Change `OrdinalIgnoreCase` to `Ordinal` in label comparison.
9. Remove the `ORDER BY` from a paged query.
10. Remove the tie-break from a sort.
11. Change the access token lifetime to 24 hours.
12. Remove reuse detection from the refresh flow.
13. Return `ex.Message` in a production error response.
14. Remove the query scope from the task list endpoint.
15. Change `totalCount` to be computed before the authorization filter.

**Every one of those should fail at least one test.** Any that does not is a gap — write the test.

Numbers 9, 10, 14 and 15 are the ones most suites miss.
:::

::: checkpoint
- [ ] All four test projects exist and pass
- [ ] `dotnet test` runs everything in under 90 seconds
- [ ] All fifteen mutations are caught
- [ ] No test depends on another test's state
- [ ] The suite runs in CI on every push
- [ ] A failing test tells me what broke without a debugger
:::

::: project Assemble and prove it
```bash
cd ~/taskflow
dotnet test
dotnet test --collect:"XPlat Code Coverage"
reportgenerator -reports:"**/coverage.cobertura.xml" -targetdir:coverage -reporttypes:Html
```

Then do the mutation exercise. Use git so you can revert cleanly:

```bash
for i in $(seq 1 15); do
  # make mutation i
  dotnet test --no-build 2>&1 | tail -3
  git checkout .
done
```

Record the results in `TESTING.md`: which mutations were caught, by which test, and what you added for the ones that were not.

```bash
git commit -am "Phase 10: test suite with mutation verification"
git tag tested
```
:::

::: solution Which mutations usually escape, and why
**9 and 10 — removing `ORDER BY` or the tie-break.** Most suites seed three rows, and with three rows PostgreSQL returns them in insertion order regardless. The test passes. The fix is a paging test with enough rows and a real assertion:

```csharp
[Fact]
public async Task Paging_returns_every_item_exactly_once()
{
    await SeedAsync(count: 95);

    var seen = new List<Guid>();
    for (var page = 1; page <= 5; page++)
    {
        var result = await GetPageAsync(page, pageSize: 20);
        seen.AddRange(result.Items.Select(i => i.Id));
    }

    seen.Count.ShouldBe(95);
    seen.Distinct().Count().ShouldBe(95);      // no duplicates across pages
}
```
That test catches unstable paging, which is otherwise an intermittent production bug that nobody can reproduce.

**14 and 15 — authorization scope and count leakage.** Caught only if you assert on `totalCount` and not just on the items, and only if another user's data exists in the test database. Seed data for a *second* user in every list test; otherwise "no leak" is vacuously true.

**3 — removing `AsNoTracking`.** Does not change behaviour, only performance. Caught only by a query-budget or allocation assertion. It is reasonable to decide this one is not worth catching — but decide, rather than discover.

**8 — `OrdinalIgnoreCase` to `Ordinal`.** Caught only if a test actually uses mixed casing. Add `"Bug"` versus `"bug"` to your label tests.

**The general lesson:** the mutations that escape are almost always where the test data is too small, too uniform, or belongs to only one user. Seed realistic data — multiple users, enough rows to page, mixed casing — and most of the gaps close at once.
:::

::: interview How do you know your tests are any good?
Coverage tells you what was executed, not what was verified, so I do not treat it as a target. What I do is check that tests actually detect defects — mutation testing, either with a tool like Stryker.NET or by hand: change a rule, run the suite, and confirm something fails.

The gaps that turn up are consistently the same shape. Tests with three rows of seed data do not catch unstable paging. Tests with one user do not catch authorization leaks, especially in a total count. Tests with uniform casing do not catch a comparer change.

I also look at the failure messages. If a failing test needs a debugger to diagnose, it is not doing its job — the name and the message should tell you what broke.
:::

::: checkpoint Phase 10 complete
- [ ] All fifteen mutations are caught, and `TESTING.md` records the exercise
- [ ] I can refactor any part of TaskFlow and trust the suite
- [ ] The suite is fast enough that I actually run it
- [ ] CI runs it on every push
:::
