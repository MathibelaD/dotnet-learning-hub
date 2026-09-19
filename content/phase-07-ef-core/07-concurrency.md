---
title: Concurrency
summary: Two users editing the same row — the lost update, and the two ways to prevent it.
minutes: 35
stage: Stage 4
---

## What are we learning?

Optimistic and pessimistic concurrency control, and how to surface a conflict to a user in a way they can act on.

## The lost update

```text
10:00:00  Alex loads task #42       title = "Fix login"      priority = Normal
10:00:05  Sam  loads task #42       title = "Fix login"      priority = Normal
10:00:20  Alex sets priority = Urgent, saves
10:00:30  Sam  sets title = "Fix login redirect", saves
```

Sam's save writes the whole row from the values Sam loaded — including `priority = Normal`. Alex's change is gone, with no error and no indication to anyone.

This happens in every multi-user application. It is not a rare race; with a `GET`-then-`PUT` API it is the normal case whenever two people work on the same item.

## Optimistic concurrency

The default answer: assume conflicts are rare, detect them at write time, and fail the second writer.

### PostgreSQL: `xmin`

PostgreSQL maintains a hidden system column that changes on every row update. Npgsql can use it directly, so you need no extra column:

```csharp
builder.UseXminAsConcurrencyToken();
```

### Or an explicit token

```csharp
public sealed class TaskItem
{
    public uint Version { get; private set; }
}

builder.Property(t => t.Version).IsRowVersion();
```

Either way, EF Core adds the token to the `WHERE` clause:

```sql
UPDATE tasks SET title = @p0, priority = @p1
WHERE id = @p2 AND xmin = @p3;
-- 0 rows affected  ->  someone else changed it first
```

If zero rows are affected, EF Core throws `DbUpdateConcurrencyException`.

## Handling the conflict

```csharp
try
{
    await db.SaveChangesAsync(ct);
}
catch (DbUpdateConcurrencyException ex)
{
    var entry = ex.Entries.Single();
    var current = await entry.GetDatabaseValuesAsync(ct);

    if (current is null)
        throw new TaskNotFoundException(id);        // someone deleted it

    // three strategies, pick one deliberately
}
```

::: design Three resolution strategies
**1. Client wins (last write wins).** Overwrite whatever is there.
```csharp
entry.OriginalValues.SetValues(current);
await db.SaveChangesAsync(ct);
```
Simple, and it silently discards the other user's work. Acceptable only when the data is not worth much — a "last seen" timestamp, a cache.

**2. Store wins.** Discard this user's change and reload.
```csharp
await entry.ReloadAsync(ct);
```
Rarely what a user wants; they just typed something.

**3. Tell the user.** Return 409 with enough information to resolve it.
```csharp
throw new ConcurrencyConflictException(id, ex.Entries.Single());
```
→ `409 Conflict` with a `ProblemDetails` body naming the conflicting fields.

**For an API, (3) is almost always right.** The client knows what the user intended; the server does not. Returning the current server state alongside the conflict lets a good client show a diff and offer a merge.

A refinement worth knowing: **per-property conflict detection.** If Alex changed `priority` and Sam changed `title`, there is no real conflict — the changes are compatible. Comparing `entry.OriginalValues`, `entry.CurrentValues` and the database values lets you auto-merge non-overlapping edits and only surface genuine collisions. That is noticeably nicer to use, and not much code.
:::

## Exposing it over HTTP

The web has a standard for this: `ETag` and `If-Match`.

```csharp
[HttpGet("{id:guid}")]
public async Task<ActionResult<TaskResponse>> Get(Guid id, CancellationToken ct)
{
    var task = await service.GetAsync(id, ct);
    Response.Headers.ETag = $"\"{task.Version}\"";
    return Ok(task.ToResponse());
}

[HttpPut("{id:guid}")]
public async Task<ActionResult<TaskResponse>> Update(
    Guid id, UpdateTaskRequest request,
    [FromHeader(Name = "If-Match")] string? ifMatch, CancellationToken ct)
{
    if (string.IsNullOrEmpty(ifMatch))
        return StatusCode(428, new ProblemDetails
        {
            Title = "Precondition Required",
            Detail = "Supply the If-Match header with the ETag from your last GET."
        });
    // ... pass the version through; a mismatch becomes 412 Precondition Failed
}
```

