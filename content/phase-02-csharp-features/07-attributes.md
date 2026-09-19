---
title: Attributes
summary: Metadata attached to your code that frameworks read at runtime — and the cost of that convenience.
minutes: 25
stage: Stage 1
---

## What are we learning?

Attributes: how to read them, how to write them, and what it means that they do nothing on their own.

## Attributes are inert

```csharp
[Obsolete("Use CompleteAsync instead")]
public void Complete() { }
```

This attribute does not change what `Complete()` does. It attaches metadata to the method in the compiled assembly. Something else — the compiler, a framework, a serialiser, a test runner — reads that metadata and behaves differently.

**An attribute with nothing reading it has no effect whatsoever.** That is the single most useful thing to understand about them, because it explains most "why is my attribute being ignored" confusion: you put `[Required]` on a class that ASP.NET Core's model binder never sees, or `[JsonPropertyName]` on a type serialised by a different serialiser.

## Attributes you will meet

```csharp
// Compiler
[Obsolete("message", error: false)]
[Conditional("DEBUG")]                 // calls to this method are removed in release builds
[CallerMemberName] [CallerArgumentExpression("x")] [CallerLineNumber]

// Nullable analysis (Phase 1)
[NotNullWhen(true)] [MaybeNull] [MemberNotNull(nameof(_field))]

// Serialisation (Phase 6)
[JsonPropertyName("due_date")] [JsonIgnore] [JsonConverter(typeof(MyConverter))]

// ASP.NET Core (Phase 6)
[ApiController] [Route("api/[controller]")] [HttpGet("{id:guid}")]
[FromBody] [FromQuery] [FromRoute] [Authorize(Roles = "Admin")]

// Validation (Phase 6)
[Required] [MaxLength(200)] [Range(1, 5)] [EmailAddress]

// EF Core (Phase 7)
[Key] [Column("created_at")] [Table("tasks")] [NotMapped]

// Testing (Phase 10)
[Fact] [Theory] [InlineData(1, 2, 3)]
```

The bracket syntax is always `[Name(positionalArgs, NamedProperty = value)]`, and the `Attribute` suffix is dropped: `[Obsolete]` is `ObsoleteAttribute`.

## Writing your own

```csharp
[AttributeUsage(AttributeTargets.Property | AttributeTargets.Field, AllowMultiple = false)]
public sealed class SensitiveAttribute(string reason) : Attribute
{
    public string Reason { get; } = reason;
    public bool RedactInLogs { get; init; } = true;
}
```

Usage:

```csharp
public class User
{
    public string Email { get; set; } = "";

    [Sensitive("PII", RedactInLogs = true)]
    public string PhoneNumber { get; set; } = "";
}
```

Constructor parameters become positional arguments; settable properties become named arguments. Attribute arguments must be **compile-time constants** — primitives, strings, enums, `typeof(...)`, or arrays of those. You cannot pass a `DateTime` or a lambda.

## Reading them

```csharp
var sensitive = typeof(User)
    .GetProperties()
    .Where(p => p.GetCustomAttribute<SensitiveAttribute>() is { RedactInLogs: true })
    .Select(p => p.Name)
    .ToHashSet();
```

That is reflection, and it is why attributes have a cost:

::: warn Reflection is slow, and attributes usually mean reflection
`GetCustomAttribute` walks metadata and allocates. Doing it once at startup and caching the result is fine. Doing it per request — or worse, per item in a loop — is a real performance problem. Every serious framework caches its attribute scans.

If you write attribute-driven code, cache:
```csharp
private static readonly ConcurrentDictionary<Type, string[]> Cache = new();
static string[] SensitiveProperties(Type t) => Cache.GetOrAdd(t, Scan);
```

Phase 13 measures the difference, and covers source generators — the modern alternative that does the same work at compile time with no runtime cost.
:::

## The caller-info attributes

These are the ones you will actually use most, and they involve no reflection at all — the compiler fills them in:

```csharp
public static void Log(
    string message,
    [CallerMemberName] string? member = null,
    [CallerFilePath] string? file = null,
    [CallerLineNumber] int line = 0)
{
    Console.WriteLine($"{Path.GetFileName(file)}:{line} {member}: {message}");
}

Log("something happened");   // Program.cs:42 DoWork: something happened
```

And the one from Phase 1:

```csharp
public static void Require(bool condition,
    [CallerArgumentExpression(nameof(condition))] string? expr = null)
{
    if (!condition) throw new InvalidOperationException($"Requirement failed: {expr}");
}

Require(task.Priority == Priority.Urgent);
// throws: Requirement failed: task.Priority == Priority.Urgent
```

::: exercise Level 1 — Guided · Write and read an attribute
1. Create `[AuditedAttribute]` applicable to classes, with a `string Category` and a `bool IncludeValues` property.
2. Apply it to `TaskItem` and `Project` but not `Comment`.
3. Write `IReadOnlyList<Type> FindAudited(Assembly assembly)` that returns every type carrying it.
4. Write `string Describe(object entity)` that, for an audited type, lists its property names and — if `IncludeValues` — their values.
5. Measure: call `Describe` 100,000 times, then add a `ConcurrentDictionary` cache of the reflection results and measure again. Write both numbers down.
:::

