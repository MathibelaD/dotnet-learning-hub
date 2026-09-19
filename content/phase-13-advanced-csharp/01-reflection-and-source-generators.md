---
title: Reflection and source generators
summary: Inspecting types at runtime, what it costs, and the compile-time alternative that is replacing it.
minutes: 40
---

## What are we learning?

Reflection: how it works, how slow it actually is (measured, not asserted), how to make it fast, and when a source generator is the better answer.

## Reflection

```csharp
var type = typeof(TaskItem);
var type2 = task.GetType();
var type3 = Type.GetType("TaskFlow.Domain.TaskItem, TaskFlow.Domain");

type.GetProperties();
type.GetProperty("Title")?.GetValue(task);
type.GetMethod("Complete")?.Invoke(task, [clock]);
type.GetCustomAttribute<AuditableAttribute>();

Activator.CreateInstance(type);
Activator.CreateInstance(typeof(Repository<>).MakeGenericType(typeof(TaskItem)));

assembly.GetTypes().Where(t => typeof(ITaskExporter).IsAssignableFrom(t) && !t.IsAbstract);
```

You have already relied on reflection constantly without writing it: dependency injection resolves constructors, `System.Text.Json` reads properties, EF Core materialises entities, model binding populates DTOs, xUnit discovers `[Fact]` methods.

## Measuring the cost

```bash
dotnet add package BenchmarkDotNet
```

```csharp
[MemoryDiagnoser]
public class PropertyAccessBenchmarks
{
    private readonly TaskItem _task = new("Benchmark", Guid.NewGuid(), Priority.Normal, TimeProvider.System);
    private readonly PropertyInfo _property = typeof(TaskItem).GetProperty(nameof(TaskItem.Title))!;
    private readonly Func<TaskItem, string> _compiled = CompileGetter();

    [Benchmark(Baseline = true)]
    public string Direct() => _task.Title;

    [Benchmark]
    public string Reflection() => (string)typeof(TaskItem).GetProperty("Title")!.GetValue(_task)!;

    [Benchmark]
    public string CachedPropertyInfo() => (string)_property.GetValue(_task)!;

    [Benchmark]
    public string CompiledDelegate() => _compiled(_task);

    private static Func<TaskItem, string> CompileGetter()
    {
        var parameter = Expression.Parameter(typeof(TaskItem), "t");
        var body = Expression.Property(parameter, nameof(TaskItem.Title));
        return Expression.Lambda<Func<TaskItem, string>>(body, parameter).Compile();
    }
}
```

Typical results:

```text
| Method             |        Mean | Ratio | Allocated |
|------------------- |------------:|------:|----------:|
| Direct             |   0.0004 ns |  1.00 |         - |
| Reflection         | 180.0000 ns | ~450k |      32 B |
| CachedPropertyInfo |  38.0000 ns | ~95k  |      24 B |
| CompiledDelegate   |   1.2000 ns |  ~3   |         - |
```

::: why What those numbers actually mean
**Reflection is not "slow" in absolute terms** — 180 nanoseconds is nothing if you do it once at startup.

It is catastrophic in a loop. Reflecting over 10 properties for 100,000 objects: 180ns × 1,000,000 = **180 milliseconds**, plus 32 MB allocated, per operation. Direct access: effectively free.

The two mitigations, in order:
1. **Cache the `PropertyInfo`.** Five times faster, and trivial — a `ConcurrentDictionary<Type, PropertyInfo[]>`. Most of reflection's cost is *looking up* the member, not using it.
2. **Compile a delegate** from an expression tree. Within 3× of direct access. This is what Dapper, AutoMapper and serialisers do internally.

The general rule: **reflect once, at startup; cache the result; never reflect per item in a hot path.**
:::

## Source generators

A source generator runs during compilation and emits C# that is compiled with your code. Everything a generator does happens at build time, so the runtime cost is zero.

You have already used several:

```csharp
[LoggerMessage(Level = LogLevel.Information, Message = "Completing {taskId}")]
public static partial void CompletingTask(ILogger logger, Guid taskId);
```

```csharp
[JsonSerializable(typeof(TaskResponse))]
internal partial class TaskJsonContext : JsonSerializerContext { }

JsonSerializer.Serialize(response, TaskJsonContext.Default.TaskResponse);   // no reflection
```

