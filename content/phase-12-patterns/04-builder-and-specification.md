---
title: Builder and Specification
summary: Constructing complex objects readably, and making query rules first-class, reusable and testable.
minutes: 35
---

## What are we learning?

Two patterns that are unusually practical in a .NET codebase: one you have already used for tests, and one that solves a problem you have been working around since Phase 3.

## Builder

The problem: constructing an object with many optional parts.

```csharp
// telescoping constructors — the anti-pattern
new TaskItem(title);
new TaskItem(title, priority);
new TaskItem(title, priority, dueDate);
new TaskItem(title, priority, dueDate, assigneeId);
new TaskItem(title, priority, dueDate, assigneeId, labels);
new TaskItem(title, priority, dueDate, assigneeId, labels, recurrence);   // ← what is that null?
```

C# has two lighter answers than the classic Builder before you reach for it:

```csharp
// 1. Object/collection initialiser with init-only properties
var task = new TaskItem(title, projectId)
{
    Priority = Priority.High,
    DueDate = friday
};

// 2. Named and optional arguments
var task = new TaskItem(title, projectId, priority: Priority.High, dueDate: friday);
```

**Use a builder when construction needs validation across several steps, or produces something immutable with interdependent parts.** Otherwise the language features are enough.

Where a builder genuinely earns its keep in this codebase is **tests** (Phase 10) and **fluent query construction**:

```csharp
var query = TaskQuery.Builder()
    .InProject(projectId)
    .WithAnyStatus(TaskStatus.Todo, TaskStatus.InProgress)
    .AssignedTo(userId)
    .DueBefore(nextFriday)
    .MatchingText("security")
    .SortedBy(TaskSortBy.Priority, descending: true)
    .Page(2, size: 50)
    .Build();
```

```csharp
public sealed class TaskQueryBuilder
{
    private readonly TaskQuery _query = new();

    public TaskQueryBuilder InProject(Guid id) { _query = _query with { ProjectId = id }; return this; }
    public TaskQueryBuilder Page(int number, int size)
    {
        if (number < 1) throw new ArgumentOutOfRangeException(nameof(number));
        if (size is < 1 or > 100) throw new ArgumentOutOfRangeException(nameof(size));
        _query = _query with { Page = number, PageSize = size };
        return this;
    }

    public TaskQuery Build()
    {
        if (_query.DueBefore is { } before && _query.DueAfter is { } after && before < after)
            throw new InvalidOperationException("DueBefore must not precede DueAfter.");
        return _query;
    }
}
```

`Build()` doing **cross-field validation** is what distinguishes this from an object initialiser: an initialiser cannot check that two properties are consistent with each other.

## Specification

This is the more valuable of the two.

The problem: query rules scattered and duplicated.

```csharp
// in the search service
q = q.Where(t => t.Status != TaskStatus.Completed && t.Status != TaskStatus.Cancelled);

// in the statistics service — subtly different, and nobody noticed
q = q.Where(t => t.Status != TaskStatus.Completed);

// in the notification job — different again
q = q.Where(t => t.Status == TaskStatus.Todo || t.Status == TaskStatus.InProgress);
```

Three definitions of "open", one of which is wrong. Make the rule an object:

```csharp
public abstract class Specification<T>
{
    public abstract Expression<Func<T, bool>> ToExpression();

    public bool IsSatisfiedBy(T entity) => ToExpression().Compile()(entity);

    public Specification<T> And(Specification<T> other) => new AndSpecification<T>(this, other);
    public Specification<T> Or(Specification<T> other) => new OrSpecification<T>(this, other);
    public Specification<T> Not() => new NotSpecification<T>(this);

    public static implicit operator Expression<Func<T, bool>>(Specification<T> spec) => spec.ToExpression();
}
```

```csharp
public sealed class OpenTaskSpecification : Specification<TaskItem>
{
    public override Expression<Func<TaskItem, bool>> ToExpression() =>
        t => t.Status != TaskStatus.Completed && t.Status != TaskStatus.Cancelled;
}

public sealed class OverdueSpecification(DateOnly today) : Specification<TaskItem>
{
    public override Expression<Func<TaskItem, bool>> ToExpression() =>
        t => t.DueDate != null && t.DueDate < today;
}

public sealed class AssignedToSpecification(Guid userId) : Specification<TaskItem>
{
    public override Expression<Func<TaskItem, bool>> ToExpression() =>
        t => t.AssigneeId == userId;
}
```

