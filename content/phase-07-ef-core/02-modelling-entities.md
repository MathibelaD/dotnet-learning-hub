---
title: Modelling entities
summary: Mapping C# types to tables with conventions, Fluent API and value objects.
minutes: 40
stage: Stage 4
---

## What are we learning?

How EF Core decides what your schema looks like, and how to take control without polluting your domain classes with attributes.

## Conventions first

Given:

```csharp
public sealed class TaskItem
{
    public Guid Id { get; private set; }
    public string Title { get; private set; } = "";
    public string? Description { get; private set; }
    public TaskStatus Status { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; }
}
```

EF Core infers: a table named `Tasks` (from the `DbSet` name), `Id` as the primary key (by name), `Title` as `text NOT NULL`, `Description` as `text NULL` (from nullable reference types — the Phase 1 feature earning its keep again), `Status` as `integer`, `CreatedAt` as `timestamptz`.

Conventions cover perhaps 80% of a model. The rest needs configuration.

## Fluent API in a configuration class

::: design Configuration classes, not attributes
You *can* write `[Table("tasks")]`, `[MaxLength(200)]`, `[Column("created_at")]` on your entities. Do not.

Attributes put persistence concerns into your domain project, which then needs a reference to EF Core — breaking the rule you enforced in the build. The Fluent API in `IEntityTypeConfiguration<T>` classes lives in Infrastructure, where it belongs, and is strictly more capable than attributes.
:::

```csharp
namespace TaskFlow.Infrastructure.Configurations;

public sealed class TaskItemConfiguration : IEntityTypeConfiguration<TaskItem>
{
    public void Configure(EntityTypeBuilder<TaskItem> builder)
    {
        builder.ToTable("tasks");

        builder.HasKey(t => t.Id);

        builder.Property(t => t.Title)
            .HasMaxLength(200)
            .IsRequired();

        builder.Property(t => t.Description)
            .HasMaxLength(2000);

        builder.Property(t => t.Status)
            .HasConversion<string>()          // store the NAME, not the number
            .HasMaxLength(20);

        builder.Property(t => t.Priority)
            .HasConversion<string>()
            .HasMaxLength(10);

        builder.Property(t => t.CreatedAt)
            .HasDefaultValueSql("now()");

        builder.HasIndex(t => t.ProjectId);
        builder.HasIndex(t => new { t.Status, t.DueDate });
        builder.HasIndex(t => t.Title).HasMethod("gin").IsTsVectorExpressionIndex("english");
    }
}
```

Picked up automatically by `ApplyConfigurationsFromAssembly` in `OnModelCreating`.

::: warn Enums: integer or string?
`.HasConversion<string>()` stores `'Completed'` instead of `3`.

| | Integer | String |
|---|---|---|
| Storage | 4 bytes | ~10 bytes |
| Readable in `psql` | No | Yes |
| Survives reordering the enum | **No** | Yes |
| Survives renaming a member | Yes | **No** |
| Sorts by enum order | Yes | Alphabetically |

For anything a human will ever query directly, **store the string**. Debugging a production issue with `SELECT status, count(*) FROM tasks GROUP BY 1` returning `3 | 412` is miserable.

Whichever you choose, the choice is permanent without a data migration. Decide deliberately.
:::

## Private fields and encapsulation

Your domain (correctly) has a private `List<string> _labels` behind `IReadOnlyList<string> Labels`. EF Core can map that:

```csharp
builder.Metadata
    .FindNavigation(nameof(TaskItem.Comments))!
    .SetPropertyAccessMode(PropertyAccessMode.Field);

// or globally
builder.UsePropertyAccessMode(PropertyAccessMode.Field);
```

EF Core will find `_comments` by convention from the property name. This is the feature that lets you keep proper encapsulation and still use an ORM — a lot of codebases give up and make everything `public List<T> { get; set; }`, which is unnecessary.

Similarly, EF Core does **not** need a public parameterless constructor. It can use a constructor whose parameters match property names, or set properties directly via their backing fields. Your `TaskItem(string title, Guid projectId)` constructor works as-is.

## Value objects

