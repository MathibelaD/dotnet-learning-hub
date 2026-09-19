---
title: Security hardening
summary: CORS, HTTPS, secrets, injection and the OWASP issues that actually appear in .NET APIs.
minutes: 45
stage: Stage 5
---

## What are we learning?

The security work that is not authentication: transport, browser policy, secret handling, input safety, and a practical pass over the OWASP Top 10 as it applies to what you have built.

## CORS

Browsers block cross-origin requests unless the server opts in. CORS is a **browser** protection — it does nothing against curl, Postman or a server-side attacker.

```csharp
builder.Services.AddCors(options =>
{
    options.AddPolicy("TaskFlow", policy => policy
        .WithOrigins("https://app.taskflow.example", "http://localhost:3000")
        .WithMethods("GET", "POST", "PUT", "PATCH", "DELETE")
        .WithHeaders("Authorization", "Content-Type", "If-Match")
        .WithExposedHeaders("ETag", "X-Correlation-Id")
        .AllowCredentials()
        .SetPreflightMaxAge(TimeSpan.FromMinutes(10)));
});

app.UseCors("TaskFlow");     // after UseRouting, before UseAuthentication
```

::: warn `AllowAnyOrigin` with `AllowCredentials` is not possible, for a reason
```csharp
policy.AllowAnyOrigin().AllowCredentials();     // throws at startup
```
The framework refuses, because that combination would let **any** website make authenticated requests as your logged-in users — exactly the attack CORS exists to prevent.

The workaround people reach for is worse:
```csharp
policy.SetIsOriginAllowed(_ => true).AllowCredentials();   // ❌ same hole, no guardrail
```
If you find that in a codebase, it is a finding. List your origins. If they are dynamic, validate against an allowlist from configuration.

`WithExposedHeaders` is the one people forget: by default JavaScript can only read a handful of response headers. Your `ETag` (Phase 7) is invisible to the browser unless you expose it.
:::

## HTTPS

```csharp
app.UseHttpsRedirection();
app.UseHsts();                  // production only — it is sticky
```

HSTS tells browsers "always use HTTPS for this domain for the next N days". It is cached by the browser, so enabling it on `localhost` breaks your local HTTP development until the cache clears. That is why the template guards it with `if (!app.Environment.IsDevelopment())`.

Behind a reverse proxy or load balancer, the app sees HTTP even when the client used HTTPS. Without configuration, redirect loops and wrong generated URLs follow:

```csharp
app.UseForwardedHeaders(new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto
});
```

Place it **first**, before anything that reads the scheme or the client IP — including your rate limiter, which will otherwise see the proxy's IP for every request and rate-limit your entire user base as one client.

## Security headers

```csharp
app.Use(async (context, next) =>
{
    var h = context.Response.Headers;
    h["X-Content-Type-Options"] = "nosniff";
    h["X-Frame-Options"] = "DENY";
    h["Referrer-Policy"] = "no-referrer";
    h["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()";
    h["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'";
    h.Remove("Server");
    await next(context);
});
```

For a JSON API, `default-src 'none'` is correct and strict — the API serves no scripts, styles or frames. (If you serve Swagger UI, that path needs a looser policy.)

`nosniff` matters more than it looks: without it, a browser may guess a response's type from its content, and a JSON response containing HTML can be interpreted as HTML and executed.

## Secrets

Phase 5 covered the mechanics. The rules:

1. **Never in source control.** Not in `appsettings.json`, not "temporarily".
2. **Development:** user secrets.
3. **Production:** environment variables or a secret manager (Key Vault, Secrets Manager, Vault).
4. **Rotate** on any suspicion, and on a schedule.
5. **Scan** for leaked secrets in CI — `gitleaks` or GitHub's secret scanning.

```bash
# add to CI
docker run -v "$PWD:/repo" zricethezav/gitleaks:latest detect --source /repo --no-git -v
```

If a secret is ever committed, **rotate it**. Removing the commit does not help; assume it is compromised from the moment it was pushed.

## Injection

**SQL injection** — EF Core parameterises everything by default, so LINQ queries are safe. The danger is raw SQL:

```csharp
// ❌ vulnerable
db.Tasks.FromSqlRaw($"SELECT * FROM tasks WHERE title = '{userInput}'");

// ✅ parameterised — the interpolated form builds parameters
db.Tasks.FromSql($"SELECT * FROM tasks WHERE title = {userInput}");

// ✅ explicit
db.Tasks.FromSqlRaw("SELECT * FROM tasks WHERE title = {0}", userInput);
```

The trap is that `FromSql` and `FromSqlRaw` look nearly identical and behave completely differently. `FromSql` takes a `FormattableString` and parameterises; `FromSqlRaw` takes a `string` and does not. Prefer `FromSql` always.

**Other injection surfaces in a .NET API:**

| Surface | Risk | Defence |
|---|---|---|
| Log messages | Log forging with `\n` | Structured logging (Phase 5) — values are fields, not text |
| File paths | Path traversal `../../etc/passwd` | `Path.GetFullPath` + check it stays under the root |
| Command execution | Shell injection | Avoid; if unavoidable, `ProcessStartInfo.ArgumentList`, never a joined string |
| Regular expressions | ReDoS — catastrophic backtracking | Timeouts, or `RegexOptions.NonBacktracking` |
| Deserialisation | Type confusion / RCE | `System.Text.Json` is safe by default; never enable polymorphic deserialisation on untrusted input |
| Mass assignment | Over-posting | DTOs (Phase 6) |

```csharp
// path traversal defence
var requested = Path.GetFullPath(Path.Combine(uploadRoot, userSuppliedName));
if (!requested.StartsWith(uploadRoot, StringComparison.Ordinal))
    throw new UnauthorizedAccessException("Path traversal attempt.");
```

```csharp
// ReDoS defence
private static readonly Regex Pattern = new(@"^[\w.-]+@[\w.-]+$",
    RegexOptions.Compiled | RegexOptions.NonBacktracking, TimeSpan.FromMilliseconds(100));
```

## OWASP Top 10, applied to TaskFlow

| Risk | Where it applies here | What you did |
|---|---|---|
| **A01 Broken Access Control** | Task and project endpoints | Resource-based authorization; SQL-level scoping; fallback policy |
| **A02 Cryptographic Failures** | Passwords, tokens | Argon2id/PBKDF2; hashed refresh tokens; HTTPS + HSTS |
| **A03 Injection** | Search, raw SQL | Parameterised queries; structured logging; validated input |
| **A04 Insecure Design** | The auth model itself | Designed on paper first; secure by default; rate limiting |
| **A05 Security Misconfiguration** | CORS, headers, error detail | Explicit origins; security headers; no stack traces in production |
| **A06 Vulnerable Components** | NuGet dependencies | `dotnet list package --vulnerable` in CI, as errors |
| **A07 Authentication Failures** | Login, sessions | Lockout; timing-safe comparison; rotation with reuse detection |
| **A08 Data Integrity Failures** | Deserialisation, package supply chain | `System.Text.Json` defaults; lock files |
| **A09 Logging Failures** | Everything | Structured logs; security events; correlation ids |
| **A10 SSRF** | Any outbound call driven by user input | Allowlist destinations; never fetch a user-supplied URL |

**A01 is consistently number one, and it is the one your own code is most likely to get wrong**, because every application's access rules are bespoke. That is why lesson 4 spent so long on it and why the test matrix matters.

::: exercise Level 1 — Guided · Harden the API
1. CORS with explicit origins, `AllowCredentials`, and `ETag` exposed. Test from a browser console on a disallowed origin and watch it blocked.
2. Security headers middleware; verify with `curl -I`.
3. Forwarded headers, placed first.
4. HSTS in production only.
5. Add `gitleaks` to your build script and run it against your repository.
6. Write a deliberately vulnerable `FromSqlRaw` search, exploit it with `' OR '1'='1`, then fix it with `FromSql` and confirm the exploit fails.
7. `dotnet list package --vulnerable --include-transitive` and fix anything found.
:::

::: challenge Level 3 · Attack your own API
Write a script that attempts each of these against a running TaskFlow. Each must fail, and you must be able to show *why* it fails.