Composed, and translated to SQL:

```csharp
var needsAttention = new OpenTaskSpecification()
    .And(new OverdueSpecification(today))
    .And(new AssignedToSpecification(userId));

var tasks = await db.Tasks.Where(needsAttention).ToListAsync(ct);   // implicit conversion
```

::: why What the Specification buys you
1. **One definition per rule.** "Open" is defined once, and every consumer gets the same answer.
2. **The rule is testable alone**, with no database:
   ```csharp
   new OverdueSpecification(today).IsSatisfiedBy(task).ShouldBeTrue();
   ```
3. **It works in memory and in SQL.** The same object filters a list and generates a `WHERE` clause, because it is an expression tree (Phase 3).
4. **Rules compose** with `And`/`Or`/`Not`, so a complex condition is built from named, individually-tested parts.
5. **The name is documentation.** `needsAttention` reads better than fifteen lines of boolean logic.
:::

## Combining expressions is the hard part

`And` cannot simply be `a && b` on two expression trees — you need to rewrite the parameters so both refer to the same one:

```csharp
internal sealed class AndSpecification<T>(Specification<T> left, Specification<T> right) : Specification<T>
{
    public override Expression<Func<T, bool>> ToExpression()
    {
        var leftExpr = left.ToExpression();
        var rightExpr = right.ToExpression();

        var parameter = Expression.Parameter(typeof(T), "x");
        var body = Expression.AndAlso(
            new ReplaceParameterVisitor(leftExpr.Parameters[0], parameter).Visit(leftExpr.Body)!,
            new ReplaceParameterVisitor(rightExpr.Parameters[0], parameter).Visit(rightExpr.Body)!);

        return Expression.Lambda<Func<T, bool>>(body, parameter);
    }
}

internal sealed class ReplaceParameterVisitor(ParameterExpression from, ParameterExpression to) : ExpressionVisitor
{
    protected override Expression VisitParameter(ParameterExpression node) => node == from ? to : node;
}
```

`ExpressionVisitor` walks an expression tree and lets you rewrite nodes. Phase 13 covers it properly; for now, note that this is what `LinqKit`'s `PredicateBuilder` does for you if you would rather not write it.

::: warn Chained `Where` is often enough
```csharp
db.Tasks.Where(open).Where(overdue).Where(assigned)
```
Chained `Where` calls become a single `WHERE ... AND ... AND ...` in SQL, with no expression-tree surgery at all.

So you only need `And` when the composition is genuinely dynamic — building a predicate in a loop, or an `Or` across several specifications, which chaining cannot express.

Start with chained `Where` and specification *classes* for the named rules. Add the combinator machinery only when you hit an `Or` you cannot express otherwise.
:::

::: exercise Level 1 — Guided · Specifications for TaskFlow
1. Create `Specification<T>` with `ToExpression`, `IsSatisfiedBy` and the implicit conversion.
2. Write `OpenTaskSpecification`, `OverdueSpecification`, `AssignedToSpecification`, `HasLabelSpecification`, `InProjectSpecification`, `HighPrioritySpecification`.
3. Replace every duplicated inline predicate in TaskFlow with the matching specification.
4. Unit test each one in memory with `IsSatisfiedBy`.
5. Verify each translates by checking `.ToQueryString()`.
6. Compose three of them with chained `Where` and confirm one SQL statement.
7. Implement `And`/`Or`/`Not` with the visitor and test an `Or` composition.
:::

::: challenge Level 3 · A saved-search feature
Users can save searches and share them.

Requirements:
1. A search is stored as data (JSON), not as code.
2. Loading a saved search produces a specification that runs in SQL.
3. Arbitrary nesting of `And`, `Or` and `Not`.
4. Invalid or malicious stored JSON cannot produce an invalid query or an exception at query time — validate on load.
5. A specification can be rendered back to readable text: "Open AND overdue AND assigned to Sam".
6. Saved searches are versioned; an old one keeps working after new rule types are added.
7. A user cannot construct a search that reads data they are not allowed to see.

Point 7 is a security requirement, and it is the one that makes this challenge worth doing.
:::

::: solution
The stored shape:

```json
{
  "version": 1,
  "type": "and",
  "operands": [
    { "type": "open" },
    { "type": "overdue" },
    { "type": "or", "operands": [
        { "type": "assignedTo", "userId": "3f2a..." },
        { "type": "hasLabel", "label": "urgent" } ] }
  ]
}
```

