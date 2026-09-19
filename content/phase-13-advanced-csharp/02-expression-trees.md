---
title: Expression trees
summary: Code as data — the mechanism behind LINQ providers, and how to build and rewrite one.
minutes: 40
---

## What are we learning?

`Expression<TDelegate>`: what it is, how EF Core uses it, and how to construct and transform one yourself.

## A lambda, two ways

```csharp
Func<TaskItem, bool> compiled = t => t.Priority == Priority.Urgent;
Expression<Func<TaskItem, bool>> tree = t => t.Priority == Priority.Urgent;
```

Identical syntax, completely different things.

The first is **compiled IL** — a black box you can only invoke.

The second is a **data structure** describing the code:

```text
Expression<Func<TaskItem, bool>>
└── Lambda
    ├── Parameters: [ ParameterExpression "t" (TaskItem) ]
    └── Body: BinaryExpression (Equal)
        ├── Left:  MemberExpression (Priority)
        │          └── Expression: ParameterExpression "t"
        └── Right: ConstantExpression (Priority.Urgent)
```

You can walk it, inspect it, rewrite it, or translate it to another language — which is exactly what EF Core does to produce SQL.

## Inspecting one

```csharp
Expression<Func<TaskItem, bool>> expr = t => t.Priority == Priority.Urgent;

Console.WriteLine(expr);                                  // t => (t.Priority == Urgent)
Console.WriteLine(expr.Body.NodeType);                    // Equal
Console.WriteLine(expr.Parameters[0].Name);               // t

var binary = (BinaryExpression)expr.Body;
var member = (MemberExpression)binary.Left;
Console.WriteLine(member.Member.Name);                    // Priority

var constant = (ConstantExpression)binary.Right;
Console.WriteLine(constant.Value);                        // Urgent
```

## Building one by hand

```csharp
// t => t.Title.Contains("bug")
var parameter = Expression.Parameter(typeof(TaskItem), "t");
var titleProperty = Expression.Property(parameter, nameof(TaskItem.Title));
var containsMethod = typeof(string).GetMethod(nameof(string.Contains), [typeof(string)])!;
var searchTerm = Expression.Constant("bug");
var body = Expression.Call(titleProperty, containsMethod, searchTerm);

var lambda = Expression.Lambda<Func<TaskItem, bool>>(body, parameter);

var matching = db.Tasks.Where(lambda);          // translates to SQL
var predicate = lambda.Compile();               // or run it in memory
```

Verbose, and the payoff is that the property name, the operator and the value can all come from data — which is how you build a dynamic query safely.

## Dynamic sorting — the practical case

Sorting by a user-supplied column name is the problem everyone hits:

```csharp
public static IOrderedQueryable<T> OrderByProperty<T>(
    this IQueryable<T> source, string propertyName, bool descending)
{
    var property = typeof(T).GetProperty(propertyName,
        BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase)
        ?? throw new ArgumentException($"Unknown property '{propertyName}'.", nameof(propertyName));

    var parameter = Expression.Parameter(typeof(T), "x");
    var body = Expression.Property(parameter, property);
    var keySelector = Expression.Lambda(body, parameter);

    var method = descending ? nameof(Queryable.OrderByDescending) : nameof(Queryable.OrderBy);

    var call = Expression.Call(
        typeof(Queryable), method,
        [typeof(T), property.PropertyType],
        source.Expression, Expression.Quote(keySelector));

    return (IOrderedQueryable<T>)source.Provider.CreateQuery<T>(call);
}
```

```csharp
var sorted = db.Tasks.OrderByProperty("dueDate", descending: true);   // becomes ORDER BY due_date DESC
```

::: warn A property-name allowlist is mandatory
The code above reflects over *any* public property, which means a caller could sort by something you never intended to expose — a navigation property, or a column whose ordering leaks information (sorting by `PasswordHash` reveals its relative ordering, and with enough queries, its value).

```csharp
private static readonly HashSet<string> Sortable =
    new(["title", "createdAt", "dueDate", "priority", "status"], StringComparer.OrdinalIgnoreCase);

if (!Sortable.Contains(propertyName))
    throw new ArgumentException($"Cannot sort by '{propertyName}'. Valid: {string.Join(", ", Sortable)}.");
```

