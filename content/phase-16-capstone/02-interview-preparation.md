---
title: Explaining what you built
summary: Turning six months of work into answers you can give under pressure.
minutes: 90
---

## What are we learning?

How to talk about TaskFlow: the walkthrough, the technical questions, and the ones that are really about judgement.

::: why Why this lesson exists
You can now build a production .NET API. That is necessary and not sufficient — in an interview you have forty minutes to demonstrate it, mostly by talking.

The good news is that having genuinely built something makes this easy, because you are describing rather than reciting. The failure mode is different: people who built something real often under-sell it, skipping the reasoning because it seems obvious to them. It is not obvious to the interviewer, and the reasoning is what they are assessing.
:::

## The two-minute walkthrough

Practise this out loud until it is fluent. Time yourself.

> "TaskFlow is a task management API — projects, tasks, comments, labels, assignment, with multi-user authorisation. It is .NET 10, ASP.NET Core, EF Core against PostgreSQL, containerised, with about 300 tests.
>
> It is four projects. The domain holds entities and business rules and references nothing — that is enforced by an MSBuild target and an architecture test, not by convention. Application orchestrates use cases. Infrastructure implements the repository interfaces the domain defines. The API is controllers, DTOs and middleware, and it is the composition root.
>
> The parts I would point at: the domain owns its state machine, so no caller — not the API, not EF Core — can put a task into an illegal state. Read paths project straight into DTOs so there is no N+1, and there is an integration test asserting a query budget per endpoint, which is what actually keeps it that way. Authorization is resource-based and applied as a SQL filter before the count, because a total count leaks data the user cannot see.
>
> What it does not do: no email verification, no multi-tenancy, and the outbox gives at-least-once delivery rather than exactly-once, so consumers are idempotent."

Four paragraphs: what it is, how it is structured, two or three things you are proud of, and the limits. The last paragraph is the one that distinguishes you.

## The questions you will be asked

Answer each out loud, from your own code, before reading anything.

### About C# and .NET
1. Difference between `class`, `struct` and `record`? When would you use each?
2. What are nullable reference types, and what do they not protect against?
3. `IEnumerable` versus `IQueryable`?
4. What happens when you `await` a Task?
5. Why should you never call `.Result`?
6. What is dependency injection, and what are the three lifetimes?
7. What is a captive dependency?
8. Value type versus reference type — and what is boxing?
9. What does `yield return` do?
10. How does garbage collection work?

### About ASP.NET Core
11. What is middleware, and why does order matter?
12. Middleware versus filters?
13. How do you handle errors globally?
14. Why DTOs rather than entities?
15. Where does validation belong?
16. What is `[ApiController]` doing for you?
17. How do you version an API?

### About EF Core
18. What is change tracking, and when do you turn it off?
19. What is the N+1 problem and how do you avoid it?
20. How do migrations work in production?
21. How do you handle concurrent updates?
22. How do you diagnose a slow query?
23. Should you use the Repository pattern over EF Core?

### About security
24. Authentication versus authorization?
25. How do you store passwords?
26. What is a JWT, and what can it not do?
27. Why rotate refresh tokens?
28. What is in the OWASP Top 10 that applies to your API?

### About design
29. What is SOLID? Give a real example of one principle from your code.
30. When do you introduce an abstraction?
31. What does Clean Architecture buy you, and what does it cost?
32. When would you not use it?

### About testing and operations
33. What makes a good unit test?
34. Why not use EF Core's in-memory provider?
35. How do you know your tests are any good?
36. Liveness versus readiness?
37. How would you deploy this?
38. What do you do when production is slow?

Every one of these is answered in a lesson of this course, and — more importantly — by something in your repository. When you answer, **point at your own code**: "In TaskFlow, that is…" is worth far more than a definition.

## The questions that are really about judgement

These are where senior candidates separate themselves:

::: design Four questions, and what a good answer sounds like
**"Why did you choose X?"**
The trap is defending the choice. The good answer names the alternative and the trade-off:
> "I used repositories for writes and direct projections for reads. A repository over EF Core is arguably redundant — `DbSet` is already a repository — but it keeps `IQueryable` out of the application layer and gives query logic one named home. The cost is that it hides projection, which is why reads bypass it entirely. If the team were comfortable with EF Core in the application layer, injecting `DbContext` directly would be a perfectly good choice and less code."

**"What would you do differently?"**
Never "nothing". Have two real answers ready:
> "I would introduce strongly-typed ids from the start rather than retrofitting them — retrofitting touched a lot of files. And I over-abstracted early: I had an `ICache` wrapping `IMemoryCache` that bought nothing, and I deleted it in Phase 12."

**"What is the worst part of your codebase?"**
Answer honestly and specifically:
> "The search service. It has grown to about 200 lines because every new filter added a branch, and the ranking strategies made it worse. It needs the filters extracted as specifications, which I started and did not finish."
>
> An interviewer who hears that learns you can assess your own work. One who hears "I'm happy with all of it" learns the opposite.

**"How would you scale this to 100× the traffic?"**
Reason from the constraint, do not list technologies:
> "First I would find out what breaks. From load testing it is the database connection pool, not CPU — the API sits at about 20% while the pool saturates at 100 connections. So the first steps are read replicas for the query endpoints, and caching the expensive aggregates, which I already do for project statistics. Past that, the outbox processor is the next bottleneck, and it already claims rows with `SKIP LOCKED` so it scales horizontally. I would not reach for a message broker or sharding until I had measured that those were the limit."
:::

