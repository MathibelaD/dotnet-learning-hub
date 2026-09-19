---
title: "Checkpoint: the TaskFlow domain model"
summary: No new concepts. Build the complete domain model for the application with everything from Phase 1.
minutes: 90
stage: Stage 1
---

## What are we learning?

Nothing new. This lesson is a **build**. Everything you need is in the previous twelve lessons, and the point is to find out whether you can actually use it without being told which tool to reach for.

Budget an hour and a half. Do not read ahead to the solution.

::: stop This is the real checkpoint for Phase 1
If you cannot do this, the next phase will not stick. Go back to whichever lesson covers the part you are stuck on — that is not failure, that is the checkpoint doing its job.
:::

## The requirements

Build the complete domain layer for TaskFlow. Nothing persists yet, nothing is async, there is no web. Pure C#.

### Types

**`User`** — has an `Id` (Guid), `Email`, `DisplayName`, and a `Role`. Two users with the same email are the same user for equality purposes, but a user is an entity with identity.

**`Project`** — `Id`, `Name`, `Description` (optional), `OwnerId`, `CreatedAt`, and a collection of tasks that cannot be mutated from outside.

**`TaskItem`** — `Id`, `Title`, `Description` (optional), `Status`, `Priority`, `ProjectId`, `AssigneeId` (optional), `CreatedAt`, `CompletedAt` (optional), `DueDate` (optional `DateOnly`), a collection of labels, and a collection of comments.

**`Comment`** — `Id`, `TaskId`, `AuthorId`, `Body`, `CreatedAt`. Immutable after creation.

**`Label`** — a normalised name and a colour. Two labels with the same name are the same label.

**`TaskStatus`** — `Todo`, `InProgress`, `Blocked`, `Completed`, `Cancelled`, with explicit numeric values.

**`Priority`** — `Low`, `Normal`, `High`, `Urgent`, with explicit numeric values.

**`Role`** — `Member`, `Manager`, `Admin`.

### Rules that must be enforced by the code, not by comments

1. A task title is required, trimmed, and at most 200 characters.
2. A description, if present, is at most 2000 characters.
3. A task may have at most 10 labels; labels are case-insensitively unique per task; `archived` and `deleted` are reserved.
4. Status transitions:
   - `Todo` → `InProgress`, `Cancelled`
   - `InProgress` → `Blocked`, `Completed`, `Cancelled`
   - `Blocked` → `InProgress`, `Cancelled`
   - `Completed` → *(nothing — terminal)*
   - `Cancelled` → *(nothing — terminal)*
   Any other transition throws a domain exception naming both states.
5. `CompletedAt` is set only when the status becomes `Completed`, and is cleared if that ever becomes possible.
6. A comment body is required and at most 5000 characters.
7. A task cannot be assigned to a user who is not a member of the project's team. (Model the team however you like — this rule is here to force a decision about where the rule lives.)
8. A project cannot hold more than 500 tasks.

### Behaviour

- `TaskItem`: `Start()`, `Block(string reason)`, `Complete()`, `Cancel(string? reason)`, `AssignTo(User user, Project project)`, `AddLabel`, `RemoveLabel`, `AddComment`, `bool IsOverdue(DateOnly today)`.
- `Project`: `AddTask`, `RemoveTask`, `IReadOnlyList<TaskItem> Tasks`.
- A generic `InMemoryStore<TEntity, TKey>` used for users, projects and tasks.

### Non-functional requirements

- `<Nullable>enable</Nullable>` and `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>`, and **no `!` operators**.
- Every collection exposed read-only.
- No public setter that could put an object into an invalid state.
- Value equality where it is semantically right; reference equality where it is not.
- One domain exception hierarchy.
- A `Program.cs` that demonstrates every rule — including deliberately triggering each failure and printing what happened.

## Design decisions you must make and be able to justify

::: design Write your answers down before you code
1. `class` or `record` for each of the eight types? Which ones are entities and which are values?
2. Where does rule 7 (assignment requires team membership) live — on `TaskItem`, on `Project`, or somewhere else? What does each choice cost?
3. Does `TaskItem` hold `Project`, or `ProjectId`? What breaks with each?
4. Is the status transition table a `switch` expression, a dictionary, or a set of methods?
5. Do labels belong to a task as strings or as `Label` objects? What is the actual difference in consequences?

