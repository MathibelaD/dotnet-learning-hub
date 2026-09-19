---
title: Project structure and program entry
summary: Namespaces, usings, top-level statements, and what the compiler is actually doing with your file.
minutes: 30
stage: Stage 1
---

## What are we learning?

How a C# program is physically organised: files, namespaces, `using` directives, and the entry point. This is fifteen minutes of knowledge that removes a permanent low-level confusion.

## The smallest program

```csharp
Console.WriteLine("TaskFlow v0.1");
```

That is a complete C# program. It is called a **top-level statement** file, and the compiler rewrites it into this:

```csharp
internal class Program
{
    private static void Main(string[] args)
    {
        Console.WriteLine("TaskFlow v0.1");
    }
}
```

Two rules follow from that rewrite, and both surprise people:

1. **Only one file per project may have top-level statements.** There is one `Main`.
2. **Top-level statements must come first.** You can declare classes *below* them in the same file, but not above.

```csharp
Console.WriteLine(Describe(new TaskItem("Learn C#")));   // statements first

static string Describe(TaskItem t) => $"Task: {t.Title}";  // local function, fine

class TaskItem(string title)                                // type declarations after
{
    public string Title { get; } = title;
}
```

## Namespaces and usings

A **namespace** is a naming scope — the C# equivalent of a package path. It is not tied to folders, though by convention it mirrors them.

```csharp
namespace TaskFlow.Domain;      // file-scoped namespace, applies to the whole file

public class TaskItem { }
```

The older block form still exists and you will see it everywhere:

```csharp
namespace TaskFlow.Domain
{
    public class TaskItem { }
}
```

Prefer the file-scoped form — one less level of indentation in every file you ever write.

A **`using` directive** brings a namespace's types into scope so you can write `List<int>` instead of `System.Collections.Generic.List<int>`.

```csharp
using System.Text;                       // ordinary
using System.Text.Json;                  
global using TaskFlow.Domain;            // applies to every file in the project
using Json = System.Text.Json.JsonSerializer;  // alias
```

::: note Implicit usings
Your `.csproj` almost certainly contains `<ImplicitUsings>enable</ImplicitUsings>`. That auto-adds a set of `global using` directives — `System`, `System.Collections.Generic`, `System.Linq`, `System.Threading.Tasks` and a few more — which is why `Console.WriteLine` works with no `using System;` at the top.

Want to see exactly which ones? They are generated into a real file:
```bash
cat obj/Debug/net10.0/*.GlobalUsings.g.cs
```
Go and look at it now. Knowing this file exists saves you from "why does this compile in one project but not another".
:::

## `using` has a second, unrelated meaning

This trips up everyone once:

```csharp
using System.IO;                                  // directive: import a namespace

using var file = File.OpenRead("tasks.json");     // statement: dispose when scope ends
```

Same keyword, completely different job. The second is about deterministic cleanup and we cover it properly in Phase 13.

::: exercise Level 1 — Guided · Split a program into files
```bash
cd ~/dotnet-scratch
dotnet new console -o structure && cd structure
```

1. Create `Domain/TaskItem.cs`:
   ```csharp
   namespace Structure.Domain;

   public class TaskItem
   {
       public string Title { get; set; } = "";
   }
   ```
2. Edit `Program.cs` to use it. You will need a `using Structure.Domain;` at the top.
3. `dotnet run` and confirm it works.
4. Now **delete** the `using` line and build again. Read the error code — it will be `CS0246`. Memorise what that code means: *the type or namespace could not be found*.
5. Fix it a second way, without the `using`: refer to the type by its full name `Structure.Domain.TaskItem`.
6. Fix it a third way: add `global using Structure.Domain;` to a new file `GlobalUsings.cs` and remove the per-file using.
:::

::: challenge Make the compiler complain, deliberately
Produce each of these errors on purpose, note the error code, and then fix it. Do not look them up first — read what the compiler says.

1. Two files in the same project both containing top-level statements.
2. A class declared *above* a top-level statement in `Program.cs`.
3. Two classes with the same name in the same namespace.
4. A `public` class in a file whose type is used from another project that has no reference to it.
:::

::: solution
1. `CS8802: Only one compilation unit can have top-level statements.` Fix by moving one file's code into a method, or deleting it.
2. `CS8803: Top-level statements must precede namespace and type declarations.` Move the class below.
3. `CS0101: The namespace already contains a definition for 'X'.` Rename, or move one to a different namespace.
4. `CS0246` again — the type isn't visible because there is no *project reference*. `public` controls visibility within the assemblies that reference you; it does not create the reference. That distinction matters a lot from Phase 5 onward.

Notice that (4) produces the same error code as a missing `using`. The compiler cannot tell the difference between "you forgot to import it" and "you forgot to reference the project". When you hit `CS0246`, check both.
:::

::: project Give TaskFlow a domain namespace
In your TaskFlow repo:

```bash
cd ~/taskflow/src/TaskFlow.Console
mkdir -p Domain
```

Create `Domain/TaskItem.cs`:

```csharp
namespace TaskFlow.Domain;

public class TaskItem
{
    public string Title { get; set; } = "";
}
```

Update `Program.cs` so it creates one and prints its title. Then:

```bash
cd ~/taskflow && dotnet run --project src/TaskFlow.Console
git add . && git commit -m "Stage 1: TaskItem in the domain namespace"
```

That `Domain` folder is the seed of the whole application. By Phase 8 it becomes its own project with rules about what may depend on it.
:::

::: interview Why does `Console.WriteLine` work without `using System;`?
Because modern project templates enable **implicit usings**, which the SDK turns into a generated file of `global using` directives (`obj/.../GlobalUsings.g.cs`) including `System`. A `global using` applies to every file in the project.

You can disable it with `<ImplicitUsings>disable</ImplicitUsings>`, at which point every file needs its own `using System;` — which is what all pre-.NET-6 code looks like.
:::

::: checkpoint
- [ ] I can explain what the compiler generates from a top-level statement file
- [ ] I read my project's generated `GlobalUsings.g.cs`
- [ ] I produced `CS8802`, `CS8803`, `CS0101` and `CS0246` on purpose and fixed each
- [ ] I know the two unrelated meanings of the `using` keyword
- [ ] TaskFlow has a `TaskFlow.Domain` namespace with a `TaskItem` in it
:::

## Common mistakes

::: mistake
**Assuming namespaces must match folders.** They do not — the compiler does not care. But your colleagues do, and every tool assumes the convention. Follow it.

**Fighting `CS0246` by adding usings at random.** Ask first: does this type exist in my solution at all? Is it in a NuGet package I have not installed? Is it in a project I have not referenced? Three different fixes.

**Writing `namespace X { }` block-style out of habit.** Nothing breaks, but it costs an indent level in every file. File-scoped is the modern default.
:::