## The live exercise

You may be asked to write code. What they are assessing:

- **Do you ask clarifying questions?** Good candidates ask two or three before typing.
- **Do you handle edge cases?** Empty, null, duplicate, boundary.
- **Do you name things well?**
- **Do you talk while you think?** Silence is unreadable.
- **Do you test it?** Even saying "I would write a test for the empty case" scores.
- **Do you know when to stop?** Over-engineering a fifteen-minute exercise is a signal.

Say what you are doing: "I will start with the simplest version that handles the happy path, then add validation." That narration is most of what is being marked.

::: exercise Level 1 — Guided · Prepare properly
1. Record yourself giving the two-minute walkthrough. Watch it. Do it again.
2. Answer all 38 questions out loud, timing yourself. Thirty seconds to a minute each.
3. For any you cannot answer from your own code, go back to that lesson and to that code.
4. Write your two "what would you do differently" answers.
5. Write your "worst part of the codebase" answer.
6. Have someone who does not know the project read your README and try to run it. Watch without helping.
7. Prepare three questions to ask *them* — about the codebase, the team, how they deploy.
:::

::: challenge Level 3 · A full mock
Find someone — a colleague, a friend who codes, a study partner — and run a real forty-five minute mock interview.

Requirements:
1. Ten minutes: the project walkthrough, with follow-up questions.
2. Fifteen minutes: technical questions from the list, chosen at random.
3. Fifteen minutes: a live coding exercise you have not seen.
4. Five minutes: your questions for them.
5. Ask for written feedback on: clarity, depth, honesty about limits, and code quality under pressure.
6. Do it again a week later with a different person.

If nobody is available, record yourself answering random questions from the list with a two-second thinking budget. It is worse than a real mock and much better than nothing.
:::

::: project The portfolio
Make TaskFlow findable and readable:

1. Push it to GitHub, public, with a clear description and topics.
2. A README that opens with what it is and a sample request.
3. A pinned repository on your profile.
4. A short write-up — a blog post or a long README section — on one thing you found interesting. "How I stopped a total count from leaking authorization-filtered data" is a better post than "I built a task API".
5. The tags from stages 1–8 intact, so the evolution is visible.
6. A `LIMITATIONS.md`.

Point 5 is unusual and worth doing. A reviewer who sees `stage-1` through `stage-8` can watch a console app become a production service, and that narrative is more persuasive than the final state alone.
:::

::: solution What actually distinguishes candidates
Having interviewed and been interviewed, the differences that matter most:

**1. Specificity.** "I used caching" versus "I cache project statistics for five minutes with tag-based invalidation on write, because computing them is three queries and they are read on every dashboard load; I do not cache the authorization check, because revocation has to take effect immediately."

**2. Naming the trade-off.** Every choice has a cost. A candidate who can only list benefits has not thought about it, or has not shipped it.

**3. Measurements.** "It was slow so I added an index" is fine. "`EXPLAIN ANALYZE` showed a sequential scan removing 99,711 rows by filter; the composite index took it from 38ms to 0.5ms" is a different class of answer. You have these numbers — you recorded them in `DECISIONS.md`. Use them.

**4. Admitting limits precisely.** "The outbox gives at-least-once, not exactly-once — consumers are idempotent because of that" tells an interviewer you understand distributed systems better than any claim of correctness would.

**5. Curiosity about their problems.** The questions you ask are assessed too. "How do you handle database migrations across your deployments?" is a question from someone who has done it.

**What does not distinguish candidates:** memorised definitions, listing technologies, or claiming everything went well. Interviewers hear those all day.

**The thing to remember:** you have built something real. Most candidates for the roles you are applying to have not. Describe it accurately, including the parts you would change, and that is enough.
:::

::: checkpoint Course complete
- [ ] I can give the two-minute walkthrough fluently
- [ ] I can answer all 38 questions from my own code
- [ ] I have specific numbers for my performance claims
- [ ] I can name what I would do differently and why
- [ ] I can name the worst part of my codebase
- [ ] I have done at least one full mock interview
- [ ] TaskFlow is public, documented, and tagged stage by stage
:::

## The last word

You started this course able to program. You can now write idiomatic modern C#, design and build a REST API, model and query a relational database, secure it, test it, instrument it, containerise it, and explain every decision you made.

More usefully, you can do the thing that is actually hard: look at a piece of code, decide whether it is right for the situation, and say why. That judgement is what the rest of your career is made of, and it does not come from courses — it comes from having built something, broken it, measured it, and fixed it. You have now done all four.

::: recap What you built
A production-style .NET API with:
C# · .NET 10 · ASP.NET Core · PostgreSQL · EF Core · LINQ · async ·
dependency injection · JWT authentication · resource-based authorization ·
validation · global error handling · structured logging · metrics · traces ·
caching · rate limiting · resilience · background services · a four-layer
test suite · SOLID applied and argued · Clean Architecture with its costs
stated · Docker · CI with scanning · and documentation you would hand to someone else.

Go and build the next one.
:::
