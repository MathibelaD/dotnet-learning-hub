---
title: Fields, properties and access modifiers
summary: Why C# has properties at all, what the compiler generates, and how to choose an access level on purpose.
minutes: 35
stage: Stage 1
---

## What are we learning?

The difference between a field and a property, why C# insists on properties, and the six access modifiers — including the two nobody explains properly.

## A property is a pair of methods

```csharp
public class TaskItem
{
    public string Title { get; set; }
}
```

The compiler generates roughly this:

```csharp
public class TaskItem
{
    private string <Title>k__BackingField;
    public string get_Title() => <Title>k__BackingField;
    public void set_Title(string value) { <Title>k__BackingField = value; }
}
```

So a property is **not** a variable. It is one or two methods with convenient syntax. Consequences that matter in real code:

- You can change the implementation later without breaking callers' source *or* their compiled code's expectations of the API shape.
- You cannot pass a property to a `ref` or `out` parameter (there is no storage location to point at).
- A property can do work — which means reading one can be expensive, or throw.

## The full range

```csharp
public class TaskItem
{
    private readonly List<string> _labels = [];     // private field, conventional _camelCase

    public string Title { get; set; }               // auto-property, read/write
    public Guid Id { get; }                         // read-only: settable only in the constructor
    public DateTime? CompletedAt { get; private set; }  // public read, private write
    public required string ProjectName { get; init; }   // must be set at construction, then frozen

    public bool IsComplete => CompletedAt is not null;  // computed, no storage

    public IReadOnlyList<string> Labels => _labels;     // expose without exposing mutation

    private string _description = "";
    public string Description                            // full property with logic
    {
        get => _description;
        set => _description = value?.Trim() ?? "";
    }
}
```

### `init` and `required`

```csharp
public class Settings
{
    public required string ConnectionString { get; init; }
    public int Timeout { get; init; } = 30;
}

var s = new Settings { ConnectionString = "Host=localhost" };  // ok
// var bad = new Settings();          // CS9035: required member must be set
// s.ConnectionString = "other";      // CS8852: init-only property
```

`init` means "assignable during object initialisation, immutable afterwards". `required` means "the compiler will not let you construct this without setting it". Together they give you immutable configuration objects with no constructor boilerplate — you will use this constantly for options types in Phase 5.

## Access modifiers

| Modifier | Visible to |
|---|---|
| `public` | Everything, including other assemblies |
| `private` | Only the containing type (**the default** for class members) |
| `protected` | The containing type and anything deriving from it |
| `internal` | Everything in the same assembly (**the default** for top-level types) |
| `protected internal` | Same assembly **OR** derived types anywhere |
| `private protected` | Derived types **within** the same assembly only |

Two things worth burning in:

1. **`internal` is the one that matters in layered applications.** It is how you say "this type exists for my project's internal use, not for other projects to depend on". In Phase 8 you use it to stop the API layer reaching into infrastructure details.
2. **The defaults are asymmetric.** A class member with no modifier is `private`. A top-level class with no modifier is `internal`. Write the modifier explicitly; do not rely on remembering which is which.

::: note InternalsVisibleTo
Tests often need to reach `internal` types. Rather than making everything `public`, open a targeted hole in the `.csproj`:

```xml
<ItemGroup>
  <InternalsVisibleTo Include="TaskFlow.Tests" />
</ItemGroup>
```
You use this in Phase 10.
:::

::: exercise Level 1 — Guided · Encapsulate a mutable collection
This class has a leak. Fix it in three steps.

```csharp
public class TaskItem
{
    public List<string> Labels { get; } = [];
}

var t = new TaskItem();
t.Labels.Add("bug");
t.Labels.Clear();          // nothing stops this
```

1. Confirm the problem: `{ get; }` protects the *reference*, not the *contents*. Anyone can mutate the list.
2. Change the property to return `IReadOnlyList<string>` backed by a private field.
3. Add `AddLabel(string)` and `RemoveLabel(string)` methods so the class controls how the collection changes — for example refusing duplicates and rejecting blank labels.
4. Prove it: try to call `.Add()` from `Program.cs` and confirm it no longer compiles.
:::

::: challenge Level 3 · Is IReadOnlyList actually safe?
Given your fixed class, this compiles:

```csharp
var leaked = (List<string>)task.Labels;
leaked.Clear();
```