`428 Precondition Required` for a missing `If-Match`, `412 Precondition Failed` for a stale one. Using the standard headers means HTTP caches and generic clients understand your concurrency model for free.

## Pessimistic concurrency

Lock the row so nobody else can read it for update:

```csharp
var task = await db.Tasks
    .FromSql($"SELECT * FROM tasks WHERE id = {id} FOR UPDATE")
    .SingleAsync(ct);
```

This blocks other transactions until yours commits.

::: warn Pessimistic locking is rarely right in a web API
A lock is held for the duration of a transaction. In a `GET`-then-think-then-`PUT` workflow, that means holding a database lock while a human decides what to type. Two users, and the second one's request hangs until the first clicks save — or until it times out.

Use it for short, server-side critical sections: decrementing inventory, allocating a sequence number, claiming a queue item (as the outbox does). Never across a user interaction.

Optimistic concurrency is the default for a reason: it holds no locks and only costs something when a conflict actually occurs.
:::

::: exercise Level 1 — Guided · Cause a lost update, then prevent it
1. Write a program that loads the same task into **two** `DbContext` instances.
2. Modify a different property in each, save both, and confirm the first change is lost.
3. Add `UseXminAsConcurrencyToken()` and a migration.
4. Repeat the experiment and confirm the second save now throws `DbUpdateConcurrencyException`.
5. Read the generated `UPDATE` and find `xmin` in the `WHERE` clause.
6. Implement each of the three resolution strategies and observe the different outcomes.
7. Add `ETag`/`If-Match` to your API and test it with curl:
   ```bash
   ETAG=$(curl -si localhost:5080/api/tasks/$ID | grep -i etag | cut -d' ' -f2 | tr -d '\r')
   curl -i -X PUT localhost:5080/api/tasks/$ID -H "If-Match: $ETAG" -H 'Content-Type: application/json' -d '{...}'
   curl -i -X PUT localhost:5080/api/tasks/$ID -H "If-Match: \"999\"" -H 'Content-Type: application/json' -d '{...}'
   ```
:::

::: challenge Level 3 · Merge non-conflicting edits
Requirements:

1. Two users editing **different** fields of the same task both succeed, with both changes preserved.
2. Two users editing the **same** field get a 409 naming that field, with both values.
3. The 409 body includes the current server state so the client can show a diff.
4. The merge is atomic — no window where a third reader sees a half-merged row.
5. A retry limit prevents an infinite merge loop under heavy contention.
6. A test with 50 concurrent edits to different fields of one task; all 50 must be preserved.

Point 6 is the real test. Run it 20 times.
:::

::: solution
```csharp
async Task<TaskItem> SaveWithMergeAsync(TaskItem task, CancellationToken ct, int attempt = 0)
{
    try
    {
        await db.SaveChangesAsync(ct);
        return task;
    }
    catch (DbUpdateConcurrencyException ex) when (attempt < 3)
    {
        var entry = ex.Entries.Single();
        var databaseValues = await entry.GetDatabaseValuesAsync(ct)
            ?? throw new TaskNotFoundException(task.Id);

        var conflicts = new List<FieldConflict>();

        foreach (var property in entry.Metadata.GetProperties())
        {
            var original = entry.OriginalValues[property];     // what I loaded
            var mine     = entry.CurrentValues[property];      // what I want
            var theirs   = databaseValues[property];           // what is there now

            var iChanged     = !Equals(original, mine);
            var theyChanged  = !Equals(original, theirs);

            if (iChanged && theyChanged && !Equals(mine, theirs))
                conflicts.Add(new FieldConflict(property.Name, mine, theirs));
            else if (!iChanged && theyChanged)
                entry.CurrentValues[property] = theirs;        // take their change
            // if only I changed it, mine stands
        }

        if (conflicts.Count > 0)
            throw new ConcurrencyConflictException(task.Id, conflicts, databaseValues.ToObject());

        entry.OriginalValues.SetValues(databaseValues);        // rebase onto the current row
        return await SaveWithMergeAsync(task, ct, attempt + 1);
    }
}
```

