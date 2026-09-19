---
title: Open/Closed
summary: The switch statement that grows forever, and the two ways to stop it.
minutes: 35
---

## What are we learning?

"Open for extension, closed for modification" — what it means in practice, and when violating it is the right call.

## The bad implementation

TaskFlow needs to export tasks. First CSV, then JSON, then Excel, then PDF.

```csharp
public sealed class TaskExporter
{
    public async Task<byte[]> ExportAsync(IReadOnlyList<TaskItem> tasks, string format)
    {
        switch (format.ToLowerInvariant())
        {
            case "csv":
            {
                var sb = new StringBuilder("Id,Title,Status,Priority,DueDate\n");
                foreach (var t in tasks)
                    sb.AppendLine($"{t.Id},{Escape(t.Title)},{t.Status},{t.Priority},{t.DueDate}");
                return Encoding.UTF8.GetBytes(sb.ToString());
            }
            case "json":
                return JsonSerializer.SerializeToUtf8Bytes(tasks.Select(TaskSummary.From));

            case "xlsx":
            {
                using var workbook = new XLWorkbook();
                // 40 lines of Excel code
                return ...;
            }
            case "pdf":
                // 60 lines of PDF code
                return ...;

            default:
                throw new NotSupportedException($"Unknown format: {format}");
        }
    }
}
```

## Why it becomes a problem

::: why What the growth actually costs
1. **Every new format modifies working code.** Adding PDF means editing the class that CSV export depends on. A mistake breaks exports that were fine.
2. **The class accumulates every dependency.** ClosedXML for Excel, QuestPDF for PDF, a CSV library — all referenced by everything that references the exporter, including projects that only ever export JSON.
3. **It cannot be tested in isolation.** Testing CSV output instantiates a class that needs the PDF library present.
4. **Merge conflicts.** Two people adding two formats edit the same switch.
5. **It gets long.** Four formats at 40 lines each is a 160-line method.
6. **Adding a format is not a self-contained change.** You cannot ship "PDF export" as an isolated, reviewable unit.

The tell is this: **you are modifying a class to add behaviour, rather than adding a class.**
:::

## The refactor

```csharp
public interface ITaskExporter
{
    string Format { get; }                  // "csv"
    string ContentType { get; }             // "text/csv"
    string FileExtension { get; }           // ".csv"
    Task<Stream> ExportAsync(IReadOnlyList<TaskItem> tasks, CancellationToken ct);
}

public sealed class CsvTaskExporter : ITaskExporter
{
    public string Format => "csv";
    public string ContentType => "text/csv";
    public string FileExtension => ".csv";

    public async Task<Stream> ExportAsync(IReadOnlyList<TaskItem> tasks, CancellationToken ct)
    {
        var stream = new MemoryStream();
        await using var writer = new StreamWriter(stream, leaveOpen: true);
        await writer.WriteLineAsync("Id,Title,Status,Priority,DueDate");
        foreach (var t in tasks)
            await writer.WriteLineAsync($"{t.Id},{Escape(t.Title)},{t.Status},{t.Priority},{t.DueDate:yyyy-MM-dd}");
        await writer.FlushAsync(ct);
        stream.Position = 0;
        return stream;
    }
}
```

Selection without a switch:

```csharp
public sealed class ExportService(IEnumerable<ITaskExporter> exporters)
{
    private readonly Dictionary<string, ITaskExporter> _byFormat =
        exporters.ToDictionary(e => e.Format, StringComparer.OrdinalIgnoreCase);

    public IReadOnlyCollection<string> SupportedFormats => _byFormat.Keys;

    public ITaskExporter Get(string format) =>
        _byFormat.GetValueOrDefault(format)
        ?? throw new UnsupportedFormatException(format, SupportedFormats);
}
```

```csharp
services.AddSingleton<ITaskExporter, CsvTaskExporter>();
services.AddSingleton<ITaskExporter, JsonTaskExporter>();
services.AddSingleton<ITaskExporter, ExcelTaskExporter>();   // ← the entire PDF/Excel change
```

