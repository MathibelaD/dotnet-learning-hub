---
title: Refresh tokens
summary: Short-lived access tokens without logging users out every fifteen minutes — and detecting theft.
minutes: 40
stage: Stage 5
---

## What are we learning?

The refresh-token flow, rotation, and reuse detection — the mechanism that makes short access-token lifetimes practical.

## The problem

A 15-minute access token is good for security and terrible for users, who would have to log in four times an hour.

A refresh token solves it: long-lived, stored securely, exchanged for a new access token when the old one expires.

```text
login          → access token (15 min) + refresh token (14 days)
15 min later   → access token expires
               → POST /auth/refresh with the refresh token
               → new access token (15 min) + NEW refresh token
14 days idle   → refresh token expires → log in again
```

## Access tokens and refresh tokens are different animals

| | Access token | Refresh token |
|---|---|---|
| Format | JWT, self-validating | An opaque random string |
| Lifetime | 5–15 minutes | Days to weeks |
| Stored server-side | No | **Yes**, hashed |
| Sent with | Every request | Only to `/auth/refresh` |
| Revocable | Not really | **Yes**, immediately |
| Contains claims | Yes | No |

::: warn A refresh token must not be a JWT
It has no reason to be. It is a random opaque value whose only job is to look up a server-side record — which is precisely what makes it revocable, the property the access token lacks.

Store it **hashed**, like a password. A leaked database should not hand an attacker working refresh tokens. SHA-256 is fine here (unlike for passwords) because the token is 256 bits of randomness, so there is nothing to brute-force.
:::

## The record

```csharp
public sealed class RefreshToken
{
    public Guid Id { get; private set; } = Guid.CreateVersion7();
    public Guid UserId { get; private set; }
    public string TokenHash { get; private set; } = "";
    public DateTimeOffset ExpiresAt { get; private set; }
    public DateTimeOffset CreatedAt { get; private set; }
    public string? CreatedByIp { get; private set; }
    public string? UserAgent { get; private set; }

    public DateTimeOffset? RevokedAt { get; private set; }
    public string? RevokedReason { get; private set; }
    public Guid? ReplacedByTokenId { get; private set; }     // the rotation chain

    public bool IsActive => RevokedAt is null && DateTimeOffset.UtcNow < ExpiresAt;
}
```

Generating one:

```csharp
public (string Token, string Hash) Create()
{
    var bytes = RandomNumberGenerator.GetBytes(32);          // 256 bits
    var token = Convert.ToBase64String(bytes);
    var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
    return (token, hash);
}
```

`RandomNumberGenerator`, not `Random`. `Random` is a deterministic pseudo-random generator seeded from the clock — an attacker who knows roughly when a token was issued can enumerate the possibilities. This is a real, exploited class of vulnerability.

## Rotation

Every refresh issues a **new** refresh token and revokes the old one.

```csharp
public async Task<Result<TokenPair>> RefreshAsync(string refreshToken, string? ip, CancellationToken ct)
{
    var hash = Hash(refreshToken);
    var stored = await tokens.FindByHashAsync(hash, ct);

    if (stored is null)
        return Result<TokenPair>.Failure("Invalid refresh token.");

    // ── REUSE DETECTION ───────────────────────────────────────────────
    if (stored.RevokedAt is not null)
    {
        // This token was already used. Either it was stolen and replayed,
        // or the legitimate client replayed it. Either way, assume the worst.
        await tokens.RevokeDescendantsAsync(stored.Id, "Reuse detected", ct);
        logger.LogWarning("Refresh token reuse detected for user {UserId} from {Ip}", stored.UserId, ip);
        await uow.SaveChangesAsync(ct);
        return Result<TokenPair>.Failure("Invalid refresh token.");
    }

    if (!stored.IsActive)
        return Result<TokenPair>.Failure("Invalid refresh token.");

    var user = await users.GetAsync(stored.UserId, ct);
    if (user is null || user.IsDisabled)
        return Result<TokenPair>.Failure("Invalid refresh token.");

    // rotate
    var (newToken, newHash) = Create();
    var replacement = RefreshToken.Issue(user.Id, newHash, clock.GetUtcNow().AddDays(14), ip);
    stored.RevokeAndReplaceWith(replacement.Id, clock.GetUtcNow());

    await tokens.AddAsync(replacement, ct);
    await uow.SaveChangesAsync(ct);

    return new TokenPair(tokenService.Create(user, user.Roles), newToken);
}
```

