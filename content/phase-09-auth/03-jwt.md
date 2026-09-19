---
title: JWT authentication
summary: What is actually inside a token, how validation works, and what a JWT cannot do.
minutes: 45
stage: Stage 5
---

## What are we learning?

JSON Web Tokens: structure, signing, validation, and the limitation that shapes every design decision around them.

## Anatomy

```text
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIzZjJhIiwiZXhwIjoxNzY4...  .SflKxwRJSMeKKF2QT4fwpM
└────────── header ──────────┘ └──────────── payload ────────────┘ └──── signature ────┘
```

Three base64url-encoded parts separated by dots.

```json
// header
{ "alg": "HS256", "typ": "JWT" }

// payload — the claims
{
  "sub": "3f2a8c91-...",              // subject: the user id
  "email": "sam@example.com",
  "role": ["Manager"],
  "iss": "https://taskflow.example",  // issuer
  "aud": "taskflow-api",              // audience
  "exp": 1768000000,                  // expiry (unix seconds)
  "iat": 1767996400,                  // issued at
  "jti": "a3f1..."                    // unique token id
}
```

::: warn The payload is encoded, not encrypted
Anyone holding the token can read every claim. Paste one into jwt.io and it is fully legible.

**Never put anything secret in a JWT.** No password hashes, no personal data beyond what the client already knows, no internal identifiers you would not print in a log.

The signature guarantees **integrity** — nobody can change a claim without invalidating it — not **confidentiality**. If you need confidentiality, that is JWE, a different specification, and it is rarely what you want.
:::

## Signing

**Symmetric (HS256).** One secret signs and verifies. Simple; requires every verifier to hold the signing key.

**Asymmetric (RS256/ES256).** A private key signs, a public key verifies. Necessary when a different service verifies tokens you issue, or when you use an external identity provider.

TaskFlow issues and verifies its own tokens, so HS256 is appropriate. Know that RS256 exists and why.

## Issuing

```csharp
public sealed class JwtTokenService(IOptions<JwtOptions> options, TimeProvider clock) : ITokenService
{
    public AccessToken Create(User user, IReadOnlyList<string> roles)
    {
        var o = options.Value;
        var now = clock.GetUtcNow();
        var expires = now.AddMinutes(o.AccessTokenMinutes);

        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, user.Id.ToString()),
            new(JwtRegisteredClaimNames.Email, user.Email),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString()),
            new(JwtRegisteredClaimNames.Iat, now.ToUnixTimeSeconds().ToString(), ClaimValueTypes.Integer64),
            new("name", user.DisplayName)
        };
        claims.AddRange(roles.Select(r => new Claim(ClaimTypes.Role, r)));

        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(o.SigningKey));
        var token = new JwtSecurityToken(
            issuer: o.Issuer,
            audience: o.Audience,
            claims: claims,
            notBefore: now.UtcDateTime,
            expires: expires.UtcDateTime,
            signingCredentials: new SigningCredentials(key, SecurityAlgorithms.HmacSha256));

        return new AccessToken(new JwtSecurityTokenHandler().WriteToken(token), expires);
    }
}
```

## Validating

```csharp
builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        var jwt = builder.Configuration.GetSection("Jwt").Get<JwtOptions>()!;

        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = jwt.Issuer,

            ValidateAudience = true,
            ValidAudience = jwt.Audience,

            ValidateIssuerSigningKey = true,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwt.SigningKey)),

            ValidateLifetime = true,
            ClockSkew = TimeSpan.FromSeconds(30),        // default is 5 MINUTES

            NameClaimType = JwtRegisteredClaimNames.Sub,
            RoleClaimType = ClaimTypes.Role
        };

        options.Events = new JwtBearerEvents
        {
            OnAuthenticationFailed = context =>
            {
                if (context.Exception is SecurityTokenExpiredException)
                    context.Response.Headers["X-Token-Expired"] = "true";
                return Task.CompletedTask;
            }
        };
    });
```

::: warn Every validation flag matters
Turning any of these off creates a real vulnerability.

- **`ValidateIssuerSigningKey = false`** — the catastrophic one. Any token, signed by anyone, is accepted. An attacker mints themselves an admin token in ten seconds.
- **`ValidateLifetime = false`** — tokens never expire. A token stolen two years ago still works.
- **`ValidateAudience = false`** — a token issued for a different service is accepted by yours. If you and another team share an identity provider, their user's token now works on your API.
- **`ValidateIssuer = false`** — a token from any issuer that happens to use the same key is accepted.