Keep your answers in a file called `DECISIONS.md` in the repository. You will reread it in Phase 8 when you restructure, and again in Phase 16 when you have to explain the codebase.
:::

::: project Build it
```bash
cd ~/taskflow
# your existing src/TaskFlow.Console
```

Work in `src/TaskFlow.Console/Domain/`. Commit as you go — one commit per type is reasonable.

When it builds clean with warnings-as-errors and `Program.cs` demonstrates every rule, commit:

```bash
git commit -am "Phase 1 checkpoint: complete TaskFlow domain model"
```
:::

::: checkpoint Before you open the solution
- [ ] It compiles with zero warnings and no `!`
- [ ] Every one of the eight rules is enforced in code
- [ ] `Program.cs` demonstrates each rule succeeding and each rule failing
- [ ] `DECISIONS.md` exists and answers all five design questions
- [ ] I can explain each class-vs-record choice out loud
:::

::: solution One reasonable implementation
There is no single right answer. Here are the decisions I would defend, and the code that follows from them.

**Entities vs values.** `User`, `Project`, `TaskItem` are entities — they have identity and a lifecycle, and two distinct tasks with the same title are different tasks. They are `class`. `Comment` is arguably either; I made it a `record` because it is immutable and its content *is* its identity for our purposes. `Label` is a value — `record`. `TaskStatus`, `Priority`, `Role` are enums.

**Rule 7 lives in a domain service, not on `TaskItem`.** A task cannot see the project's membership list without holding a reference to `Project`, and giving every task a back-reference to its project makes the object graph circular and makes it impossible to load a task without loading a project. Passing what the rule needs into the method keeps the dependency explicit.

**`ProjectId`, not `Project`.** Holding the ID keeps the aggregate boundary clear and makes the model trivially serialisable. EF Core in Phase 7 will add a navigation property alongside it; the ID stays as the source of truth.

```csharp
namespace TaskFlow.Domain;

public sealed class TaskItem : IEntity<Guid>
{
    private readonly List<string> _labels = [];
    private readonly List<Comment> _comments = [];

    public TaskItem(string title, Guid projectId, Priority priority = Priority.Normal)
    {
        Title = Normalise(title);
        ProjectId = projectId;
        Priority = priority;
    }

    public Guid Id { get; } = Guid.NewGuid();
    public string Title { get; private set; }
    public string? Description { get; private set; }
    public TaskStatus Status { get; private set; } = TaskStatus.Todo;
    public Priority Priority { get; private set; }
    public Guid ProjectId { get; }
    public Guid? AssigneeId { get; private set; }
    public DateOnly? DueDate { get; private set; }
    public DateTime CreatedAt { get; } = DateTime.UtcNow;
    public DateTime? CompletedAt { get; private set; }

    public IReadOnlyList<string> Labels => _labels;
    public IReadOnlyList<Comment> Comments => _comments;

    public bool IsComplete => Status is TaskStatus.Completed;
    public bool IsOpen => Status is TaskStatus.Todo or TaskStatus.InProgress or TaskStatus.Blocked;
    public bool IsOverdue(DateOnly today) => IsOpen && DueDate is { } due && due < today;

    public void Start()  => TransitionTo(TaskStatus.InProgress);
    public void Cancel(string? reason = null) => TransitionTo(TaskStatus.Cancelled);

    public void Block(string reason)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(reason);
        TransitionTo(TaskStatus.Blocked);
        Description = string.IsNullOrEmpty(Description)
            ? $"Blocked: {reason}"
            : $"{Description}\nBlocked: {reason}";
    }

    public void Complete()
    {
        TransitionTo(TaskStatus.Completed);
        CompletedAt = DateTime.UtcNow;
    }

    private void TransitionTo(TaskStatus next)
    {
        var allowed = Status switch
        {
            TaskStatus.Todo       => next is TaskStatus.InProgress or TaskStatus.Cancelled,
            TaskStatus.InProgress => next is TaskStatus.Blocked or TaskStatus.Completed or TaskStatus.Cancelled,
            TaskStatus.Blocked    => next is TaskStatus.InProgress or TaskStatus.Cancelled,
            TaskStatus.Completed  => false,
            TaskStatus.Cancelled  => false,
            _ => throw new ArgumentOutOfRangeException(nameof(Status), Status, "Unknown status")
        };

        if (!allowed)
            throw new TaskStateException(this, $"move from {Status} to {next}");

        Status = next;
    }

    public void AddLabel(string label)
    {
        var normalised = Normalise(label, TaskRules.MaxLabelLength);

        if (TaskRules.ReservedLabels.Contains(normalised))
            throw new TaskValidationException($"'{normalised}' is a reserved label.");
        if (_labels.Contains(normalised, StringComparer.OrdinalIgnoreCase))
            return;
        if (_labels.Count >= TaskRules.MaxLabelsPerTask)
            throw new TaskValidationException($"A task may have at most {TaskRules.MaxLabelsPerTask} labels.");

        _labels.Add(normalised);
    }

    public bool RemoveLabel(string label) =>
        _labels.RemoveAll(l => string.Equals(l, label?.Trim(), StringComparison.OrdinalIgnoreCase)) > 0;

    public void AddComment(Comment comment)
    {
        ArgumentNullException.ThrowIfNull(comment);
        if (comment.TaskId != Id)
            throw new TaskValidationException("Comment belongs to a different task.");
        _comments.Add(comment);
    }

    internal void AssignTo(Guid userId) => AssigneeId = userId;

    private static string Normalise(string value, int max = TaskRules.MaxTitleLength,
        [System.Runtime.CompilerServices.CallerArgumentExpression(nameof(value))] string? name = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value, name);
        var trimmed = value.Trim();
        return trimmed.Length <= max
            ? trimmed
            : throw new TaskValidationException($"{name} exceeds {max} characters.");
    }

    public override string ToString() =>
        $"[{(IsComplete ? "x" : " ")}] {Priority,-6} {Title}" +
        (DueDate is { } d ? $"  (due {d:yyyy-MM-dd})" : "");
}
```

