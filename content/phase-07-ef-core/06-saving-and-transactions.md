---
title: Saving data and transactions
summary: SaveChanges as a unit of work, and controlling what happens when part of an operation fails.
minutes: 35
stage: Stage 4
---

## What are we learning?

How EF Core writes data, what `SaveChanges` guarantees, and when you need an explicit transaction.

## `SaveChanges` is already a transaction

```csharp
db.Tasks.Add(task);
db.Comments.Add(comment);
existing.Complete();
db.Projects.Remove(oldProject);

await db.SaveChangesAsync(ct);      // ALL of it, or NONE of it
```

One call produces one transaction containing every pending change, in a dependency-correct order (parents before children on insert, children before parents on delete). If any statement fails, everything rolls back and the entities stay in their pre-save state.

So the most common reason people reach for an explicit transaction — "these two saves must both succeed" — is usually solved by making them one save.

## Adding, updating, deleting

```csharp
// add
db.Tasks.Add(task);
db.Tasks.AddRange(tasks);

// update — usually nothing to call, tracking handles it
var task = await db.Tasks.FirstAsync(t => t.Id == id, ct);
task.Complete();

// update a disconnected entity (came from an HTTP request, not loaded)
db.Tasks.Update(task);              // marks EVERY property modified
db.Entry(task).Property(t => t.Title).IsModified = true;   // or be specific

// delete
db.Tasks.Remove(task);

// bulk operations — no tracking, no materialisation, one statement (EF Core 7+)
await db.Tasks.Where(t => t.Status == TaskStatus.Cancelled && t.CreatedAt < cutoff)
    .ExecuteDeleteAsync(ct);

await db.Tasks.Where(t => t.ProjectId == projectId)
    .ExecuteUpdateAsync(s => s.SetProperty(t => t.AssigneeId, (Guid?)null), ct);
```

::: warn ExecuteUpdate and ExecuteDelete bypass the change tracker
They issue SQL directly. That makes them dramatically faster for bulk work — one statement instead of loading a million entities and generating a million `UPDATE`s — but:

- No entity is loaded, so **your domain methods do not run**. `ExecuteUpdate` setting `Status` skips your transition rules entirely.
- Already-tracked entities become stale; the context does not know they changed.
- They execute **immediately**, not at `SaveChanges`, so they are outside its transaction unless you opened one explicitly.

Use them for genuine bulk maintenance: purging old rows, unassigning tasks from a deleted user, backfilling. Do not use them to work around "loading entities is slow" in ordinary business operations — that is how invariants get bypassed.
:::

## Explicit transactions

Needed when you must combine `SaveChanges` with something else it cannot see:

```csharp
await using var transaction = await db.Database.BeginTransactionAsync(ct);
try
{
    db.Tasks.Add(task);
    await db.SaveChangesAsync(ct);                      // need the generated id

    await db.Database.ExecuteSqlAsync($"...", ct);      // raw SQL
    await db.Outbox.AddAsync(new OutboxMessage(task.Id), ct);
    await db.SaveChangesAsync(ct);

    await transaction.CommitAsync(ct);
}
catch
{
    await transaction.RollbackAsync(ct);                // also happens on dispose
    throw;
}
```

`await using` rolls back automatically if `Commit` was never called, so the explicit `RollbackAsync` is belt and braces.

Isolation levels:

```csharp
await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, ct);
```

PostgreSQL defaults to `ReadCommitted`. `Serializable` prevents anomalies at the cost of serialisation failures you must retry. Do not change it without knowing which specific anomaly you are preventing.

::: warn Never call an external service inside a transaction
```csharp
await using var tx = await db.Database.BeginTransactionAsync(ct);
db.Tasks.Add(task);
await db.SaveChangesAsync(ct);
await emailService.SendAsync(...);      // ❌ holds a database transaction open
await tx.CommitAsync(ct);               //    for the duration of an HTTP call
```
An open transaction holds locks. An HTTP call can take thirty seconds, or hang. You have now coupled your database's lock contention to a third party's availability.

The correct pattern is the **outbox**: write the intent to a table inside the transaction, and have a background worker (Phase 14) deliver it afterwards. That also makes the delivery survive a process crash, which the inline version does not.
:::

## Retrying transient failures

```csharp
options.UseNpgsql(connectionString, npgsql => npgsql.EnableRetryOnFailure(
    maxRetryCount: 3,
    maxRetryDelay: TimeSpan.FromSeconds(5),
    errorCodesToAdd: null));
```

This retries transient network and deadlock errors automatically. One caveat: with retries enabled, **user-initiated transactions must be wrapped in an execution strategy**, because EF Core cannot retry a block of code it does not control:

```csharp
var strategy = db.Database.CreateExecutionStrategy();
await strategy.ExecuteAsync(async () =>
{
    await using var tx = await db.Database.BeginTransactionAsync(ct);
    // ...
    await tx.CommitAsync(ct);
});
```

Forgetting this throws a clear exception telling you exactly this, which is a rare kindness.

