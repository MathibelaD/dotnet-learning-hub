---
title: Caching
summary: Making things fast by not doing them — and the invalidation problem that makes it hard.
minutes: 40
---

## What are we learning?

The caching layers available in .NET, and the discipline that keeps a cache from becoming a source of wrong answers.

## The layers

```text
CLIENT           browser cache, driven by Cache-Control headers
CDN / PROXY      shared cache in front of your service
OUTPUT CACHE     whole HTTP responses, in your process or distributed
IN-MEMORY        IMemoryCache — fastest, per instance, lost on restart
DISTRIBUTED      Redis — shared across instances, survives restarts
DATABASE         query plan cache, buffer pool — free, and already working
```

Cache as close to the caller as you can get away with. A response served from a CDN never reaches your servers at all.

## `HybridCache` (.NET 9)

The modern default, and it replaces most hand-rolled caching:

```bash
dotnet add package Microsoft.Extensions.Caching.Hybrid
```

```csharp
builder.Services.AddHybridCache(options =>
{
    options.DefaultEntryOptions = new HybridCacheEntryOptions
    {
        Expiration = TimeSpan.FromMinutes(5),          // L2 (distributed)
        LocalCacheExpiration = TimeSpan.FromMinutes(1) // L1 (in-process)
    };
});
builder.Services.AddStackExchangeRedisCache(o => o.Configuration = redisConnectionString);
```

```csharp
public sealed class CachedProjectStats(HybridCache cache, IProjectQueries queries)
{
    public async Task<ProjectStats> GetAsync(Guid projectId, CancellationToken ct) =>
        await cache.GetOrCreateAsync(
            $"project-stats:{projectId}",
            projectId,
            async (id, token) => await queries.ComputeStatsAsync(id, token),
            tags: [$"project:{projectId}"],
            cancellationToken: ct);

    public async Task InvalidateAsync(Guid projectId, CancellationToken ct) =>
        await cache.RemoveByTagAsync($"project:{projectId}", ct);
}
```

What it gives you that `IMemoryCache` does not:

- **Two levels**: an in-process L1 backed by a distributed L2, so a cache hit is usually a nanosecond lookup and a miss still avoids the database.
- **Stampede protection** built in — the problem you solved by hand in Phase 13.
- **Tag-based invalidation** — `RemoveByTagAsync` clears every entry for a project without knowing their keys.
- **Serialisation** handled, with no `byte[]` juggling.

## Output caching

For whole responses:

```csharp
builder.Services.AddOutputCache(options =>
{
    options.AddBasePolicy(builder => builder.Expire(TimeSpan.FromSeconds(10)));

    options.AddPolicy("PublicStats", builder => builder
        .Expire(TimeSpan.FromMinutes(5))
        .SetVaryByQuery("projectId")
        .Tag("stats"));
});

app.UseOutputCache();

app.MapGet("/api/stats/public", Handler).CacheOutput("PublicStats");
```

```csharp
// invalidate by tag
await outputCacheStore.EvictByTagAsync("stats", ct);
```

::: warn Never output-cache an authenticated response without varying by user
```csharp
app.MapGet("/api/tasks", Handler).CacheOutput();      // ❌ catastrophic
```
The first user's task list is now served to every other user. This is a real, repeated incident class — including at large companies — and it is a total authorization bypass produced by one attribute.

ASP.NET Core's output cache does not cache responses when the request carries an `Authorization` header **by default**, which protects you in the common case. Do not rely on it: be explicit.

```csharp
.SetVaryByHeader("Authorization")        // still risky — one entry per token
```
Better: **do not output-cache per-user data at all.** Cache the expensive shared computation underneath it with `HybridCache`, keyed appropriately, and let the per-user response be assembled fresh.
:::

## HTTP caching

The cheapest cache is the one in the client:

```csharp
[HttpGet("{id:guid}")]
public async Task<ActionResult<TaskResponse>> Get(Guid id, CancellationToken ct)
{
    var task = await queries.GetAsync(id, ct);
    if (task is null) return NotFound();

    var etag = $"\"{task.Version}\"";

    if (Request.Headers.IfNoneMatch.Contains(etag))
        return StatusCode(StatusCodes.Status304NotModified);      // no body at all

    Response.Headers.ETag = etag;
    Response.Headers.CacheControl = "private, max-age=60";
    return Ok(task);
}
```

A `304` sends headers and no body. For a client polling a list, this can cut bandwidth by 95% while keeping correctness exact — the server still checks, it just does not resend unchanged data.

You already have `ETag` from Phase 7's concurrency work. It does double duty.

## Invalidation

::: design The hard part, and the three honest strategies
"There are two hard things in computer science: cache invalidation and naming things." It is a joke because it is true.

**1. Time-based expiry.** Simple, and always somewhat wrong. Pick an expiry by asking *how stale can this be before someone is harmed?* Project statistics: five minutes is fine. A user's permission set: no, that must be immediate.

**2. Explicit invalidation on write.** Correct, and fragile — every write path must remember. Tag-based invalidation makes it far more reliable, because one tag covers every derived entry.

**3. Versioned keys.** Instead of invalidating, change the key:
```csharp
var key = $"project-stats:{projectId}:v{project.Version}";
```
Old entries are never read again and expire naturally. No invalidation bug is possible, at the cost of some wasted memory. This is the most robust option and it is underused.

**What to cache, in order of how safe it is:**
- Reference data that changes rarely — labels, configuration → cache hard
- Expensive aggregates — statistics, reports → cache with a short expiry
- Individual entities → cache with tag invalidation
- Per-user lists → usually do not; cache the expensive parts underneath
- Anything involving permissions → **do not cache the authorization decision**