Deserialisation with an allowlist:

```csharp
private static readonly Dictionary<string, Func<JsonElement, Specification<TaskItem>>> Factories = new()
{
    ["open"]       = _ => new OpenTaskSpecification(),
    ["overdue"]    = e => new OverdueSpecification(DateOnly.FromDateTime(DateTime.UtcNow)),
    ["assignedTo"] = e => new AssignedToSpecification(e.GetProperty("userId").GetGuid()),
    ["hasLabel"]   = e => new HasLabelSpecification(RequireLabel(e.GetProperty("label").GetString())),
};

public static Specification<TaskItem> Parse(JsonElement element, int depth = 0)
{
    if (depth > 10) throw new InvalidSearchException("Search is nested too deeply.");

    var type = element.GetProperty("type").GetString()
               ?? throw new InvalidSearchException("Missing type.");

    return type switch
    {
        "and" => Combine(element, depth, (a, b) => a.And(b)),
        "or"  => Combine(element, depth, (a, b) => a.Or(b)),
        "not" => Parse(element.GetProperty("operand"), depth + 1).Not(),
        _ => Factories.TryGetValue(type, out var factory)
                ? factory(element)
                : throw new InvalidSearchException($"Unknown rule type '{type}'.")
    };
}
```

**Requirement 4 — the allowlist is the whole defence.** There is no reflection, no type name from the payload, no `Activator.CreateInstance` on a user-supplied string. Only the rule types in `Factories` can ever be constructed. The depth limit prevents a stack overflow from a maliciously nested payload, and `RequireLabel` validates the parameter before it reaches the expression.

**Requirement 7 — the saved search never gets to decide visibility.** The authorization scope from Phase 9 is applied *first*, and the saved specification is applied on top:

```csharp
var query = scope.Visible(db.Tasks.AsNoTracking())      // authorization, always first
                 .Where(savedSearch.ToSpecification()); // then the user's rules
```

A saved search is a **filter**, never a grant. If it could widen visibility, a user could share a search that exposes another project's tasks. This is the same ordering principle as the count-leakage problem in Phase 9, and it generalises: **authorization is the outermost filter, applied before anything a user controls.**

Requirement 5, rendering back to text, falls out naturally if each specification has a `Describe()` method — and it doubles as documentation and as an audit trail of what a shared search actually does.
:::

::: project Builder and Specification in TaskFlow
1. `Specification<TaskItem>` with at least six named rules.
2. Every duplicated inline predicate replaced.
3. `And`/`Or`/`Not` with the expression visitor.
4. A `TaskQueryBuilder` with cross-field validation in `Build()`.
5. Saved searches stored as validated JSON, with an allowlist.
6. Authorization scope applied before any saved specification.
7. Every specification unit-tested in memory and verified to translate to SQL.

Commit.
:::

::: interview What is the Specification pattern?
It turns a business rule about "which entities match" into a first-class object — typically wrapping an `Expression<Func<T, bool>>`, so the same rule can be evaluated in memory and translated to SQL by EF Core.

The value is that a rule like "open task" gets one definition instead of being re-typed slightly differently in every service — which is how you end up with three inconsistent definitions and a bug nobody can explain. It also makes rules testable without a database, and composable with `And`, `Or` and `Not`.

The practical caveat is that combining expression trees requires rewriting the lambda parameter with an `ExpressionVisitor`, which is fiddly — and chained `Where` calls already produce a single `AND` in SQL. So I would start with named specification classes and plain chaining, and only add the combinator machinery when I need an `Or` that chaining cannot express.
:::

::: checkpoint
- [ ] Each query rule has exactly one definition
- [ ] Specifications are tested in memory and verified to translate
- [ ] I wrote an `ExpressionVisitor` and understand what it does
- [ ] My builder validates across fields in `Build()`
- [ ] Saved searches use an allowlist and cannot widen visibility
:::

## Common mistakes

::: mistake
**A builder where an object initialiser would do.** C# has named arguments and `init`.

**Specifications that cannot be translated.** Calling a C# method inside `ToExpression` throws at query time.

**`IsSatisfiedBy` in a loop over database entities.** That compiles the expression per call and evaluates in memory. Pass the specification to `Where` instead.

**Deserialising rule types by name from user input.** Type confusion, and potentially remote code execution.

**User-controlled filters applied before authorization.** Data leak.
:::