1. Read another user's task by id.
2. Enumerate valid task ids by comparing 403 and 404 responses.
3. Enumerate registered emails by response text, then by timing.
4. Brute-force a login (must be rate limited and locked out).
5. Reuse a revoked refresh token.
6. Forge a token with a different signing key.
7. Set `"role": "Admin"` in the JWT payload without re-signing.
8. SQL injection through the search parameter.
9. Over-post `id` and `createdAt` on create.
10. XSS: create a task titled `<script>alert(1)</script>` and check it is returned safely encoded.
11. Cross-origin request from an unlisted origin.
12. Path traversal through any file endpoint.

Write the results into `SECURITY.md`. Any that succeed are findings — fix them.
:::

::: solution
Number 10 is the one most API developers get wrong, and the answer is subtler than "escape it".

`<script>alert(1)</script>` as a task title is **fine to store and fine to return**. `System.Text.Json` escapes `<` and `>` in output by default (to `<`), and a `Content-Type: application/json` response with `X-Content-Type-Options: nosniff` is never executed as HTML.

The vulnerability is not in your API — it is in whatever renders the title. An API that strips HTML on input is destroying legitimate data (a task about `<script>` tags is a reasonable task) and providing false assurance, because a second consumer will render it unsafely anyway.

**The correct rule: encode on output, in the context where the output is used.** HTML-encode for HTML, JSON-encode for JSON, URL-encode for URLs. Your API's job is to return the data faithfully with the correct content type and `nosniff`; the consumer's job is to encode for its own rendering context.

The one exception worth making: if a field will *definitely* be rendered as HTML somewhere, sanitise it with a proper library (HtmlSanitizer) at the point of rendering, not with a regex at the point of input. Regex-based HTML stripping has been bypassed so many times that it is a reliable sign of a codebase with other problems.

Number 7 — setting `"role": "Admin"` without re-signing — should fail with 401, because the signature no longer matches. If it *succeeds*, `ValidateIssuerSigningKey` is off and you have a total compromise. Run this test in CI; it takes two seconds and it protects against the single worst misconfiguration in this phase.
:::

::: project Harden TaskFlow
1. CORS, security headers, forwarded headers, HSTS.
2. `gitleaks` and `--vulnerable` in the build script, both failing the build.
3. The full attack script from the challenge, as a runnable file.
4. `SECURITY.md` with the results and anything you fixed.
5. Tests for the highest-value cases: forged token, altered payload, cross-user access, over-posting.
6. `DECISIONS.md`: the OWASP table, with what you did for each row.

Commit.
:::

::: interview What security concerns would you address in a .NET API?
Starting with the one that is most often wrong: broken access control. Authorization has to be enforced per resource, not just per role, and for list endpoints it has to be a SQL-level filter applied before counting — otherwise totals leak data the user cannot see.

Then credentials: slow salted hashing for passwords, opaque hashed refresh tokens with rotation and reuse detection, and full JWT validation with every flag on — `ValidateIssuerSigningKey` off is a complete compromise.

Then configuration: explicit CORS origins rather than any-origin with credentials, HTTPS with HSTS, forwarded headers first so the real client IP reaches the rate limiter, security headers including `nosniff`, and no exception detail in production responses.

Then inputs: parameterised queries — EF Core does this by default, but `FromSqlRaw` does not — DTOs to prevent over-posting, path canonicalisation for any file access, and regex timeouts.

And continuously: dependency vulnerability scanning and secret scanning in CI, both failing the build rather than warning.
:::

::: checkpoint
- [ ] I ran every attack in the challenge and all twelve failed
- [ ] I proved SQL injection works with `FromSqlRaw` and then fixed it
- [ ] I forged a token and confirmed my API rejects it
- [ ] CORS lists explicit origins and exposes `ETag`
- [ ] `gitleaks` and vulnerability scanning fail the build
- [ ] I can explain why an API should not strip HTML from input
:::

## Common mistakes

::: mistake
**`AllowAnyOrigin` with credentials, via `SetIsOriginAllowed`.** Any site can act as your logged-in users.

**`FromSqlRaw` with interpolation.** It looks identical to the safe form and is not.

**Forwarded headers not configured, or not first.** Wrong client IPs, broken rate limiting, redirect loops.

**Sanitising HTML on input.** Destroys data, gives false assurance, and the real fix is output encoding.

**Secrets removed from a repo but not rotated.** Git history is permanent.

**HSTS enabled in development.** Your browser now refuses HTTP on localhost, for months.
:::