```csharp
// owned type — stored as columns in the SAME table
builder.OwnsOne(t => t.DateRange, range =>
{
    range.Property(r => r.Start).HasColumnName("starts_on");
    range.Property(r => r.End).HasColumnName("ends_on");
});

// value converter — one property, custom storage
builder.Property(t => t.Labels)
    .HasConversion(
        labels => string.Join(',', labels),
        value => value.Split(',', StringSplitOptions.RemoveEmptyEntries).ToList(),
        new ValueComparer<IReadOnlyList<string>>(
            (a, b) => a!.SequenceEqual(b!),
            v => v.Aggregate(0, (h, s) => HashCode.Combine(h, s.GetHashCode())),
            v => v.ToList()));
```

::: warn A value converter without a ValueComparer breaks change tracking
EF Core detects changes by comparing a snapshot against the current value. For a converted collection it does not know how to compare or how to snapshot, so it uses reference equality — and `labels.Add("x")` mutates the same object, so the snapshot and the current value are identical. **The change is silently never saved.**

The three functions in `ValueComparer` are: how to compare, how to hash, and how to take a snapshot (which must be a *deep copy*, hence `v.ToList()`).

This is a genuinely nasty bug: no error, no warning, data just does not persist. If a change is not being saved and everything looks right, a missing `ValueComparer` is a prime suspect.

For PostgreSQL specifically there is a better answer for labels — Npgsql maps `List<string>` to a native `text[]` column with no converter at all, and it is queryable and indexable. Use that.
:::

## Computed and ignored members

```csharp
builder.Ignore(t => t.IsOverdue);          // computed in C#, not stored, not queryable

builder.Property(t => t.IsComplete)        // computed IN THE DATABASE, and queryable
    .HasComputedColumnSql("\"Status\" = 'Completed'", stored: true);
```

The distinction matters enormously: an `Ignore`d property cannot appear in a `Where` clause (EF Core throws "could not be translated"), while a computed column can and can even be indexed.

## Global query filters

```csharp
builder.HasQueryFilter(t => !t.IsDeleted);      // soft delete, applied to EVERY query
```

Every query against `Tasks` now gets `WHERE NOT "IsDeleted"` automatically. Escape it with `.IgnoreQueryFilters()` when you genuinely need the deleted rows.

Powerful and dangerous in equal measure: a filter you forgot about is invisible in the LINQ and present in the SQL, which produces "why is this row missing" investigations. Document them prominently.

::: exercise Level 1 — Guided · Configure the model
Write `IEntityTypeConfiguration<T>` for `TaskItem`, `Project`, `User` and `Comment`:

1. snake_case table and column names.
2. Enums stored as strings, with length limits.
3. String length limits matching your `TaskRules`.
4. Indexes on `ProjectId`, `AssigneeId`, `(Status, DueDate)`, and `Users.Email` (unique).
5. `Labels` as a PostgreSQL `text[]`.
6. Private collection fields mapped via field access.
7. `CreatedAt` defaulting to `now()`.
8. A global query filter for soft delete on `TaskItem`.

Then generate a migration (lesson 4 covers this properly — just run it) and **read the generated SQL**:
```bash
dotnet ef migrations add Initial -p src/TaskFlow.Infrastructure -s src/TaskFlow.Api
dotnet ef migrations script -p src/TaskFlow.Infrastructure -s src/TaskFlow.Api
```
Check every column type, every constraint and every index against what you intended.
:::

::: challenge Level 3 · Strongly-typed ids
Replace `Guid Id` with `TaskId`, a `readonly record struct` wrapping a `Guid`, so that `AssignTo(projectId)` where a `taskId` is expected becomes a **compile error**.

Requirements:
1. `TaskId`, `ProjectId`, `UserId`, `CommentId` as distinct types.
2. EF Core stores them as plain `uuid` columns — no schema change.
3. They work as route parameters (`/api/tasks/{id}`) and in JSON, appearing as plain strings.
4. They work as dictionary keys and in LINQ `Where` clauses that translate to SQL.
5. No repetitive per-type configuration — one convention covering all of them.

Then decide honestly whether the cost is worth it for TaskFlow, and record the decision.
:::