Explain why. Then decide whether you care, and implement whichever answer you choose.
:::

::: solution
`IReadOnlyList<T>` is an *interface view*, not a copy. The underlying object is still a `List<string>`, so a cast gets full access to it. `IReadOnlyList` prevents *accidental* mutation, not *deliberate* mutation.

Three options, in ascending cost:

1. **Do nothing.** In application code — which is what you write 95% of the time — this is the right answer. The interface documents intent, and colleagues who cast around it are doing something obviously wrong.
2. **Return a copy:** `public IReadOnlyList<string> Labels => _labels.ToList();` — allocates on every access. Fine for small, rarely-read collections; a performance trap in a hot loop.
3. **Return a genuine wrapper:** `_labels.AsReadOnly()` returns a `ReadOnlyCollection<string>` which cannot be cast back to `List<string>`. One allocation, cached in a field if you like.

If you are writing a library other teams consume, use (3). Inside an application, (1). The habit worth forming is choosing *deliberately* rather than defaulting.
:::

::: debug Level 4 · The property that recurses forever
This throws `StackOverflowException`. Why, and what is the fix?

```csharp
public class TaskItem
{
    public string Title
    {
        get => Title;
        set => Title = value;
    }
}
```
:::

::: solution
The getter returns `Title`, which calls the getter, which returns `Title`... Infinite recursion. A full property needs a **backing field**:

```csharp
private string _title = "";
public string Title
{
    get => _title;
    set => _title = value;
}
```

Or just use an auto-property, `public string Title { get; set; }`, which makes the compiler create the field for you. The only reason to write the long form is to add behaviour to the getter or setter.

A `StackOverflowException` cannot be caught in .NET — the process dies immediately. If your app vanishes with no exception message, an accidentally self-referential property is one of the first things to check.
:::

::: project Tighten TaskFlow's encapsulation
Update `TaskItem`:

- `Id`, `CreatedAt` → `{ get; }`
- `CompletedAt` → `{ get; private set; }`
- Add `private readonly List<string> _labels = [];` and expose `IReadOnlyList<string> Labels`
- Add `AddLabel(string label)` that trims, rejects blanks, and ignores case-insensitive duplicates
- Add `RemoveLabel(string label)` returning `bool` for "was it there"

Add a `Domain/Project.cs`:

```csharp
namespace TaskFlow.Domain;

public class Project
{
    private readonly List<TaskItem> _tasks = [];

    public Guid Id { get; } = Guid.NewGuid();
    public required string Name { get; init; }
    public string? Description { get; init; }
    public IReadOnlyList<TaskItem> Tasks => _tasks;

    public void Add(TaskItem task) => _tasks.Add(task);
}
```

In `Program.cs`, create a project, add three tasks, label them, and print a summary. Commit.
:::

::: interview What is the difference between a field and a property?
A field is a storage location. A property is a pair of accessor methods (`get_X` / `set_X`) that the language lets you use with field-like syntax.

Why it matters in practice: properties let you add validation, lazy computation or logging without changing callers; they are what data-binding, serialisation and ORMs reflect over; and they can be declared on an interface, whereas fields cannot. The cost is that reading a property is a method call that can throw or be slow, so a property should behave like a cheap data access — if it does real work, make it a method so callers can see the cost.
:::

::: checkpoint
- [ ] I can explain what the compiler generates for `{ get; set; }`
- [ ] I know when to use `init` and `required`
- [ ] I can name all six access modifiers and the two defaults
- [ ] I fixed the mutable-collection leak and understand why `IReadOnlyList` is only partial protection
- [ ] TaskFlow has encapsulated labels and a `Project` type
:::

## Common mistakes

::: mistake
**Making every field public "to keep it simple".** You lose validation, you lose the ability to change the implementation, and ORMs and serialisers handle properties far better than fields.

**Using `public List<T>` on a domain type.** It hands every caller the ability to clear your data. Expose `IReadOnlyList<T>` plus intention-revealing methods.

**`{ get; set; }` on something that should never change after construction.** Use `{ get; }` or `{ get; init; }`. An immutable field cannot be the cause of a bug about unexpected mutation.

**Assuming `readonly` on a field makes the object immutable.** `private readonly List<string> _labels` means the *variable* cannot be reassigned. The list contents are still fully mutable.
:::