## The improved implementation

Adding PDF export is now: one new class, one registration line. No existing file is touched. The PDF library is referenced only by the project holding the PDF exporter. `SupportedFormats` updates itself, so the error message and the OpenAPI enum stay correct for free.

::: warn OCP is not "never use a switch"
A switch over a **closed, stable set** is fine and better than the alternative:

```csharp
// This is GOOD. The set of statuses is fixed by the domain,
// and the compiler will tell you if you add one and miss an arm.
string Describe(TaskStatus status) => status switch
{
    TaskStatus.Todo => "Not started",
    TaskStatus.InProgress => "In progress",
    // ...
};
```

The difference:

| Switch over | Verdict |
|---|---|
| A closed enum that rarely changes | Fine. Exhaustiveness checking is a feature |
| A set you expect to keep extending | Refactor to polymorphism |
| A type check (`if (x is Foo) … else if (x is Bar)`) | Almost always a missing abstraction |
| A string from configuration or a request | Refactor — the set is open by definition |

The question is not "is there a switch?" but **"will this switch keep growing, and does every growth risk existing behaviour?"**

Note also the cost: the polymorphic version has four small files and a registration where the switch had one method. For two formats that will never become three, the switch is genuinely simpler. **Refactor at the third case**, which is the point at which the pattern is established rather than imagined.
:::

::: exercise Level 1 — Guided · Refactor an export
1. Write the switch version with CSV and JSON.
2. Add Excel to it. Notice what you had to modify.
3. Refactor to `ITaskExporter`.
4. Add PDF to the refactored version. Count the files you touched.
5. Write a test for CSV output that does not reference the Excel or PDF types.
6. Add an endpoint `GET /api/tasks/export?format=csv` that lists supported formats in its 400 message, sourced from the registrations.
:::

::: challenge Level 3 · A pluggable notification and rules engine
TaskFlow needs configurable automation: "when a task becomes overdue, notify the assignee"; "when a task is labelled `security`, assign it to the security team"; "when a project reaches 100 tasks, notify the owner".

Requirements:
1. Adding a rule requires **no** change to existing code.
2. Rules are configurable per project, from the database.
3. A rule can be enabled or disabled at runtime.
4. Rules run in a deterministic order.
5. A failing rule does not stop the others, and is logged with context.
6. Rules are unit-testable in isolation.
7. The API can list available rules with their descriptions and parameters.
8. Adding a rule that needs a new parameter type does not change the rule engine.

Point 8 is the hard one. Think about how parameters are declared and bound.
:::

::: solution
```csharp
public interface IAutomationRule
{
    string Key { get; }                              // "notify-on-overdue"
    string Description { get; }
    Type ParameterType { get; }                      // for point 8
    int Order { get; }
    Task<RuleResult> EvaluateAsync(RuleContext context, object parameters, CancellationToken ct);
}

public abstract class AutomationRule<TParameters> : IAutomationRule where TParameters : class, new()
{
    public abstract string Key { get; }
    public abstract string Description { get; }
    public virtual int Order => 100;
    public Type ParameterType => typeof(TParameters);

    public Task<RuleResult> EvaluateAsync(RuleContext context, object parameters, CancellationToken ct) =>
        EvaluateAsync(context, (TParameters)parameters, ct);

    protected abstract Task<RuleResult> EvaluateAsync(RuleContext context, TParameters parameters, CancellationToken ct);
}

public sealed class NotifyOnOverdueRule(INotificationService notifications)
    : AutomationRule<NotifyOnOverdueRule.Parameters>
{
    public sealed class Parameters
    {
        public int DaysOverdue { get; init; } = 1;
        public bool IncludeProjectOwner { get; init; }
    }

    public override string Key => "notify-on-overdue";
    public override string Description => "Notify the assignee when a task is overdue.";

    protected override async Task<RuleResult> EvaluateAsync(
        RuleContext context, Parameters parameters, CancellationToken ct)
    {
        if (!context.Task.IsOverdueBy(parameters.DaysOverdue, context.Today))
            return RuleResult.NotApplicable;

        await notifications.OverdueAsync(context.Task, ct);
        return RuleResult.Applied($"Notified assignee about {context.Task.Title}.");
    }
}
```