That last one matters. Caching "user X may read task Y" means revoking access has no effect until the entry expires — a security bug wearing a performance improvement's clothes.
:::

## What not to cache

```csharp
// ❌ hiding a missing index
var tasks = await cache.GetOrCreateAsync(key, _ => SlowUnindexedQuery());
```

A cache over a query that is slow for a fixable reason gives you two problems: the original slowness on every miss, plus a staleness window. **Fix the query first.** Phase 7's method — measure, read the SQL, read the plan, index — comes before caching, not after.

::: exercise Level 1 — Guided · Add caching in layers
1. Measure `/api/projects/{id}/stats` uncached: time and query count.
2. Add `HybridCache` with a five-minute expiry. Measure again.
3. Invalidate by tag when a task in that project changes; prove correctness with a test.
4. Add `ETag`/`If-None-Match` to `GET /api/tasks/{id}`; confirm a 304 with curl.
5. Add output caching to a genuinely public endpoint only.
6. Try output-caching an authenticated endpoint in a test environment and observe the leak. Then remove it.
7. Add cache-hit and cache-miss metrics, and graph the hit ratio.
:::

::: challenge Level 3 · A cache you can trust
Requirements:

1. Cached statistics are never more than 30 seconds stale after a write.
2. A cold cache under 1,000 concurrent requests calls the database once.
3. Hit ratio, miss count and eviction count are all measured.
4. Redis being unavailable degrades to L1 only — it must not fail requests.
5. A cached entry is never served to a user who is no longer permitted to see it.
6. A test that writes, immediately reads, and asserts freshness.
7. A load test showing the database query rate before and after.

Requirement 5 is the security one, and requirement 4 is the availability one. Both are commonly missed.
:::

::: solution
**Requirement 5 is the important one, and the answer is a design rule rather than code.**

The wrong approach:
```csharp
var key = $"tasks:{userId}:{queryHash}";       // cache the authorised result
```
That caches an authorization *outcome*. Remove the user from a project and they keep seeing its tasks until the entry expires. The cache has silently become part of your access-control system, and it is the least trustworthy part.

The right approach: **cache the expensive computation, apply authorization fresh on every request.**

```csharp
// cached: shared, authorization-independent
var allProjectStats = await cache.GetOrCreateAsync(
    $"project-stats:{projectId}", ..., tags: [$"project:{projectId}"]);

// not cached: cheap, per-request, always current
if (!await authorization.CanReadAsync(user, projectId, ct))
    return Forbid();

return Ok(allProjectStats);
```

The permission check is a fast lookup; the statistics computation was the expensive part. Caching the second and not the first gives you the performance without making the cache security-critical.

The general rule, worth stating in an interview: **never cache an authorization decision, and never key a cache by a user unless the data is genuinely private and the key is invalidated on every permission change.**

**Requirement 4 — Redis being down.** `HybridCache` handles L2 failures by falling back to L1, but verify it rather than assuming:

```csharp
[Fact]
public async Task Requests_succeed_when_the_distributed_cache_is_unavailable()
{
    await redisContainer.StopAsync();

    var response = await client.GetAsync($"/api/projects/{projectId}/stats");

    response.StatusCode.ShouldBe(HttpStatusCode.OK);     // degraded, not failed
}
```

A cache outage causing a service outage is the classic way a performance optimisation becomes an availability liability. The cache must always be optional.

**Requirement 1**, 30-second freshness with a five-minute expiry, comes from tag invalidation on write plus the expiry as a backstop. The expiry is not how freshness is achieved — it is the safety net for an invalidation you forgot.
:::

::: project Caching in TaskFlow
1. `HybridCache` with L1 and L2, Redis in compose.
2. Cached: project statistics, label lists, user lookups.
3. Tag-based invalidation on every relevant write.
4. `ETag`/`If-None-Match` on single-resource GETs.
5. Output caching on public endpoints only.
6. No authorization decision cached anywhere — verified by a test.
7. Cache metrics with a hit-ratio graph.
8. A test proving the service works with Redis stopped.
9. `DECISIONS.md`: what is cached, for how long, how it is invalidated, and why each expiry is acceptable.

Commit.
:::

::: interview How would you add caching to an API?
First by not needing it — confirming the slow thing is not slow for a fixable reason, because caching a query with a missing index gives you the original latency on every miss plus a staleness window.

Then in layers, as close to the caller as possible: HTTP caching with `ETag` and `If-None-Match` so unchanged data is a 304 with no body; output caching for genuinely public responses; and `HybridCache` for expensive computations, which gives a two-level in-process and distributed cache with stampede protection and tag-based invalidation built in.

Invalidation is the hard part. I prefer tag-based invalidation on write with a time expiry as a backstop, or versioned keys where old entries simply become unreachable and expire naturally.

Two rules I would state explicitly. Never cache an authorization decision — revoking access must take effect immediately, and a per-user cached result makes the cache part of your security model. And the cache must be optional: if Redis goes down, the service degrades to the in-process layer rather than failing requests.
:::

::: checkpoint
- [ ] I measured before caching, and fixed the query first
- [ ] Tag-based invalidation keeps data fresh within my stated window
- [ ] No authorization decision is cached
- [ ] The service works with Redis stopped
- [ ] I can state the expiry and invalidation strategy for every cached thing
:::

## Common mistakes

::: mistake
**Caching to hide a missing index.** Two problems instead of one.

**Output-caching an authenticated response.** A total authorization bypass.

**Caching permission checks.** Revocation stops working.

**A cache whose failure fails the request.** A performance optimisation that reduces availability.

**Expiry as the only invalidation strategy.** Everything is stale for the length of the expiry, always.
:::
