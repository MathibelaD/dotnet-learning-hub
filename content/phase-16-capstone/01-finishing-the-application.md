---
title: Finishing TaskFlow
summary: The gap between "the tutorial is done" and "I would put my name on this".
minutes: 120
---

## What are we learning?

Closing out the project: the features you deferred, the polish that signals care, and an honest self-review.

::: stop
This lesson assumes stages 1–8 are committed and tagged. If any are not, finish those first.
:::

## What TaskFlow should already do

```text
✅ Users register, log in, refresh and log out
✅ Projects with members and owners
✅ Tasks with status transitions, priorities, labels, comments, assignment, dependencies
✅ Search, filter, sort, page, facet — all in SQL
✅ Resource-based authorization scoped at the query level
✅ Optimistic concurrency with ETag/If-Match
✅ Validation, ProblemDetails errors, correlation ids
✅ Domain events, an outbox, background processing
✅ Structured logs, metrics, traces, health checks
✅ Caching, rate limiting, resilience
✅ A four-project test suite with mutation verification
✅ One-command Docker startup, CI with scanning
```

## What is probably missing

::: design Pick three, not all of them
You could keep adding forever. Pick the three that best demonstrate range, finish them properly, and stop.

**High value, moderate effort:**
- **Audit history.** Who changed what, when, and from what to what. You have domain events already; persist them as an immutable log and expose `GET /api/tasks/{id}/history`. Demonstrates event sourcing concepts without adopting event sourcing.
- **Email verification and password reset.** Completes the authentication story, which is currently incomplete in a way an interviewer will notice.
- **Bulk operations.** `POST /api/tasks/bulk` with partial success — 207 Multi-Status, per-item results. Harder than it looks and a good demonstration of API design.
- **Real-time updates.** SignalR pushing task changes to connected clients. High demo value.

**High value, high effort:**
- **Multi-tenancy.** A tenant id on every entity, a global query filter, tenant resolution from the token. Genuinely instructive about how much of your design was implicitly single-tenant.
- **Full-text search.** PostgreSQL `tsvector` with ranking, replacing `ILIKE`.

**Low value for learning:**
- A front end. It is a large amount of work that demonstrates nothing about .NET. A good `.http` file and OpenAPI UI demo the API better.
- More CRUD entities. You have proven you can do CRUD.
:::

## The polish that signals care

**1. The README.** The single most-read file and usually the worst. It should have: one sentence on what it is, a screenshot or a sample request and response, how to run it in five minutes, the architecture in one diagram, and the trade-offs you made. Not a wall of setup steps.

**2. `DECISIONS.md`.** You have been writing this since Phase 1. Read it end to end now. Fix anything that is now wrong, and add a one-paragraph summary at the top.

**3. Commit history.** Squash the "fix typo" commits; make sure each commit message says *why*. An interviewer who looks at your history and finds fifty commits called "wip" learns something; one who finds messages explaining reasoning learns something better.

**4. Consistency.** Do the same thing the same way everywhere. One naming convention, one error shape, one pagination shape, one way of returning a not-found. Inconsistency reads as inattention more than any individual choice.

**5. Delete things.** Unused code, commented-out blocks, the abstraction you kept because deleting it felt wasteful. Phase 12's exercise applies to the whole repository now.

**6. Make it obvious where to start.** A new reader should find `Program.cs`, the domain model and the README without searching.

## The self-review

::: exercise Level 2 — Independent · Review your own code as a stranger
Take a break, then read your own repository as though someone else wrote it and you have to maintain it.

For each, write your honest answer:

1. Can I run it in five minutes from the README alone?
2. Where are the business rules? Can I find them without searching?
3. If I had to add "tasks can have attachments", which files would I touch, and is that number reasonable?
4. Which file would I least like to change, and why?
5. What would break if the database went down? If Redis did? If the email provider did?
6. Which test would fail if I broke the most important rule?
7. What is the worst thing in this repository?
8. What is the best thing?
9. What would a senior engineer criticise in a review?
10. What would I do differently if I started again?

Number 7 is the one that matters. Every codebase has one; naming yours is more useful than defending it.
:::

::: challenge Level 3 · Fix the worst thing
Take your answer to question 7 and fix it.

Requirements:
1. Write down the problem, why it is a problem, and what you are changing, **before** you start.
2. Make the change in small, reviewable commits.
3. All tests pass throughout.
4. Measure something — lines, files touched, test time, an endpoint's latency — before and after.
5. Write the result into `DECISIONS.md`.
6. If it turns out to be harder than expected, stop and write down why. An abandoned refactor with a written explanation is more valuable than a half-finished one.
:::

::: project The final pass
1. Three chosen features, finished properly — with tests, documentation and error handling, not prototypes.
2. README rewritten for a reader who has never seen the project.
3. `DECISIONS.md` reviewed end to end, with a summary.
4. `ARCHITECTURE.md` with one diagram and a paragraph per layer.
5. `SECURITY.md` with the attack results from Phase 9.
6. `RUNBOOK.md` with at least five entries.
7. `TESTING.md` with the mutation results from Phase 10.
8. Dead code deleted.
9. Commit history tidied.
10. The whole thing verified from a clean clone on a clean machine.

```bash
git tag v1.0.0
git push --tags
```
:::

::: solution What "finished" actually looks like
An honest description of a repository that is genuinely good, as opposed to one that merely works:

**The README opens with a request and a response**, not with a list of technologies. A reader knows within ten seconds what the thing does.

**There is one diagram**, and it is accurate. Four boxes and three arrows beats a beautiful diagram that no longer matches the code.

**Every non-obvious decision has a written reason.** Not "we use Clean Architecture" but "the domain project references nothing, enforced by an MSBuild target, because it lets the rule tests run in 150ms with no database — and it cost about 25 extra files, which I judged worth it for a service with this many rules."

**The test suite runs fast enough that you actually run it.** Under two minutes end to end. A suite people skip provides no safety.

**Something has been deleted.** A repository where nothing was ever removed is a repository where nobody was confident enough to.

**There is a list of what it does not do.** "No email verification; no multi-tenancy; no front end; the outbox gives at-least-once delivery, not exactly-once." Stating the limits precisely demonstrates that you know where they are, and it pre-empts the question an interviewer was about to ask.

That last point is worth emphasising. Candidates hide gaps; engineers document them. A `LIMITATIONS.md` is a stronger signal than any feature you could add in its place.
:::

::: checkpoint
- [ ] Three additional features are finished, not started
- [ ] The README would get a stranger running in five minutes
- [ ] All five documentation files exist and are accurate
- [ ] I named the worst thing in the repository and fixed it
- [ ] I deleted something
- [ ] `LIMITATIONS.md` states precisely what it does not do
- [ ] It is tagged `v1.0.0` and verified from a clean clone
:::