The generic base class is what solves point 8. Each rule declares its own parameter type; the engine only knows `object` and `Type`. Binding from stored JSON:

```csharp
var parameters = JsonSerializer.Deserialize(configuration.ParametersJson, rule.ParameterType)
                 ?? Activator.CreateInstance(rule.ParameterType)!;
```

And the API can describe every rule's parameters without knowing any of them, by reflecting over `ParameterType` — which is Phase 2's attributes-and-reflection lesson doing real work.

The engine never changes:

```csharp
public sealed class AutomationEngine(IEnumerable<IAutomationRule> rules, ILogger<AutomationEngine> logger)
{
    public async Task<IReadOnlyList<RuleResult>> RunAsync(RuleContext context, CancellationToken ct)
    {
        var enabled = context.Project.EnabledRules;
        var results = new List<RuleResult>();

        foreach (var rule in rules.Where(r => enabled.ContainsKey(r.Key)).OrderBy(r => r.Order).ThenBy(r => r.Key))
        {
            try
            {
                results.Add(await rule.EvaluateAsync(context, Bind(rule, enabled[rule.Key]), ct));
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogError(ex, "Automation rule {Rule} failed for task {TaskId}", rule.Key, context.Task.Id);
                results.Add(RuleResult.Failed(rule.Key, ex.Message));
            }
        }
        return results;
    }
}
```

`.OrderBy(r => r.Order).ThenBy(r => r.Key)` satisfies point 4 deterministically — without the `ThenBy`, two rules with the same order run in DI registration order, which is stable until someone reorders registrations.

**The honest caveat:** this is a small rules engine, and rules engines are notorious for growing into unmaintainable configuration languages. It is the right shape when rules are genuinely user-configurable. If they are not — if only developers add rules — a list of `IEventHandler<T>` classes is simpler and achieves the same extensibility.
:::

::: project OCP in TaskFlow
1. `ITaskExporter` with CSV, JSON and one more format.
2. An export endpoint listing supported formats from the registrations.
3. `IAutomationRule` with at least three rules.
4. Rule configuration per project.
5. Each rule unit-tested alone.
6. A test proving that adding a rule requires no change to the engine.
7. `DECISIONS.md`: one place you deliberately kept a switch, and why.

Commit.
:::

::: interview What is the Open/Closed Principle?
Software should be open for extension but closed for modification — you add behaviour by adding code, not by editing code that already works.

The usual violation is a switch or if-chain that grows a case per new variant: every addition edits a class other features depend on, accumulates every variant's dependencies in one place, and cannot be shipped as an isolated change. The refactor is to define an interface per variant and let the container supply them all, so adding a case becomes a new class and a registration.

The caveat I would add is that this does not mean avoiding switch statements. A switch over a closed enum is good — the compiler checks exhaustiveness. The question is whether the set is expected to keep growing. And I would refactor at the third case, not the first, because two variants that never become three are simpler as a switch.
:::

::: checkpoint
- [ ] I felt the difference between adding a format to each version
- [ ] I can state when a switch is fine and when it is a smell
- [ ] Adding an exporter touches no existing file
- [ ] I kept one switch deliberately and wrote down why
- [ ] My rules are testable in isolation
:::

## Common mistakes

::: mistake
**Abstracting at the first variant.** You are guessing at the axis of change and will guess wrong.

**"Never use switch."** Exhaustiveness checking over a closed enum is a feature.

**Extension points nobody uses.** An interface with one implementation and no second on the horizon is indirection with no payoff.

**A rules engine that becomes a programming language.** At some point configuration is harder to debug than code.

**Non-deterministic ordering.** Registration order is not a specification.
:::
