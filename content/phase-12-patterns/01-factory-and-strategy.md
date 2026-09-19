---
title: Factory and Strategy
summary: Choosing what to create, and choosing how to behave — two patterns you have already used without naming them.
minutes: 40
---

## What are we learning?

Two patterns that solve adjacent problems, and how to tell which one you need.

## The problem shapes

```text
FACTORY     "I need an object, but which concrete type depends on something at runtime."
STRATEGY    "I need a behaviour, and which algorithm to use depends on something at runtime."
```

The distinction: a factory decides **what to create**; a strategy decides **how to do something**. A factory usually returns a strategy.

## Factory

You have already written one, in Phase 5:

```csharp
builder.Services.AddSingleton<ITaskStore>(sp =>
{
    var options = sp.GetRequiredService<IOptions<TaskFlowOptions>>().Value;
    return options.Storage switch
    {
        StorageKind.InMemory => new InMemoryTaskStore(),
        StorageKind.Postgres => sp.GetRequiredService<EfTaskStore>(),
        _ => throw new InvalidOperationException($"Unknown storage {options.Storage}")
    };
});
```

That lambda is a factory. In .NET, the DI container is usually the factory you want — you rarely need a dedicated `ITaskStoreFactory` class.

When you do need one, it is because the decision happens **per call**, not per application:

```csharp
public interface IExporterFactory
{
    ITaskExporter Create(string format);
    IReadOnlyCollection<string> SupportedFormats { get; }
}

public sealed class ExporterFactory(IServiceProvider services, IEnumerable<ITaskExporter> exporters)
    : IExporterFactory
{
    private readonly Dictionary<string, Type> _types =
        exporters.ToDictionary(e => e.Format, e => e.GetType(), StringComparer.OrdinalIgnoreCase);

    public IReadOnlyCollection<string> SupportedFormats => _types.Keys;

    public ITaskExporter Create(string format) =>
        _types.TryGetValue(format, out var type)
            ? (ITaskExporter)services.GetRequiredService(type)
            : throw new UnsupportedFormatException(format, SupportedFormats);
}
```

::: note Keyed services often replace the factory entirely
.NET 8 added keyed DI, which handles the common case with no factory class:

```csharp
builder.Services.AddKeyedSingleton<ITaskExporter, CsvTaskExporter>("csv");
builder.Services.AddKeyedSingleton<ITaskExporter, JsonTaskExporter>("json");

// injected directly
public sealed class ExportController([FromKeyedServices("csv")] ITaskExporter csv) { }

// or resolved at runtime
var exporter = serviceProvider.GetRequiredKeyedService<ITaskExporter>(format);
```

Reach for keyed services first. Write a factory when you need validation, a list of options, or construction logic the container cannot express.
:::

### The other factory shapes

```csharp
// Static factory method — construction with a meaningful name and validation
public static TaskItem CreateRecurring(string title, Guid projectId, string cron, TimeProvider clock) { }

// Named constructors on a record
public static Money Zero(string currency) => new(0, currency);

// Abstract factory — a family of related objects that must be consistent
public interface IStorageFactory
{
    ITaskRepository CreateTaskRepository();
    IProjectRepository CreateProjectRepository();
    IUnitOfWork CreateUnitOfWork();
}
```

The abstract factory is the one to be wary of. It is right when the products must come from the same family — all three must share a connection, for example — and it is pure ceremony otherwise.

## Strategy

```csharp
public interface IPriorityCalculator
{
    string Name { get; }
    Priority Calculate(TaskItem task, ProjectContext context);
}

public sealed class DueDateCalculator : IPriorityCalculator
{
    public string Name => "due-date";

    public Priority Calculate(TaskItem task, ProjectContext context) =>
        task.DueDate is not { } due ? Priority.Low
        : (due.DayNumber - context.Today.DayNumber) switch
        {
            < 0 => Priority.Urgent,
            <= 1 => Priority.High,
            <= 7 => Priority.Normal,
            _ => Priority.Low
        };
}

public sealed class BlockerCountCalculator : IPriorityCalculator { }
public sealed class ManualCalculator : IPriorityCalculator { }
```

Used:

```csharp
public sealed class TaskPrioritisationService(IEnumerable<IPriorityCalculator> calculators)
{
    public Priority Calculate(TaskItem task, Project project, DateOnly today)
    {
        var strategy = calculators.Single(c => c.Name == project.PrioritisationStrategy);
        return strategy.Calculate(task, new ProjectContext(project, today));
    }
}
```

The project chooses its strategy; the service does not care which.

::: design Strategy, or just a delegate?
For a single-method strategy, a delegate is often better:

```csharp
// interface version — three files
public interface IPriorityCalculator { Priority Calculate(TaskItem task, ProjectContext ctx); }

// delegate version — one line
public delegate Priority PriorityCalculator(TaskItem task, ProjectContext ctx);
```

```csharp
services.AddKeyedSingleton<PriorityCalculator>("due-date", (_, _) => DueDateStrategy.Calculate);
```

Use an **interface** when the strategy needs a name, configuration, dependencies, or more than one method. Use a **delegate** when it is a pure function with none of those.

In C#, "Strategy" is frequently just `Func<T, TResult>`. Recognising that saves you a lot of ceremony — and your Phase 2 `TaskFilters` class was already a strategy library.
:::

## The improved implementation, applied

```csharp
public sealed class ExportController(IExporterFactory factory)
{
    [HttpGet("export")]
    public async Task<IActionResult> Export([FromQuery] string format, [FromQuery] TaskQueryParameters query, CancellationToken ct)
    {
        if (!factory.SupportedFormats.Contains(format, StringComparer.OrdinalIgnoreCase))
            return Problem(statusCode: 400,
                title: "Unsupported format",
                detail: $"Supported formats: {string.Join(", ", factory.SupportedFormats)}.");

        var exporter = factory.Create(format);
        var tasks = await reader.SearchAsync(query.ToQuery(), ct);
        var stream = await exporter.ExportAsync(tasks.Items, ct);

        return File(stream, exporter.ContentType, $"tasks{exporter.FileExtension}");
    }
}
```