The same rule as Phase 12's saved searches: **never let user input select a code path by name without an allowlist.** This is the expression-tree equivalent of SQL injection.
:::

## Rewriting with `ExpressionVisitor`

```csharp
public sealed class ParameterReplacer(ParameterExpression from, ParameterExpression to) : ExpressionVisitor
{
    protected override Expression VisitParameter(ParameterExpression node) =>
        node == from ? to : base.VisitParameter(node);
}
```

That is the class Phase 12's `Specification.And` needed — it rewrites two lambdas to share one parameter so their bodies can be combined.

A more interesting one — a visitor that makes every string comparison case-insensitive:

```csharp
public sealed class CaseInsensitiveVisitor : ExpressionVisitor
{
    protected override Expression VisitBinary(BinaryExpression node)
    {
        if (node.NodeType is ExpressionType.Equal && node.Left.Type == typeof(string))
        {
            var ilike = typeof(NpgsqlDbFunctionsExtensions).GetMethod("ILike",
                [typeof(DbFunctions), typeof(string), typeof(string)])!;

            return Expression.Call(ilike,
                Expression.Constant(EF.Functions), Visit(node.Left)!, Visit(node.Right)!);
        }
        return base.VisitBinary(node);
    }
}
```

`ExpressionVisitor` uses the Visitor pattern: override the `VisitX` method for the node type you care about, call `base` for everything else, and it walks the whole tree for you.

## Compiling

```csharp
var predicate = expression.Compile();                     // IL emitted at runtime
var fast = expression.Compile(preferInterpretation: false);
```

Compilation costs roughly **50–200 microseconds** — 50,000× the cost of one invocation. So:

- Compiling once and reusing: excellent.
- Compiling per call: far slower than reflection.

```csharp
private static readonly ConcurrentDictionary<string, Func<TaskItem, bool>> Cache = new();
var predicate = Cache.GetOrAdd(key, static k => BuildExpression(k).Compile());
```

::: exercise Level 1 — Guided · Build, inspect, rewrite
1. Print the tree structure of `t => t.Priority == Priority.Urgent && t.DueDate < today` recursively — write a small visitor that indents by depth.
2. Build `t => t.Title.Contains("bug")` by hand and use it in a query. Check the SQL.
3. Write `OrderByProperty` with an allowlist and use it in your search endpoint.
4. Write `ParameterReplacer` and use it to implement `Specification.And`.
5. Benchmark: `Compile()` per call versus cached. Record both.
6. Take a specification, print `ToQueryString()` for it, and confirm your composition produces one `WHERE` clause.
:::

::: challenge Level 3 · A query language
Let users write filters like:

```text
status = open AND (priority >= high OR label = security) AND due < 2026-10-01
```

Requirements:
1. Parse to an expression tree that EF Core translates to SQL.
2. Field names, operators and values all validated against an allowlist.
3. Type-aware: comparing a date to a string is a clear error, not an exception at query time.
4. Helpful parse errors with the position of the problem.
5. No injection is possible — prove it with hostile inputs.
6. The parsed filter is cacheable by its text.
7. Round-trips: expression → text → expression produces the same SQL.

This is a real feature (Jira, GitHub and Linear all have one) and a genuinely hard exercise.
:::

::: solution
The architecture is a standard three-stage pipeline:

```text
text → tokenise → parse to an AST → validate types → build expression tree → EF Core → SQL
```

The security properties come from keeping those stages separate and validating between them:

```csharp
private static readonly Dictionary<string, FieldDefinition> Fields = new(StringComparer.OrdinalIgnoreCase)
{
    ["status"]   = new(typeof(TaskStatus), t => t.Status,   [Op.Eq, Op.Ne, Op.In]),
    ["priority"] = new(typeof(Priority),   t => t.Priority, [Op.Eq, Op.Ne, Op.Gt, Op.Gte, Op.Lt, Op.Lte]),
    ["due"]      = new(typeof(DateOnly?),  t => t.DueDate,  [Op.Lt, Op.Lte, Op.Gt, Op.Gte, Op.IsNull]),
    ["label"]    = new(typeof(string),     t => t.Labels,   [Op.Eq, Op.Contains]),
    ["title"]    = new(typeof(string),     t => t.Title,    [Op.Contains, Op.StartsWith]),
};
```