::: solution
```csharp
[AttributeUsage(AttributeTargets.Class, Inherited = true)]
public sealed class AuditedAttribute(string category) : Attribute
{
    public string Category { get; } = category;
    public bool IncludeValues { get; init; }
}

public static class Auditing
{
    private static readonly ConcurrentDictionary<Type, (AuditedAttribute? Attr, PropertyInfo[] Props)> Cache = new();

    public static IReadOnlyList<Type> FindAudited(Assembly assembly) =>
        assembly.GetTypes()
            .Where(t => t.GetCustomAttribute<AuditedAttribute>() is not null)
            .ToList();

    public static string Describe(object entity)
    {
        var (attr, props) = Cache.GetOrAdd(entity.GetType(), static t =>
            (t.GetCustomAttribute<AuditedAttribute>(), t.GetProperties()));

        if (attr is null) return "";

        var parts = props.Select(p => attr.IncludeValues
            ? $"{p.Name}={p.GetValue(entity)}"
            : p.Name);

        return $"[{attr.Category}] {string.Join(", ", parts)}";
    }
}
```

Typical measurements on a modern laptop for 100,000 calls: roughly **900ms uncached**, roughly **60ms cached** — about 15×. `p.GetValue(entity)` is itself reflection and stays slow even when cached; compiled expression trees or source generators are the next step (Phase 13).

The `static` on the lambda in `GetOrAdd` is worth copying: it forbids capturing, which guarantees the delegate is allocated once rather than per call.
:::

::: challenge Level 3 · Attribute-driven validation
Build a miniature version of what ASP.NET Core does in Phase 6.

Requirements:
- `[NotEmpty]`, `[MaxLength(n)]`, `[Range(min, max)]` attributes.
- `IReadOnlyList<string> Validate(object model)` that reflects over the model's properties and returns one message per violation, naming the property.
- Attribute lookups cached per type.
- Works on any object, including records.
- Bonus: make an inherited attribute on a base class apply to derived types.

Then compare your implementation with `System.ComponentModel.DataAnnotations.Validator.TryValidateObject` — which does exactly this and ships in the box. When would you use yours instead? (Answer honestly: almost never.)
:::

::: project Add an audit marker to TaskFlow
1. Create `[Auditable]` in the domain, applied to `TaskItem`, `Project` and `Comment`.
2. Mark `User.PasswordHash` (add the property now — Phase 9 fills it in) with `[Sensitive("credential")]`.
3. Write `AuditFormatter` that renders any auditable entity to a one-line string, redacting `[Sensitive]` properties as `***`.
4. Cache the reflection.
5. Use it in your `LoggingStore` decorator so every operation logs a redacted entity description.

Then write in `DECISIONS.md`: what is the alternative to this attribute-driven design, and when would it be better? Consider an explicit `IAuditable { string ToAuditLine(); }` interface.

Commit.
:::

::: solution The DECISIONS.md answer
The alternative is an interface:

```csharp
public interface IAuditable { string ToAuditLine(); }
```

| | Attribute + reflection | Interface |
|---|---|---|
| Compile-time checked | No — a typo in the category is a runtime surprise | Yes |
| Performance | Reflection, needs caching | Direct call |
| Cost per entity | Zero extra code | One method per type |
| Can decorate individual properties | Yes | No, without extra machinery |
| Discoverable by scanning | Yes | Yes (`is IAuditable`) |
| Works on types you do not own | Yes, if you control the assembly | No |

The honest conclusion for an application: **the interface is better.** It is explicit, fast, and the compiler enforces it. Attributes win when you need per-property metadata (like `[Sensitive]`), when a framework outside your control is doing the reading, or when the alternative would force every type to implement something it does not care about.

Real frameworks use attributes because they must work with types they have never seen. Your own application does not have that constraint, and reaching for reflection when a direct call would do is the most common way application code becomes slow and hard to follow.
:::

::: interview What are attributes in C#?
Declarative metadata attached to code elements — assemblies, types, members, parameters — and stored in the compiled assembly. They do nothing by themselves; something must read them, usually via reflection at runtime, occasionally by the compiler.

Examples across the stack: `[ApiController]` and `[HttpGet]` tell ASP.NET Core how to route, `[Required]` drives model validation, `[Fact]` tells xUnit what to run, `[Column]` tells EF Core how to map.

The trade-off worth stating: they decouple metadata from behaviour and let frameworks work with types they have never seen, but reading them is reflection, which is slow and unchecked at compile time. Frameworks cache aggressively, and source generators are increasingly replacing runtime reflection.
:::

::: checkpoint
- [ ] I can explain why an attribute with nothing reading it does nothing
- [ ] I wrote a custom attribute with positional and named arguments
- [ ] I measured cached vs uncached reflection and wrote both numbers down
- [ ] I used `[CallerArgumentExpression]` to build a guard helper
- [ ] I compared the attribute approach against an interface in writing
:::

## Common mistakes

::: mistake
**Expecting an attribute to do something on its own.** `[Required]` on a class nothing validates has no effect at all.

**Reflection in a hot path.** `GetCustomAttribute` per request adds up fast. Cache per type.

**Attribute arguments that need to be dynamic.** They must be compile-time constants. No `DateTime.Now`, no lambdas, no `new`.

**Forgetting `[AttributeUsage]`.** Without it your attribute can be applied to anything, including places where your reader will never look.
:::