**`ClockSkew` defaults to five minutes**, which means an expired token keeps working for five minutes past `exp`. That is a sensible default for federated systems with drifting clocks; for a single API with NTP it is five extra minutes of exposure. Set it to 30 seconds or less.
:::

## The fundamental limitation

::: warn You cannot revoke a JWT
A JWT is valid because its signature is valid and it has not expired. The server holds no state about it, which is the entire point — and the entire problem.

Consequences:
- A user logs out: their token still works until expiry.
- You disable an account: their token still works until expiry.
- You demote an admin: they remain an admin until expiry.
- A token is stolen: it works until expiry.

The mitigations, in order of practicality:

**1. Short expiry.** A 15-minute access token limits the window. This is the standard answer, and it requires refresh tokens (next lesson) so users are not logged out constantly.

**2. A revocation list.** Store revoked `jti` values in a distributed cache until their `exp` passes, and check on each request. This works — and it reintroduces the server-side state JWTs were meant to avoid, plus a cache lookup per request. Worth it for logout-everywhere and account suspension; not worth it for ordinary logout.

**3. A `security_stamp` claim.** Put a value in the token that changes when the user's security state changes (password change, role change, forced logout). Validate it against the database. Again: a lookup per request.

**Be honest about this in an interview.** "JWTs cannot be revoked, so I use short-lived access tokens with refresh tokens, and a revocation list only for the cases that genuinely need immediate effect" is the answer of someone who has built this. "JWTs are stateless and scalable" on its own is the answer of someone who has read a blog post.
:::

## Where the client stores it

| Location | XSS risk | CSRF risk | Notes |
|---|---|---|---|
| `localStorage` | **High** — readable by any script | None | The common choice, and the weakest |
| `sessionStorage` | High | None | Same, cleared on tab close |
| In-memory (a JS variable) | Low | None | Lost on refresh; pair with a refresh-token cookie |
| httpOnly cookie | **None** — invisible to JS | Needs `SameSite` + anti-forgery | Strongest for browser apps |

The pattern that combines the strengths: **access token in memory, refresh token in an httpOnly `SameSite=Strict` cookie.** An XSS bug cannot read either — the access token dies with the page, and the refresh token is invisible to JavaScript.

::: exercise Level 1 — Guided · Issue and validate
1. Add `Microsoft.AspNetCore.Authentication.JwtBearer`.
2. `JwtOptions` bound from configuration, with the signing key in **user secrets**, validated on start, and a minimum length of 32 characters enforced.
3. `ITokenService` issuing a 15-minute token with sub, email, roles, jti and iat.
4. `POST /api/auth/login` returning the token and its expiry.
5. Call a protected endpoint with the token; confirm 200. Without it; confirm 401.
6. Paste the token into jwt.io and read every claim. Confirm nothing secret is in it.
7. Set `ValidateIssuerSigningKey = false`, mint a token with a different key at jwt.io, and confirm your API accepts it. Then put the flag back — and remember what you just saw.
8. Set the expiry to 10 seconds, wait, and confirm 401 with `X-Token-Expired`.
9. Set `ClockSkew` to zero and observe the difference in step 8's timing.
:::

::: challenge Level 3 · Revocation that is actually usable
Implement logout that takes effect immediately, without a database lookup on every request.

Requirements:
1. `POST /api/auth/logout` revokes the current token immediately.
2. `POST /api/auth/logout-all` revokes every token for the user.
3. A revoked token is rejected within one second, across all API instances.
4. Non-revoked requests add under 1ms of overhead — no per-request database query.
5. Revocation entries expire automatically when the token would have expired anyway.
6. It works with several API instances behind a load balancer.
7. A test proving a revoked token is rejected.
:::

::: solution
```csharp
public sealed class TokenRevocationService(IDistributedCache cache, TimeProvider clock)
{
    public async Task RevokeAsync(string jti, DateTimeOffset expiresAt, CancellationToken ct)
    {
        var ttl = expiresAt - clock.GetUtcNow();
        if (ttl <= TimeSpan.Zero) return;                 // already expired; nothing to do

        await cache.SetStringAsync($"revoked:{jti}", "1",
            new DistributedCacheEntryOptions { AbsoluteExpirationRelativeToNow = ttl }, ct);
    }

    public async Task RevokeAllAsync(Guid userId, CancellationToken ct) =>
        await cache.SetStringAsync($"revoked-before:{userId}",
            clock.GetUtcNow().ToUnixTimeSeconds().ToString(),
            new DistributedCacheEntryOptions { AbsoluteExpirationRelativeToNow = TimeSpan.FromDays(30) }, ct);
}
```