Adding a format changes nothing here. The error message updates itself.

::: exercise Level 1 — Guided · Both patterns in TaskFlow
1. Implement `IPriorityCalculator` with three strategies.
2. Store the chosen strategy on `Project`; apply it when a task is created.
3. Implement `IExporterFactory` (or keyed services) for your exporters.
4. Add an `/api/exporters` endpoint listing available formats with content types.
5. Write the delegate version of one strategy and compare the two.
6. Test each strategy in isolation.
:::

::: challenge Level 3 · A pluggable search ranking strategy
TaskFlow's search needs configurable relevance ranking: recency-weighted, priority-weighted, or text-match-weighted.

Requirements:
1. Strategies are selectable per request (`?rank=recency`).
2. Ranking happens **in SQL**, not in memory — so a strategy must produce an `IQueryable` transformation, not a comparison function.
3. Adding a strategy requires no change to the search service.
4. An invalid strategy name returns 400 listing the valid ones.
5. The default is configurable per project.
6. Each strategy is testable by asserting on the generated SQL.

Requirement 2 is what makes this interesting — a strategy returning `Func<TaskItem, int>` cannot be translated.
:::

::: solution
```csharp
public interface IRankingStrategy
{
    string Name { get; }
    IOrderedQueryable<TaskItem> Apply(IQueryable<TaskItem> query, RankingContext context);
}

public sealed class RecencyRanking : IRankingStrategy
{
    public string Name => "recency";

    public IOrderedQueryable<TaskItem> Apply(IQueryable<TaskItem> query, RankingContext context) =>
        query.OrderByDescending(t => t.CreatedAt).ThenBy(t => t.Id);
}

public sealed class RelevanceRanking : IRankingStrategy
{
    public string Name => "relevance";

    public IOrderedQueryable<TaskItem> Apply(IQueryable<TaskItem> query, RankingContext context)
    {
        var text = context.SearchText;
        if (string.IsNullOrWhiteSpace(text))
            return query.OrderByDescending(t => t.CreatedAt).ThenBy(t => t.Id);

        return query
            .OrderBy(t => EF.Functions.ILike(t.Title, $"%{text}%") ? 0
                        : EF.Functions.ILike(t.Description!, $"%{text}%") ? 1
                        : 2)
            .ThenByDescending(t => t.Priority)
            .ThenBy(t => t.Id);
    }
}
```

**The design insight behind requirement 2:** a strategy that returns `IComparer<TaskItem>` or `Func<TaskItem, int>` forces the caller to materialise everything before sorting. Making the strategy operate on `IQueryable<TaskItem>` keeps the whole pipeline translatable, so ranking becomes an `ORDER BY` on the server and paging still works.

That is a general lesson about applying patterns to a database-backed system: **the strategy must speak the language the pipeline understands.** A strategy over delegates is fine in memory and useless against SQL.

Testing by asserting on the SQL:
```csharp
[Fact]
public void Relevance_ranking_orders_title_matches_first()
{
    var sql = new RelevanceRanking()
        .Apply(db.Tasks, new RankingContext("bug"))
        .ToQueryString();

    sql.ShouldContain("ORDER BY");
    sql.ShouldContain("ILIKE");
    sql.ShouldNotContain("SELECT *");
}
```

Returning `IOrderedQueryable<T>` rather than `IQueryable<T>` is deliberate: it makes it a compile error for a strategy to forget to order, and it lets the caller add a `ThenBy` safely.
:::

::: project Factory and Strategy in TaskFlow
1. Keyed services or a factory for exporters, with a `/api/exporters` listing.
2. `IPriorityCalculator` strategies, selectable per project.
3. `IRankingStrategy` applied in SQL, selectable per request.
4. All strategies unit-tested in isolation.
5. Invalid names return a 400 listing the valid options.
6. `DECISIONS.md`: where you used a delegate instead of an interface, and why.

Commit.
:::

::: interview When would you use the Strategy pattern?
When a behaviour has several interchangeable implementations and the choice is made at runtime — different pricing rules per customer, different ranking algorithms per request, different export formats. Each algorithm becomes a class behind a common interface, so adding one is a new class rather than an edit to a growing switch.

In C# the lightweight version is often just a delegate: `Func<TaskItem, Priority>` is a strategy, and for a single-method algorithm with no dependencies that is less ceremony than an interface. I would use an interface when the strategy needs a name, configuration or injected dependencies.

One detail specific to database-backed systems: the strategy has to speak the same language as the pipeline. A ranking strategy returning `IComparer<T>` forces everything into memory; one that transforms an `IQueryable` becomes an `ORDER BY` on the server.
:::

::: checkpoint
- [ ] I can state the difference between Factory and Strategy in one sentence each
- [ ] I used keyed services before reaching for a factory class
- [ ] I wrote a strategy as both an interface and a delegate
- [ ] My ranking strategies produce SQL, not in-memory sorts
- [ ] Adding a strategy requires no change to the consuming service
:::

## Common mistakes

::: mistake
**A factory class where the DI container would do.** `ITaskServiceFactory` wrapping `GetRequiredService`.

**A strategy interface for a one-line pure function.** A delegate is fine.

**Strategies that cannot be translated.** In-memory sorting of a paged database query.

**An abstract factory with one product.** That is a factory method.

**A factory that returns `object`.** You have lost the type safety the pattern exists to preserve.
:::