The assignment rule as a domain service:

```csharp
public sealed class TaskAssignmentService
{
    public void Assign(TaskItem task, User user, Project project)
    {
        if (task.ProjectId != project.Id)
            throw new TaskValidationException("Task does not belong to that project.");
        if (!project.IsMember(user.Id))
            throw new TaskValidationException($"{user.DisplayName} is not a member of {project.Name}.");
        if (!task.IsOpen)
            throw new TaskStateException(task, "assign");

        task.AssignTo(user.Id);
    }
}
```

`AssignTo` is `internal` — only code in the domain assembly can call it directly, so the rule cannot be bypassed from outside while still keeping `TaskItem` free of a `Project` reference. That is the access-modifier lesson paying off.

Two details worth stealing:

- `[CallerArgumentExpression]` makes `Normalise(title)` produce an error message that says `title exceeds 200 characters` with no hard-coded string. The compiler fills in the caller's expression text.
- `TransitionTo` puts the whole state machine in one place. When Phase 7 adds a database and Phase 6 adds an API, neither can produce an illegal transition, because neither can set `Status` directly.

Compare this against what you wrote. Where you differ, decide which is better and why — that judgement is the actual skill.
:::

::: interview Walk me through your domain model
This is a real interview question and you can now answer it. Practise saying this out loud, about your own code:

> "TaskFlow has three entities — User, Project and TaskItem — and a few value types. Entities are classes because they have identity and a lifecycle; the value types are records so that equality compares contents. TaskItem owns its own state machine: status is private-set and only changes through Start, Block, Complete and Cancel, which go through one transition table. That means no caller — not the API layer, not EF Core — can put a task into an illegal state. Collections are exposed as IReadOnlyList with intention-revealing methods for mutation. The one rule that needs data from two aggregates, assignment requiring project membership, lives in a domain service rather than on the entity, so TaskItem never has to hold a reference to Project."

If you can say that about code you wrote, you are already ahead of a lot of candidates.
:::

::: checkpoint Phase 1 complete
- [ ] The domain model builds clean and every rule is enforced
- [ ] `DECISIONS.md` is written and committed
- [ ] I compared my implementation against the sample and know where and why we differ
- [ ] I can talk through the model out loud for two minutes without notes
- [ ] I am ready to stop writing loops by hand and learn what C# actually gives me
:::