```csharp
[Mapper]
public static partial class TaskMapper
{
    public static partial TaskResponse ToResponse(TaskItem task);
}
```

```csharp
[GeneratedRegex(@"^[\w.-]+@[\w.-]+$", RegexOptions.IgnoreCase)]
private static partial Regex EmailPattern();
```

Each of these replaces runtime reflection with generated code. The JSON source generator is the most consequential: it removes reflection from serialisation entirely, which is both faster and a requirement for Native AOT (where reflection over unreferenced types cannot work, because the code was trimmed away).

::: design Reflection or source generator?
| | Reflection | Source generator |
|---|---|---|
| When it runs | Runtime | Compile time |
| Cost | Nanoseconds to microseconds per call | Zero at runtime |
| Works with unknown types | **Yes** | No — types must be known at compile time |
| Debuggable | Hard | Yes — it is ordinary C# you can step into |
| Trimming / Native AOT safe | Often not | Yes |
| Build time | No impact | Slower builds |
| Complexity to write | Low | Moderate to high |

**Use reflection** for startup work: DI scanning, plugin loading, migrations, anything over types you genuinely do not know until runtime.

**Use a source generator** for anything per-request or per-item where the types *are* known: serialisation, mapping, logging, validation.

**In your own application code, prefer neither.** An explicit method call beats both. Reflection and generators are for framework-shaped problems — when you must handle types you did not write.
:::

## Writing one

```csharp
[Generator]
public sealed class EndpointRegistrationGenerator : IIncrementalGenerator
{
    public void Initialize(IncrementalGeneratorInitializationContext context)
    {
        var endpoints = context.SyntaxProvider
            .ForAttributeWithMetadataName(
                "TaskFlow.Api.EndpointAttribute",
                predicate: static (node, _) => node is ClassDeclarationSyntax,
                transform: static (ctx, _) => ctx.TargetSymbol.ToDisplayString())
            .Collect();

        context.RegisterSourceOutput(endpoints, static (spc, names) =>
        {
            var source = $$"""
                namespace TaskFlow.Api;

                public static partial class EndpointRegistration
                {
                    public static void MapGeneratedEndpoints(this WebApplication app)
                    {
                        {{string.Join("\n        ", names.Select(n => $"new {n}().Map(app);"))}}
                    }
                }
                """;
            spc.AddSource("EndpointRegistration.g.cs", source);
        });
    }
}
```

`IIncrementalGenerator` — not the older `ISourceGenerator` — is what you should write. It caches intermediate results so the IDE does not re-run your generator on every keystroke.

To see the output:

```xml
<EmitCompilerGeneratedFiles>true</EmitCompilerGeneratedFiles>
<CompilerGeneratedFilesOutputPath>$(BaseIntermediateOutputPath)Generated</CompilerGeneratedFilesOutputPath>
```

Then read `obj/Generated/**/*.g.cs`. Do this for the generators you already use — reading `LoggerMessage`'s output teaches you more about high-performance logging than any article.

::: exercise Level 1 — Guided · Measure and then remove reflection
1. Set up BenchmarkDotNet and run the property-access benchmark. Record your numbers.
2. Write an audit formatter using uncached reflection over all properties. Benchmark it for 100,000 objects.
3. Add a `ConcurrentDictionary` cache of `PropertyInfo[]`. Benchmark again.
4. Compile getter delegates with expression trees. Benchmark again.
5. Write the equivalent by hand. Benchmark. This is your floor.
6. Enable `EmitCompilerGeneratedFiles` and read what `[LoggerMessage]` generates.
7. Add the JSON source generator to TaskFlow's API and benchmark serialisation before and after.

Put every number in `DECISIONS.md`. Measured numbers are what let you argue from evidence.
:::

::: challenge Level 3 · Replace a reflective component
Find the most reflection-heavy piece of TaskFlow — probably your auditing or validation code — and produce three versions.

Requirements:
1. Version A: straightforward reflection.
2. Version B: cached reflection plus compiled delegates.
3. Version C: a source generator, or hand-written code generated by a template.
4. Benchmark all three for 1, 100 and 100,000 objects.
5. Measure startup cost as well as steady-state — a compiled delegate is not free to build.
6. Decide which to ship, and at what scale the answer changes.
7. Confirm C works under `PublishTrimmed` and A does not.
:::