Hooked into validation:

```csharp
options.Events.OnTokenValidated = async context =>
{
    var revocation = context.HttpContext.RequestServices.GetRequiredService<TokenRevocationService>();
    var jti = context.Principal?.FindFirstValue(JwtRegisteredClaimNames.Jti);
    var sub = context.Principal?.FindFirstValue(JwtRegisteredClaimNames.Sub);
    var iat = context.Principal?.FindFirstValue(JwtRegisteredClaimNames.Iat);

    if (await revocation.IsRevokedAsync(jti, sub, iat, context.HttpContext.RequestAborted))
        context.Fail("Token has been revoked.");
};
```

**Requirement 4 — no per-request database query.** Redis is not a database query in the sense that matters: it is an in-memory lookup, typically under 0.5ms on the same network, and it is shared across instances so requirement 6 is satisfied too.

**Requirement 2 uses a different mechanism** and this is the clever part. Revoking every token for a user by listing their `jti` values would require knowing them all. Instead, store a single `revoked-before:{userId}` timestamp and reject any token whose `iat` predates it. One key per user, not one per token, and it covers tokens you have never seen.

**The `AbsoluteExpirationRelativeToNow = ttl`** on individual revocations is what keeps the list from growing without bound. A token cannot be used after `exp`, so there is no reason to remember that it was revoked after that point. The revocation list stays proportional to "tokens revoked in the last 15 minutes", which is tiny.

**The honest caveat:** this reintroduces shared state. If Redis is down, you must choose between failing closed (reject everything — a Redis outage becomes a total outage) and failing open (accept everything — revocation silently stops working). Neither is good. Failing open with a loud alert is the usual choice, and it should be a deliberate, documented decision rather than a default.
:::

::: project JWT for TaskFlow
1. `JwtOptions` from configuration; key in user secrets; validated on start; minimum 32 characters.
2. `ITokenService` in Application, JWT implementation in Infrastructure.
3. Login returns an access token; `[Authorize]` endpoints require it.
4. Every validation parameter on; `ClockSkew` at 30 seconds.
5. `ICurrentUser` reading `sub` from the principal — application code never touches `HttpContext`.
6. `X-Token-Expired` header so clients know to refresh.
7. OpenAPI configured with a bearer security scheme, so the UI can authenticate.
8. `.http` file updated to capture the token and use it.

Commit.
:::

::: interview What is a JWT and what are its limitations?
A JSON Web Token is a signed, base64url-encoded set of claims in three parts: header, payload and signature. The signature proves integrity — nobody can alter a claim without invalidating it — so the server can trust the claims without looking anything up, which is what makes it stateless.

Two limitations matter. The payload is encoded, not encrypted, so anything in it is readable by whoever holds the token; nothing secret goes in a JWT. And a JWT cannot be revoked — it is valid until it expires — so logging out, disabling an account or removing a role has no immediate effect.

The standard mitigation is short-lived access tokens, around 15 minutes, paired with refresh tokens, plus a revocation list in a distributed cache for the cases that need immediate effect, like account suspension. That reintroduces shared state, which is a trade-off worth naming rather than glossing over.
:::

::: checkpoint
- [ ] I read my own token's claims and confirmed nothing secret is in it
- [ ] I saw what `ValidateIssuerSigningKey = false` allows, with my own forged token
- [ ] `ClockSkew` is 30 seconds, not the 5-minute default
- [ ] I can explain why a JWT cannot be revoked and what I do about it
- [ ] The signing key is in user secrets and is at least 32 characters
:::

## Common mistakes

::: mistake
**Any validation flag turned off.** Each one is a real vulnerability, and `ValidateIssuerSigningKey = false` is a total compromise.

**Secrets in the payload.** It is readable by anyone holding the token.

**Long-lived access tokens.** A 24-hour token is a 24-hour window after any compromise.

**Default `ClockSkew`.** Five extra minutes of validity after expiry.

**The signing key in `appsettings.json`.** Committed to git, and now every token is forgeable.

**Assuming logout works.** Without revocation, it only clears the client.
:::