::: solution
```csharp
public readonly record struct TaskId(Guid Value)
{
    public static TaskId New() => new(Guid.CreateVersion7());
    public override string ToString() => Value.ToString();
    public static bool TryParse(string? s, out TaskId id)
    {
        if (Guid.TryParse(s, out var g)) { id = new TaskId(g); return true; }
        id = default; return false;
    }
}
```

`TryParse` is what makes route binding work in minimal APIs and MVC — the framework looks for it by convention.

The value converter:

```csharp
public sealed class TaskIdConverter() : ValueConverter<TaskId, Guid>(
    id => id.Value,
    value => new TaskId(value));
```

Applied once, as a convention, rather than per property:

```csharp
protected override void ConfigureConventions(ModelConfigurationBuilder builder)
{
    builder.Properties<TaskId>().HaveConversion<TaskIdConverter>();
    builder.Properties<ProjectId>().HaveConversion<ProjectIdConverter>();
    // ...
}
```

And for JSON:
```csharp
public sealed class TaskIdJsonConverter : JsonConverter<TaskId>
{
    public override TaskId Read(ref Utf8JsonReader r, Type t, JsonSerializerOptions o) =>
        new(Guid.Parse(r.GetString()!));
    public override void Write(Utf8JsonWriter w, TaskId v, JsonSerializerOptions o) =>
        w.WriteStringValue(v.Value);
}
```

**Is it worth it?** The honest assessment:

**For:** it eliminates an entire bug class. `GetTask(projectId)` compiles today and returns null at runtime; with typed ids it does not compile. In a codebase with a dozen entity types and many methods taking two or three ids, that is a real, recurring bug that disappears.

**Against:** four converter types, four JSON converters, a convention registration, and friction every time you interoperate with something expecting a `Guid`. For a small service with three entities, the ceremony probably exceeds the benefit.

**Verdict for TaskFlow:** worth doing, because you will have five or six entity types by Phase 9 and several methods taking both a task id and a user id — which is exactly the shape where the bug happens. But if you decide against it, that is a defensible call as long as you can articulate the trade-off. That articulation is the actual skill being tested here.

A note on `Guid.CreateVersion7()` (.NET 9+): version 7 GUIDs are time-ordered, so they cluster in the database index instead of scattering random writes across it. For a primary key, this is a meaningful performance difference at scale, and it costs one method call.
:::

::: project Model TaskFlow properly
1. Configuration classes for every entity, in `Infrastructure/Configurations/`.
2. snake_case naming throughout.
3. Enums as strings.
4. Indexes as listed.
5. `Labels` as `text[]`.
6. Field access for private collections — confirm your encapsulation survived.
7. Soft delete via a global query filter, documented in `DECISIONS.md`.
8. Generate the migration and read every line of the SQL.
9. Confirm `TaskFlow.Domain` still references nothing.

Commit.
:::

::: interview How do you map a domain model to a database with EF Core?
Mostly by convention — a `DbSet<T>` name becomes the table, a property called `Id` becomes the key, nullable reference types determine nullability. Where conventions are not enough, I use the Fluent API in `IEntityTypeConfiguration<T>` classes rather than data annotations, because that keeps persistence concerns in the infrastructure project instead of putting an EF Core dependency on the domain.

Fluent configuration is also strictly more capable: value converters, owned types for value objects, field access so private collections stay encapsulated, computed columns, and global query filters for things like soft delete.

The detail I would flag is value converters on collections — they need an explicit `ValueComparer`, or change tracking falls back to reference equality and mutations are silently never saved.
:::

::: checkpoint
- [ ] Every entity has a configuration class; no data annotations on domain types
- [ ] `TaskFlow.Domain` still has zero references
- [ ] I read the generated SQL line by line and it matches my intent
- [ ] My private collection fields are still private
- [ ] I can explain the enum-as-string trade-off in both directions
:::

## Common mistakes

::: mistake
**Data annotations on domain entities.** Couples the domain to EF Core.

**Value converter on a collection without a `ValueComparer`.** Changes silently do not save.

**`public List<T> Items { get; set; }` to make EF Core happy.** It is not necessary; field access works.

**Forgetting indexes.** Everything is fast with 100 rows and unusable with 100,000.

**A global query filter nobody documented.** Rows vanish and the LINQ looks correct.
:::