The three-way comparison is the whole algorithm, and it is exactly what `git merge` does: compare the common ancestor (`OriginalValues`), my version (`CurrentValues`) and their version (the database). A field only conflicts when **both** sides changed it **to different values**.

`entry.OriginalValues.SetValues(databaseValues)` is the "rebase": it tells EF Core "pretend I loaded the current row", so the next `SaveChanges` carries the fresh concurrency token and the `WHERE` clause matches.

Requirement 4, atomicity: each retry is its own `UPDATE ... WHERE xmin = ?`, which is atomic at the database level. A third reader sees either the pre-merge or the post-merge row, never a partial one.

Requirement 5: the `when (attempt < 3)` filter means the fourth failure propagates. Under sustained contention on one row you genuinely cannot make progress optimistically, and pretending otherwise produces a hot loop.

For requirement 6, the test:
```csharp
await Parallel.ForEachAsync(Enumerable.Range(0, 50), async (i, ct) =>
{
    await using var scope = factory.Services.CreateAsyncScope();
    var svc = scope.ServiceProvider.GetRequiredService<ITaskService>();
    await svc.AddLabelAsync(taskId, $"label-{i}", ct);
});

var final = await db.Tasks.AsNoTracking().FirstAsync(t => t.Id == taskId);
Assert.Equal(50, final.Labels.Count);
```

Each scope gets its own `DbContext`, which is what makes it a real concurrency test rather than fifty operations on one tracked entity. Note that labels are a collection, so this specific case needs merge logic for the collection rather than scalar three-way comparison — which is a good illustration of where the simple algorithm stops being enough.
:::

::: project Concurrency in TaskFlow
1. `UseXminAsConcurrencyToken()` plus a migration.
2. `DbUpdateConcurrencyException` mapped to 409 by your exception handler.
3. `ETag` on every `GET` of a single resource; `If-Match` required on `PUT` and `PATCH`.
4. 428 when `If-Match` is missing, 412 when it is stale.
5. The 409 body includes the current server state.
6. The 50-concurrent-edits test.
7. `DECISIONS.md`: which endpoints require `If-Match` and which do not, and why.

Commit.
:::

::: interview How do you handle concurrent updates to the same record?
With optimistic concurrency. The row carries a version token — in PostgreSQL the built-in `xmin` system column works, otherwise an explicit rowversion — and EF Core includes it in the `WHERE` clause of every `UPDATE`. If no rows are affected, someone else changed the row first and EF Core throws `DbUpdateConcurrencyException`.

For an API I surface that as `409 Conflict` with the current server state, rather than silently overwriting, because the client knows what the user intended and the server does not. Over HTTP the standard expression of this is `ETag` on the `GET` and `If-Match` on the update, with `412 Precondition Failed` on a mismatch.

Pessimistic locking with `SELECT ... FOR UPDATE` is the alternative, but it holds a database lock for the duration of the transaction, so it is only appropriate for short server-side critical sections — never across a user's think time.
:::

::: checkpoint
- [ ] I reproduced a lost update and then made it impossible
- [ ] I found the concurrency token in the generated `UPDATE`
- [ ] I can describe all three resolution strategies and when each applies
- [ ] My API uses `ETag`/`If-Match` with 428 and 412
- [ ] The 50-concurrent-edits test passes repeatedly
:::

## Common mistakes

::: mistake
**No concurrency token at all.** Lost updates, silently, forever.

**Catching `DbUpdateConcurrencyException` and retrying blindly.** An infinite loop under contention, and it reintroduces the lost update.

**Returning 500 for a conflict.** It is a 409, and the client can do something about it.

**Pessimistic locks across a user interaction.** Requests hang until a timeout.

**Concurrency tokens on read-heavy tables with no updates.** Pure overhead.
:::