That dictionary is the entire attack surface. A field not in it cannot be referenced; an operator not listed for a field cannot be applied to it; and the declared type drives parsing of the value, so `due < "banana"` fails at parse time with a position, not at query time with a database error.

```csharp
private Expression BuildComparison(string field, Op op, string rawValue, int position)
{
    if (!Fields.TryGetValue(field, out var definition))
        throw new QueryParseException($"Unknown field '{field}'.", position, Fields.Keys);

    if (!definition.AllowedOperators.Contains(op))
        throw new QueryParseException(
            $"Operator '{op}' cannot be used with '{field}'. Allowed: {string.Join(", ", definition.AllowedOperators)}.",
            position);

    if (!TryParseValue(rawValue, definition.Type, out var value))
        throw new QueryParseException(
            $"'{rawValue}' is not a valid {definition.Type.Name} for '{field}'.", position);

    return definition.BuildComparison(op, value);
}
```

**Why injection is impossible here, structurally:** nothing from the user's text ever becomes code or SQL. Field names select a pre-built accessor from a dictionary; operators select from an enum; values are parsed into typed constants which become `ConstantExpression` nodes, and EF Core turns those into **parameters**. There is no path from text to executed anything.

Compare that with the naive approach — building a SQL string, or `DynamicExpressionParser.ParseLambda(userInput)` from `System.Linq.Dynamic.Core`, which evaluates arbitrary expressions including method calls. The dynamic LINQ library is convenient and is a genuine remote-code-execution risk on untrusted input. If you use it, restrict it severely.

For requirement 4, carrying positions through the tokeniser makes errors genuinely useful:
```text
status = open AND priority >> high
                           ^
Unknown operator '>>' at position 27. Did you mean '>=' ?
```
:::

::: project Expression trees in TaskFlow
1. `OrderByProperty` with an allowlist, used by the search endpoint.
2. `ParameterReplacer` and working `Specification.And`/`Or`/`Not`.
3. Compiled expressions cached, never compiled per call.
4. A tree-printing debug helper.
5. Optionally, the query language — if you attempt it, it is the single most impressive thing in the repository.
6. `DECISIONS.md`: where you used expression trees and where a plain lambda was enough.

Commit.
:::

::: interview What is an expression tree and where are they used?
`Expression<TDelegate>` represents a lambda as a data structure — nodes for parameters, member access, operators and constants — rather than as compiled IL. That means code can be inspected and translated instead of only invoked.

It is the mechanism behind LINQ providers. `IQueryable<T>` takes expression trees, so EF Core walks the tree and emits SQL; `IEnumerable<T>` takes compiled delegates, which is why assigning a query to an `IEnumerable` variable silently moves filtering into memory.

Beyond querying, they are used to build predicates dynamically — a sort by a user-supplied column, a composable specification — and to compile fast property accessors that avoid reflection's per-call cost.

The safety point I would make is that any user-supplied field or operator name must go through an allowlist. Building expressions from arbitrary user text, or using dynamic LINQ parsing on untrusted input, is the expression-tree equivalent of SQL injection.
:::

::: checkpoint
- [ ] I printed an expression tree's structure and could read it
- [ ] I built an expression by hand and it translated to SQL
- [ ] I wrote an `ExpressionVisitor` that rewrites nodes
- [ ] Compiled expressions are cached
- [ ] Every user-supplied field or operator name goes through an allowlist
:::

## Common mistakes

::: mistake
**`Compile()` on every call.** 50,000× the cost of invoking it.

**Reflecting over any property for dynamic sorting.** Allowlist.

**`System.Linq.Dynamic.Core` on untrusted input.** It evaluates arbitrary expressions.

**Combining expressions with `&&` on the lambdas.** You need a parameter replacer; the naive version produces an invalid tree.

**Expression trees where a lambda would do.** They are for translation and dynamism, not for style.
:::