::: why Why reuse detection matters
Suppose an attacker steals refresh token `R1`.

**Without rotation:** `R1` works for fourteen days. Nobody notices.

**With rotation but no reuse detection:** whoever refreshes first gets `R2`; the other is left with a dead token and has to log in again. The victim sees an odd logout and thinks nothing of it. The attacker may well be the one holding the live chain.

**With rotation and reuse detection:** `R1` is used twice. The second use is on a revoked token, which is only possible if two parties hold it. You cannot tell which one is legitimate — so you revoke the **entire chain**, logging out both, and alert the user. The attacker loses access, the victim logs in again and learns something was wrong.

That is the whole design: you cannot prevent theft, but you can guarantee it is detected the moment the token is used twice. It is the standard pattern (RFC 6819 / OAuth 2.0 Security BCP) and being able to explain it is a strong signal in an interview.
:::

Revoking the chain:

```sql
WITH RECURSIVE chain AS (
    SELECT id FROM refresh_tokens WHERE id = @start
    UNION ALL
    SELECT rt.id FROM refresh_tokens rt JOIN chain c ON rt.replaced_by_token_id = c.id
)
UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'Reuse detected'
WHERE id IN (SELECT id FROM chain) AND revoked_at IS NULL;
```

Or more simply, and usually good enough: revoke every active token for that user.

## Where the client keeps it

```csharp
Response.Cookies.Append("refresh_token", token, new CookieOptions
{
    HttpOnly = true,                       // invisible to JavaScript
    Secure = true,                         // HTTPS only
    SameSite = SameSiteMode.Strict,        // not sent cross-site — CSRF protection
    Expires = expiresAt,
    Path = "/api/auth"                     // sent ONLY to the auth endpoints
});
```

`Path = "/api/auth"` is a small, valuable detail: the refresh token is not attached to every request, so it is not in most logs, proxies or crash dumps.

Combined with keeping the **access token in memory only**, this is the strongest practical arrangement for a browser client: an XSS bug cannot read either token.

::: exercise Level 1 — Guided · Implement the flow
1. `RefreshToken` entity plus configuration, with an index on `TokenHash`.
2. Issue an access token and a refresh token at login.
3. `POST /api/auth/refresh` exchanging one for a new pair, with rotation.
4. `POST /api/auth/revoke` revoking a specific token.
5. Refresh token in an httpOnly, Secure, SameSite=Strict cookie with a path.
6. Reduce the access token to 1 minute; call a protected endpoint, wait, get 401, refresh, and confirm the new token works.
7. Use an old refresh token after rotating, and confirm reuse detection revokes the chain.
8. Confirm the stored value is a hash, not the token — look in the database.
:::

::: challenge Level 3 · Session management
Requirements:

1. `GET /api/auth/sessions` lists the user's active sessions with device, IP, created time and last used.
2. `DELETE /api/auth/sessions/{id}` revokes one.
3. `POST /api/auth/logout-all` revokes every session except the current one.
4. A maximum of 5 concurrent sessions; a sixth login revokes the oldest.
5. Expired and revoked tokens are cleaned up by a background job (the job itself comes in Phase 14; write the method now).
6. A login from a new IP or user agent writes a security-event record.
7. Reuse detection revokes the chain, writes a security event, and marks the account for a forced re-login.
:::

::: solution
Requirement 4 has a subtlety worth thinking through:

```csharp
var active = await tokens.ActiveForUserAsync(user.Id, ct);
if (active.Count >= MaxSessions)
{
    foreach (var oldest in active.OrderBy(t => t.CreatedAt).Take(active.Count - MaxSessions + 1))
        oldest.Revoke("Session limit reached", clock.GetUtcNow());
}
```

Ordering by `CreatedAt` revokes the oldest *session*; ordering by `LastUsedAt` revokes the least *active* one. The second is friendlier — a session you use daily should not be evicted because it was created first — but it requires updating `LastUsedAt` on every refresh, which is a write on a hot path. For a 15-minute access token that is one write per 15 minutes per session, which is fine.

Requirement 3, "except the current one", needs the current token's identity. The refresh token arrives as a cookie, so:

```csharp
var current = Request.Cookies["refresh_token"] is { } t ? Hash(t) : null;
await tokens.RevokeAllForUserAsync(userId, exceptHash: current, "Logged out other sessions", ct);
```

Requirement 6 — device fingerprinting from the user agent is weak (easily spoofed, and it changes on every browser update) but it is the signal available in a plain API. Parse it into something human-readable for the session list:

```csharp
static string Describe(string? userAgent) => userAgent switch
{
    null or "" => "Unknown device",
    var ua when ua.Contains("iPhone") => "iPhone",
    var ua when ua.Contains("Android") => "Android device",
    var ua when ua.Contains("Macintosh") => "Mac",
    var ua when ua.Contains("Windows") => "Windows PC",
    _ => "Unknown device"
};
```

It is approximate, and that is acceptable — its job is to help a user recognise "that is not me", not to be forensic evidence.

**The security-event log from requirement 6 is worth more than it looks.** "New login from an unrecognised device" is the single most effective account-takeover notification in practice, because the legitimate user knows instantly that something is wrong. It costs one table and one email.
:::

::: project Sessions for TaskFlow
1. The full refresh flow with rotation and reuse detection.
2. httpOnly cookie storage with a path.
3. Session listing and per-session revocation.
4. A 5-session limit.
5. A `SecurityEvent` table recording logins, refreshes, revocations and reuse detections.
6. A cleanup method for expired tokens.
7. Tests: the full cycle, reuse detection, the session limit, and logout-all.
8. `.http` file updated to show the whole flow.

Commit.
:::

::: interview How do refresh tokens work, and why rotate them?
An access token is deliberately short-lived — 15 minutes — so a stolen one has a small window. A refresh token is long-lived, opaque rather than a JWT, stored hashed on the server, and exchanged at a dedicated endpoint for a new access token. Because it is server-side state, it can be revoked immediately, which a JWT cannot.

Rotation means every refresh issues a new refresh token and revokes the old one. That enables **reuse detection**: if a revoked refresh token is ever presented again, two parties hold it, so one of them is an attacker. You cannot tell which, so you revoke the whole chain, log everyone out and alert the user.

That is the key insight — you cannot prevent token theft, but rotation guarantees you detect it the moment the stolen token is used. For browser clients I would store the refresh token in an httpOnly, Secure, SameSite=Strict cookie scoped to the auth path, and keep the access token in memory, so an XSS bug can read neither.
:::

::: checkpoint
- [ ] Refresh tokens are opaque random values, stored hashed
- [ ] Every refresh rotates the token
- [ ] I triggered reuse detection and saw the chain revoked
- [ ] The cookie is httpOnly, Secure, SameSite=Strict and path-scoped
- [ ] I can explain why reuse detection revokes both parties
:::

## Common mistakes

::: mistake
**A JWT as the refresh token.** You lose the one property you needed: revocability.

**Refresh tokens stored in plain text.** A database leak becomes account takeover.

**`Random` instead of `RandomNumberGenerator`.** Predictable tokens.

**Rotation without reuse detection.** The victim gets a mysterious logout and the attacker keeps the live chain.

**A refresh token sent with every request.** It ends up in access logs, proxies and crash dumps. Scope the cookie path.
:::