::: solution
Representative results for formatting an audit line from 10 properties:

```text
| Method              | Objects |         Mean | Allocated |
|-------------------- |-------- |-------------:|----------:|
| Reflection          |       1 |     2.100 us |     880 B |
| CachedReflection    |       1 |     0.420 us |     640 B |
| CompiledDelegates   |       1 |     0.031 us |     240 B |
| SourceGenerated     |       1 |     0.024 us |     240 B |
| Reflection          |  100000 |   210.000 ms |   88.0 MB |
| CachedReflection    |  100000 |    42.000 ms |   64.0 MB |
| CompiledDelegates   |  100000 |     3.100 ms |   24.0 MB |
| SourceGenerated     |  100000 |     2.400 ms |   24.0 MB |
```

Plus a startup cost not shown in the table: compiling the delegates takes roughly **1–3 ms per type**, paid once. For 20 entity types that is about 40ms added to startup — usually acceptable, occasionally not (serverless cold starts).

**What to ship:** for TaskFlow, cached reflection. The audit formatter runs a handful of times per request, so 0.42µs versus 0.024µs is invisible, and it is far less code than a generator. The source generator would be right if this ran per row in a bulk export.

**The trimming result is the decisive one.** Under `PublishTrimmed`:
```text
Version A: System.MissingMethodException — the property was trimmed away
Version C: works
```
The trimmer removes members nothing statically references. Reflection over a property nobody calls directly means the trimmer removes it and reflection fails at runtime — an error that appears only in the published build, never in development. That is the real reason source generators are replacing reflection across .NET: **trimming and Native AOT are the direction of travel, and reflection is fundamentally incompatible with them.**

If you never trim, reflection stays fine. If you ever want a 12MB self-contained container image or a 30ms cold start, it does not.
:::

::: project Reduce reflection in TaskFlow
1. Find every use of reflection in your code (`GetProperty`, `GetCustomAttribute`, `Activator.CreateInstance`, `GetTypes`).
2. Classify each: startup or per-request.
3. Cache every per-request one.
4. Add the `System.Text.Json` source generator to the API and benchmark the difference.
5. Convert every `new Regex(...)` to `[GeneratedRegex]`.
6. Convert your hottest log calls to `[LoggerMessage]`.
7. Try `dotnet publish -p:PublishTrimmed=true` and record what breaks.
8. All numbers in `DECISIONS.md`.

Commit.
:::

::: interview What is reflection and what does it cost?
Reflection is inspecting and invoking types, members and attributes at runtime rather than at compile time. It is what makes dependency injection, serialisation, ORMs and test discovery possible — they all work with types they have never seen.

The cost is roughly two orders of magnitude versus direct access — around 180 nanoseconds for a reflective property read against effectively zero — plus allocation. That is irrelevant once at startup and severe in a per-item loop. Most of the cost is member lookup, so caching the `PropertyInfo` gets you most of the way back, and compiling a delegate from an expression tree gets within about 3× of direct access.

The modern alternative is source generators, which emit ordinary C# at compile time — `[LoggerMessage]`, the JSON source generator, `[GeneratedRegex]`, Mapperly. They cost nothing at runtime, they are debuggable, and crucially they survive trimming and work under Native AOT, where reflection over members nothing statically references fails.
:::

::: checkpoint
- [ ] I measured reflection, cached reflection, compiled delegates and direct access
- [ ] I read the code that `[LoggerMessage]` generates
- [ ] Every per-request reflection in TaskFlow is cached
- [ ] The JSON source generator is wired up and benchmarked
- [ ] I saw what trimming does to reflective code
:::

## Common mistakes

::: mistake
**Reflection in a loop.** Two orders of magnitude, multiplied by the item count.

**`GetProperty` per call instead of caching it.** Most of the cost is the lookup.

**`ISourceGenerator` instead of `IIncrementalGenerator`.** The IDE re-runs it on every keystroke.

**Assuming reflection works after trimming.** It fails only in the published build.

**Reflection where a method call would do.** It is for framework problems, not application ones.
:::