::: exercise Level 1 — Guided · Save and roll back
1. Add a task and a comment in one `SaveChanges` and confirm one transaction in the SQL log (`BEGIN` … `COMMIT`).
2. Make the second insert fail (violate a constraint) and confirm the first is rolled back.
3. Load a task, modify it, and confirm the `UPDATE` sets only the changed columns.
4. Call `db.Tasks.Update(task)` on an unchanged entity and confirm it updates **every** column.
5. Use `ExecuteDeleteAsync` to remove all cancelled tasks; note the single statement and the absence of any `SELECT`.
6. Prove the stale-tracker problem: load a task, `ExecuteUpdate` its title, then read `task.Title` from the tracked entity.
7. Open an explicit transaction, save, then roll back, and confirm nothing persisted.
:::

::: challenge Level 3 · An outbox
Implement transactional messaging so that a notification is never lost and never sent for a transaction that rolled back.

Requirements:
1. `OutboxMessage` table: id, type, payload (JSON), created, processed-at, attempts, last error.
2. Domain operations write outbox rows in the **same** `SaveChanges` as their data change.
3. A background worker claims unprocessed messages and delivers them.
4. Claiming is safe with several workers running — no message is delivered twice.
5. Failures are retried with backoff; after five attempts a message is moved to a dead-letter state.
6. Ordering is preserved per aggregate (all messages for one task in order).
7. A test proving that a rolled-back transaction leaves no outbox row.

Point 4 is the interesting one; `FOR UPDATE SKIP LOCKED` is the primitive.
:::

::: solution
The claim query:

```csharp
var messages = await db.OutboxMessages
    .FromSql($"""
        SELECT * FROM outbox_messages
        WHERE processed_at IS NULL AND attempts < 5
          AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        ORDER BY aggregate_id, created_at
        LIMIT 50
        FOR UPDATE SKIP LOCKED
        """)
    .ToListAsync(ct);
```

`FOR UPDATE SKIP LOCKED` is the whole answer to requirement 4. It locks the selected rows and *skips* rows another worker has already locked, so N workers each get a disjoint set with no coordination, no distributed lock and no polling collisions. It is the standard way to build a queue on PostgreSQL.

The claim must run inside a transaction, and the delivery plus the mark-as-processed must be in the same transaction — otherwise a crash between delivering and marking causes a duplicate send.

That leads to the honest caveat: **the outbox gives you at-least-once delivery, not exactly-once.** If the process dies after the external call succeeds but before the commit, the message is redelivered. Exactly-once across a database and a third party is not achievable in general; the practical answer is to make consumers idempotent — which is why the idempotency filter from Phase 6 exists.

Requirement 6, ordering per aggregate, conflicts with parallel delivery: two workers processing two messages for the same task can deliver out of order. Options are to partition workers by a hash of `aggregate_id`, or to claim *all* pending messages for an aggregate together. Say which you chose.

The test for requirement 7:
```csharp
[Fact]
public async Task Rolled_back_transaction_leaves_no_outbox_row()
{
    await using var tx = await db.Database.BeginTransactionAsync();
    db.Tasks.Add(task);
    db.OutboxMessages.Add(new OutboxMessage("TaskCreated", json, task.Id));
    await db.SaveChangesAsync();
    await tx.RollbackAsync();

    Assert.Empty(await db.OutboxMessages.ToListAsync());
    Assert.Empty(await db.Tasks.ToListAsync());
}
```
That test is the entire justification for the pattern: the message and the data share a fate.
:::

::: project Writes in TaskFlow
1. Every command path uses tracking and lets `SaveChanges` generate the SQL.
2. A bulk maintenance command using `ExecuteDeleteAsync` for old cancelled tasks.
3. `EnableRetryOnFailure` configured, with the execution-strategy wrapper where you use explicit transactions.
4. An outbox table, written in the same `SaveChanges` as the data.
5. A `deliver` CLI command that drains the outbox (the background service comes in Phase 14).
6. The rollback test.
7. `DECISIONS.md`: where you used `ExecuteUpdate`/`ExecuteDelete` and why those places are safe to bypass the domain.

Commit.
:::

::: interview When do you need an explicit transaction in EF Core?
Usually not — `SaveChanges` already wraps every pending change in a single transaction, so "these two things must both succeed" is normally solved by making them one save.

You need an explicit transaction when you must combine `SaveChanges` with something it does not control: raw SQL, several `SaveChanges` calls where a later one depends on an id generated by an earlier one, or `ExecuteUpdate`/`ExecuteDelete`, which run immediately rather than at save time.

Two things worth adding: if retry-on-failure is enabled you must wrap manual transactions in an execution strategy, because EF Core cannot retry a block it does not own. And you should never call an external service inside a transaction — it holds database locks for the duration of someone else's availability. That is what the outbox pattern solves.
:::

::: checkpoint
- [ ] I confirmed `SaveChanges` produces one transaction
- [ ] I saw an `UPDATE` touch only the changed columns, and `Update()` touch all of them
- [ ] I reproduced the stale-tracker problem after `ExecuteUpdate`
- [ ] I know why an HTTP call inside a transaction is a bug
- [ ] TaskFlow has an outbox, and a test proving rollback removes the message
:::

## Common mistakes

::: mistake
**An explicit transaction around a single `SaveChanges`.** Redundant.

**`ExecuteUpdate` to change state that has domain rules.** The rules never run.

**External calls inside a transaction.** Locks held for the duration of a third party's latency.

**`db.Update(entity)` on a disconnected object.** Overwrites every column, including ones the client never sent — the over-posting problem from Phase 6, at the database layer.

**Manual transactions with retry enabled and no execution strategy.** Throws, with a helpful message most people do not read.
:::
