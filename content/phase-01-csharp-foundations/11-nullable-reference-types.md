---
title: Nullable reference types
summary: The feature that moves NullReferenceException from runtime to compile time — if you let it.
minutes: 35
stage: Stage 1
---

## What are we learning?

Nullable reference types (NRTs): what the annotations mean, what the compiler can and cannot prove, and how to stop fighting it.

## The problem

`NullReferenceException` is the most common exception in .NET applications by a wide margin. Before C# 8, the type `string` meant "a string, or null, and you cannot tell which".

With NRTs enabled — and they are enabled by default in every new project — the type system splits:

```csharp
string  title;        // must never be null
string? description;  // may be null, and the compiler will make you check
```

::: warn What NRTs actually are
They are **compile-time analysis only**. There is no runtime check. `string` and `string?` are the same type at runtime; the difference lives in attributes the compiler reads.

That means:
- A `string` parameter *can* still receive null at runtime — from reflection, from JSON deserialisation, from a library compiled without NRTs, or from another project with the feature off.
- For anything crossing your application's boundary — HTTP requests, database rows, config files — you still validate. NRTs protect you from *your own* mistakes, not from the outside world.

This is the single most misunderstood thing about the feature.
:::

## Turning it on

```xml
<PropertyGroup>
  <Nullable>enable</Nullable>
  <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
</PropertyGroup>
```

`<Nullable>enable</Nullable>` is in every template. The second line is the one that matters: nullable violations are **warnings** by default, and warnings get ignored. Make them errors and the feature actually works.

## The warnings you will meet

```csharp
string? maybe = GetTitle();

Console.WriteLine(maybe.Length);        // CS8602: dereference of a possibly null reference
string definite = maybe;                // CS8600: converting null literal or possible null value

public class TaskItem
{
    public string Title { get; set; }   // CS8618: non-nullable property must contain
}                                       //         a non-null value when exiting constructor
```

## How to satisfy the compiler

```csharp
// 1. Check
if (maybe is not null)
    Console.WriteLine(maybe.Length);    // compiler now knows it is non-null here

// 2. Pattern match and capture
if (maybe is { } title)
    Console.WriteLine(title.Length);

// 3. Null-conditional
Console.WriteLine(maybe?.Length);       // int? — null if maybe is null

// 4. Null-coalescing
var safe = maybe ?? "untitled";
maybe ??= "untitled";                   // assign only if null

// 5. Early return / guard
if (maybe is null) return;
Console.WriteLine(maybe.Length);        // flow analysis carried the check forward

// 6. Throw helper
ArgumentNullException.ThrowIfNull(maybe);
Console.WriteLine(maybe.Length);        // the attribute on ThrowIfNull tells the compiler
```

Number 6 deserves attention: `ArgumentNullException.ThrowIfNull` is annotated with `[NotNull]`, so the compiler's flow analysis understands that if it returns, the argument was not null. Custom guard methods can do the same with `[NotNull]` on the parameter.

## The null-forgiving operator

```csharp
string definitely = maybe!;      // "trust me, it is not null"
```

`!` silences the compiler. It does nothing at runtime. It is occasionally correct — when you know something the compiler cannot — and it is very often a lie that produces a `NullReferenceException` three months later.

::: warn Every `!` is a claim you are making
Treat `!` the way you would treat an unchecked cast. Legitimate uses:
- After a `TryGetValue` where you have already tested the bool.
- In test code where a null would legitimately fail the test.
- Interop with a library whose annotations are wrong.

Illegitimate use: making a warning go away because you are in a hurry. If you write `!`, write a comment saying why it is safe. If you cannot write that comment, you have found a bug.
:::

## Fixing `CS8618` on a property

Four correct answers, in order of preference:

```csharp
public required string Title { get; init; }     // 1. caller must set it — usually best
public string Title { get; set; } = "";         // 2. sensible default
public TaskItem(string title) => Title = title; // 3. constructor guarantees it
public string? Title { get; set; }              // 4. it really can be null — be honest
public string Title { get; set; } = null!;      // 5. the lie. avoid.
```

Option 5 appears in a lot of EF Core tutorials, and there it has a real justification — EF sets navigation properties by reflection after construction. Even then, prefer `required` where you can.

::: exercise Level 1 — Guided · Turn the warnings into errors and fix them
In your scratch project:

1. Add `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` to the `.csproj`.
2. Paste this in and build. Every line is a separate error.
   ```csharp
   public class Contact
   {
       public string Name { get; set; }
       public string Email { get; set; }
       public string? Phone { get; set; }

       public string Domain() => Email.Split('@')[1];
       public int PhoneLength() => Phone.Length;
       public string Display() => $"{Name} <{Email}> {Phone.Trim()}";
   }
   ```
3. Fix each one **without** using `!` anywhere. You will need `required`, a null check and a `?.` or `??`.
4. Now write the version that uses `!` for `Phone` and observe what happens at runtime when `Phone` is null. That is the exception you were protected from.
:::

::: challenge Level 3 · Nullability across a boundary
```csharp
public record CreateTaskRequest(string Title, string? Description, string ProjectName);
```

