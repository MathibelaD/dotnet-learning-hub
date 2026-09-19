---
title: C#, .NET and the ecosystem
summary: The mental model that stops the naming from confusing you for the next six months.
minutes: 25
stage: Stage 1
---

## What are we learning?

What each name in the .NET world actually refers to. This sounds like trivia. It is not — the naming confusion is the single biggest source of wasted time for people arriving from other languages, because half the search results you find will be about a version of the platform that no longer exists.

## The mental model

```text
C#
Programming language — syntax, type system, compiler rules
        ↓
.NET
Platform — the runtime that executes your code, plus the base class library
        ↓
ASP.NET Core
Web framework built on .NET — HTTP, routing, middleware
        ↓
Entity Framework Core
Object-relational mapper built on .NET — talks to your database
        ↓
NuGet
Package manager — how you get everything that is not in the box
```

Read that top-down: each layer only depends on the ones above it.

## Said precisely

**C#** is a language. It has a specification. It compiles to an intermediate language called **IL**, not to machine code.

**.NET** is the platform that runs that IL. It contains:

- the **CLR** (Common Language Runtime) — the virtual machine, the JIT compiler, and the garbage collector
- the **BCL** (Base Class Library) — `string`, `List<T>`, `File`, `HttpClient`, `Task`, and thousands more types

So when you write `List<int>`, `List<T>` comes from .NET, but the generic syntax `<int>` comes from C#. They are separate things that are designed together and shipped together, which is why in practice people say "a .NET developer" and mean "someone who writes C#".

**ASP.NET Core** is a set of NuGet packages for building web applications and APIs on .NET.

**Entity Framework Core** is a set of NuGet packages for mapping C# objects to database tables.

**NuGet** is the package registry (like npm, pip or Maven) and the tooling that fetches packages.

::: warn The version naming trap
There are two families of .NET, and searching without knowing which one you are looking at will cost you hours.

| Name | Status | Runs on | Notes |
|---|---|---|---|
| .NET Framework 4.8 | Legacy, Windows only | Windows | Still maintained, still in production everywhere, **not** what you are learning |
| .NET Core 1–3.1 | Superseded | Cross-platform | The rewrite. The name was dropped after 3.1 |
| .NET 5, 6, 7, 8, 9, 10 | Current | Cross-platform | Just ".NET". Even numbers are LTS |

We use **.NET 10**, the current LTS release. If a Stack Overflow answer mentions `Global.asax`, `web.config` or `System.Web`, it is about .NET Framework and does not apply to you.
:::

## Example

Here is the whole stack visible in ten lines. You do not need to understand it yet — just notice which layer each piece comes from.

```csharp
// C# language:      the syntax, 'var', string interpolation, lambdas
// .NET (BCL):       string, List<T>, DateTime
// ASP.NET Core:     WebApplication, MapGet
// NuGet:            how Microsoft.AspNetCore.* got onto your machine

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

List<string> tasks = ["Write the domain model", "Learn LINQ"];

app.MapGet("/tasks", () => tasks);
app.MapGet("/health", () => new { status = "ok", at = DateTime.UtcNow });

app.Run();
```

That is a complete, working web API. Five lines of it are ASP.NET Core; the rest is plain C# and the base class library.

## How code gets from your file to running

```text
Program.cs  --(Roslyn compiler)-->  TaskFlow.dll (IL)  --(CLR + JIT)-->  machine code
```

Two consequences you will actually feel:

1. **A `.dll` is not a Windows-only thing.** In .NET, `.dll` just means "compiled assembly". Your API on a Linux container is a `.dll` run by the `dotnet` host.
2. **Errors come in two flavours.** *Compile-time* errors (codes like `CS0103`) happen before anything runs. *Runtime* exceptions (`NullReferenceException`) happen while running. C# pushes hard to move errors into the first category — that is the reason for its type system, generics and nullable reference types.

::: exercise Level 1 — Guided · Find the layers on your own machine
1. Ask the SDK what it knows about:
   ```bash
   dotnet --info
   ```
   Read the output. Identify three things: the **SDK version**, the **runtimes installed**, and the **RID** (runtime identifier, e.g. `osx-x64`).
2. Create a project and look at what was produced:
   ```bash
   cd ~/dotnet-scratch
   dotnet new console -o layers && cd layers
   dotnet build
   ls -R bin/Debug/net10.0
   ```
3. Find the `.dll` and the `.json` files. Run the compiled assembly directly, bypassing `dotnet run`:
   ```bash
   dotnet bin/Debug/net10.0/layers.dll
   ```
4. Open `bin/Debug/net10.0/layers.runtimeconfig.json` and read it. Which runtime version does it demand?
:::

::: challenge Predict, then verify
Without running anything, answer these. Then verify with the commands in brackets.

1. If you delete the `bin/` and `obj/` folders, does your source code still build? (`rm -rf bin obj && dotnet build`)
2. Does `dotnet run` compile every time, or only when something changed? (run it twice, watch the timing)
3. `Console.WriteLine` — which layer does it come from: C#, .NET, or ASP.NET Core?
:::

::: solution
1. Yes. `bin/` and `obj/` are build output and intermediate files. They are always safe to delete and should never be committed to git — which is why every .NET `.gitignore` excludes them.
2. It compiles only when inputs changed; the build system tracks timestamps and hashes. The second run is noticeably faster.
3. .NET. `Console` is a type in the base class library (`System.Console`). The C# language contributes the method-call syntax, nothing more. This distinction matters more than it seems: when you search for how to do something, you are almost always searching for a *library* type, not a language feature.
:::

::: project Set up the TaskFlow repository
This is Stage 1 of the project. Create the folder where everything you build will live.

```bash
mkdir -p ~/taskflow && cd ~/taskflow
git init
dotnet new gitignore
dotnet new console -o src/TaskFlow.Console
dotnet run --project src/TaskFlow.Console
```

Then open `src/TaskFlow.Console/Program.cs` and replace its contents with:

```csharp
Console.WriteLine("TaskFlow v0.1");
```

Commit it:

```bash
git add .
git commit -m "Stage 1: empty TaskFlow console app"
```

You will commit at the end of every project step. By the end of the course your git history *is* your learning record, and it is a genuinely good thing to show an interviewer.
:::

::: interview What is the difference between C# and .NET?
C# is a programming language: syntax, type system and compiler rules. .NET is the platform it targets — the runtime (CLR) that executes compiled IL, the JIT compiler, the garbage collector, and the base class library of built-in types.

They are separate concerns that ship together. Other languages (F#, VB.NET) also target .NET, and C# is always compiled to IL rather than native code by default.

A good follow-up to volunteer: ".NET Framework is the legacy Windows-only implementation; modern .NET (5 and later, currently 10) is the cross-platform one, and they are not the same product despite the similar names."
:::

::: checkpoint
- [ ] I can draw the C# → .NET → ASP.NET Core → EF Core stack from memory
- [ ] I ran `dotnet --info` and found the SDK version and RID
- [ ] I ran a compiled `.dll` directly with `dotnet`
- [ ] I know why a Stack Overflow answer mentioning `web.config` is not relevant to me
- [ ] I created and committed the TaskFlow repository
:::

## Common mistakes

::: mistake
**Assuming ".NET Framework" and ".NET" are the same thing.** They are different runtimes with different APIs. This is the number one cause of "why doesn't this code work" when following older tutorials.

**Thinking `.dll` means Windows.** It means "compiled .NET assembly". Your Linux containers will be full of them.

**Installing the runtime instead of the SDK.** The runtime only *runs* apps. The SDK includes the runtime plus the compiler and the `dotnet` CLI. You need the SDK.
:::