This record arrives from `System.Text.Json` deserialisation. The compiler says `Title` is non-null. Prove that it can be null anyway, then design a defence.

Requirements:
- Demonstrate the null getting through (hint: `{"description": "x"}` with no `title`).
- Add validation that catches it at the boundary and produces a useful error, not a `NullReferenceException` twelve frames deeper.
- Decide where that validation belongs, and be able to defend the choice.
:::

::: solution
```csharp
var json = """{"description":"no title here","projectName":"Inbox"}""";
var req = JsonSerializer.Deserialize<CreateTaskRequest>(json, JsonOpts)!;
Console.WriteLine(req.Title is null);   // True — despite the type saying string
```

The deserialiser constructs the object by reflection and does not consult nullable annotations. The type system lied, because the data came from outside the compiler's view.

Defence — validate at the edge, once:

```csharp
public record CreateTaskRequest(string Title, string? Description, string ProjectName)
{
    public IReadOnlyList<string> Validate()
    {
        var errors = new List<string>();
        if (string.IsNullOrWhiteSpace(Title)) errors.Add("Title is required.");
        if (string.IsNullOrWhiteSpace(ProjectName)) errors.Add("ProjectName is required.");
        if (Title?.Length > TaskRules.MaxTitleLength) errors.Add($"Title exceeds {TaskRules.MaxTitleLength}.");
        return errors;
    }
}
```

**Where it belongs:** at the boundary — the point where untrusted data enters. Inside your domain, types should already be trustworthy, and re-checking everywhere is noise that hides the real logic.

The model to carry for the rest of the course:

```text
untrusted input  ->  VALIDATE HERE  ->  trusted domain types  ->  business logic
```

In Phase 6 this becomes model validation and `ModelState`; in Phase 9 it is also your first line of defence against injection attacks. The principle does not change: one validating boundary, trusted types inside.
:::

::: debug Level 4 · The check that does not help
This still throws `NullReferenceException`. Why?

```csharp
public void Process(TaskItem? task)
{
    if (task == null) 
        throw new ArgumentNullException(nameof(task));

    var project = task.Project;
    Console.WriteLine(project.Name.ToUpper());
}
```
:::

::: solution
The guard protects `task`, not `task.Project`. If `Project` is a nullable navigation property, `project` is null and `project.Name` throws.

The compiler would have told you — `CS8602` on `project.Name` — if `Project` were declared `Project?`. If it is declared non-nullable `Project` but is actually null at runtime, you have the boundary problem again: something (probably an ORM, probably a missing `Include` in Phase 7) constructed the object without the value the type promised.

Fixes, depending on what is true:
```csharp
if (task.Project is not { } project)
    throw new InvalidOperationException($"Task {task.Id} has no project loaded.");
Console.WriteLine(project.Name.ToUpper());
```

The wider point: **a null check is not a strategy.** Ask why the value can be null, and either make it impossible (`required`, constructor) or handle the absence meaningfully. Scattering `if (x != null)` through a codebase just moves the crash somewhere less informative.
:::

::: project Make TaskFlow null-clean
1. Add to `TaskFlow.Console.csproj`:
   ```xml
   <Nullable>enable</Nullable>
   <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
   ```
2. Build. Fix every warning. Do not use `!` anywhere — if you think you need it, restructure.
3. Audit every nullable property you have and ask "can this genuinely be absent?" `Description` and `CompletedAt`: yes. `Title` and `Id`: no.
4. Replace any remaining `= null!` with `required`.
5. Add `ArgumentNullException.ThrowIfNull` to the public entry points of your store.

Commit.

From here on, every project you create in this course starts with those two lines in the `.csproj`. It is the single cheapest quality improvement available in C#.
:::

::: interview What are nullable reference types?
A compile-time feature where reference types are non-nullable by default and `?` marks the ones that may be null. The compiler performs flow analysis and warns when you dereference something that might be null, or assign null to something that should not be.

The critical caveat to state: it is **compile-time only**, with no runtime enforcement. The annotations are metadata; nothing stops null arriving from deserialisation, reflection, or code compiled without the feature. So it eliminates a large class of your own bugs but does not remove the need to validate data at your application's boundaries.
:::

::: checkpoint
- [ ] `TreatWarningsAsErrors` is on in my scratch project and in TaskFlow
- [ ] I fixed every nullable warning without using `!`
- [ ] I proved that JSON deserialisation can produce a null in a non-nullable property
- [ ] I can explain why a null check on a parameter did not prevent the crash
- [ ] I can state the "validate at the boundary, trust inside" model
:::

## Common mistakes

::: mistake
**Leaving nullable warnings as warnings.** They scroll past in the build output and nothing improves. Make them errors on day one of a project; retrofitting later is painful.

**Spraying `!` to make the build pass.** You have disabled the feature while keeping its syntax.

**Believing the annotation at a boundary.** Request DTOs, config binding and database rows all produce values the compiler was not consulted about.

**`if (x != null)` as a reflex.** A null check that hides a design problem just moves the failure. Ask why null is possible at all.
:::
