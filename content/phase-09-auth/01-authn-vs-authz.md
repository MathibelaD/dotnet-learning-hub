---
title: Authentication vs authorization
summary: Two different questions, two different mechanisms, and the pipeline order that ties them together.
minutes: 30
stage: Stage 5
---

## What are we learning?

The distinction that underlies everything in this phase, and how ASP.NET Core models it.

## The two questions

```text
AUTHENTICATION    "Who are you?"           → establishes an identity
                  fails with 401 Unauthorized

AUTHORIZATION     "Are you allowed to?"    → checks permissions
                  fails with 403 Forbidden
```

::: warn 401 and 403 are not interchangeable
**401 Unauthorized** actually means *unauthenticated* — the name is a forty-year-old mistake in the HTTP spec. It means "I do not know who you are; supply credentials." It should carry a `WWW-Authenticate` header.

**403 Forbidden** means "I know exactly who you are, and the answer is no." Re-authenticating will not help.

Returning 403 where 401 belongs makes clients give up instead of refreshing their token. Returning 401 where 403 belongs makes clients loop, re-authenticating forever against a permission they will never have.
:::

## How ASP.NET Core models identity

```csharp
HttpContext.User                    // a ClaimsPrincipal
  └─ Identities                     // usually one ClaimsIdentity
       └─ Claims                    // name/value pairs
```

A **claim** is a statement about the subject:

```csharp
new Claim(ClaimTypes.NameIdentifier, user.Id.ToString())   // "sub"
new Claim(ClaimTypes.Email, user.Email)
new Claim(ClaimTypes.Role, "Manager")
new Claim("projects:read", "true")
new Claim("tenant_id", tenantId.ToString())
```

Identity is **a bag of claims**, not a user object. That is the mental shift: the framework does not know what a `User` is. It knows there is a principal carrying claims, and your authorization rules read those claims.

```csharp
var userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
var isManager = User.IsInRole("Manager");
var authenticated = User.Identity?.IsAuthenticated == true;
```

## The two middlewares

```csharp
app.UseAuthentication();     // reads the token/cookie, populates HttpContext.User
app.UseAuthorization();      // evaluates [Authorize] against HttpContext.User
```

Order is not negotiable. `UseAuthorization` before `UseAuthentication` means `User` is an empty anonymous principal when authorization runs, so every `[Authorize]` fails and nothing tells you why. This is the Phase 6 ordering lesson with the highest-stakes consequence.

## Schemes

An **authentication scheme** is a named strategy for establishing identity.

```csharp
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options => { ... })          // "Bearer"
    .AddCookie("Cookies", options => { ... });
```

| Scheme | Where the identity comes from | Suits |
|---|---|---|
| **JWT Bearer** | `Authorization: Bearer <token>` | APIs, SPAs, mobile |
| **Cookie** | An encrypted cookie the browser sends | Server-rendered web apps |
| **OAuth / OpenID Connect** | An external provider (Google, Entra ID, Auth0) | Delegated identity |
| **API key** | A custom header | Machine-to-machine |

::: design Cookies or tokens?
| | Cookie | JWT |
|---|---|---|
| Sent automatically by the browser | Yes | No — the client adds a header |
| Vulnerable to CSRF | **Yes**, needs anti-forgery tokens | No, because it is not automatic |
| Revocable immediately | Yes (server-side session) | **No** — valid until it expires |
| Works cross-domain | Awkward | Easily |
| Works for mobile and service-to-service | Poorly | Yes |
| Size on every request | Small | 500–1500 bytes |

**The honest advice, which contradicts a lot of tutorials:** if your client is a browser application you control and it is same-site, **cookies are the better default** — httpOnly, secure, SameSite cookies are not readable by JavaScript, so an XSS bug cannot steal them, whereas a JWT in `localStorage` can be exfiltrated in one line.

JWTs win for: mobile clients, service-to-service calls, third-party API consumers, and cross-domain setups.

TaskFlow uses JWT because it is the pattern you will be asked about, and because the API is meant to be consumable by anything. But know the trade-off, and say it out loud in an interview — "I would use httpOnly cookies for a first-party browser app" is an answer that stands out.
:::

## `[Authorize]`

```csharp
[Authorize]                                  // any authenticated user
[Authorize(Roles = "Admin")]                 // a role claim
[Authorize(Roles = "Admin,Manager")]         // either
[Authorize(Policy = "CanEditTask")]          // a named policy (lesson 4)
[AllowAnonymous]                             // opt out
[Authorize(AuthenticationSchemes = "Bearer")]
```

Applied at controller level with `[AllowAnonymous]` on the exceptions, which is the safe direction:

```csharp
[ApiController]
[Authorize]                                  // secure by default
public sealed class TasksController : ControllerBase
{
    [AllowAnonymous]                         // deliberate, visible exception
    [HttpGet("public-stats")]
    public IActionResult Stats() => Ok(...);
}
```

Better still, make it global so a new controller is protected by default:

```csharp
builder.Services.AddAuthorization(options =>
{
    options.FallbackPolicy = new AuthorizationPolicyBuilder()
        .RequireAuthenticatedUser()
        .Build();
});
```

::: warn Secure by default, not by memory
Without a fallback policy, a controller with no `[Authorize]` is **public**. Every codebase that has been around a while has at least one endpoint that was supposed to be protected and was not, because someone added a controller and forgot.

A `FallbackPolicy` inverts the failure mode: forgetting now means "too secure", which someone notices immediately, rather than "wide open", which nobody notices until it matters.
:::

::: exercise Level 1 — Guided · Explore the pipeline
1. Add `AddAuthentication().AddJwtBearer()` with placeholder options, plus the two middlewares.
2. Put `[Authorize]` on one action and call it with no token. Confirm 401 and look at the `WWW-Authenticate` header.
3. Swap the two `Use...` calls, call it again, and observe what changes (and what does not).
4. Add middleware that logs `User.Identity?.IsAuthenticated` and every claim, placed **between** the two. Call an endpoint with and without a token.
5. Add a `FallbackPolicy`. Create a new controller with no attributes and confirm it is protected.
6. Add `[AllowAnonymous]` to your health endpoint and confirm it still works.
:::

::: challenge Level 3 · Design the authorization model
Before writing any code, design TaskFlow's authorization on paper.

Answer for each of these:
1. Who can read a task? A project? A comment?
2. Who can create, edit, delete a task?
3. Who can assign a task, and to whom?
4. Who can archive a project?
5. What can an unauthenticated caller do, if anything?
6. What happens when a user is removed from a project but still has tasks assigned?
7. Is there a super-admin? What can they not do?

Then, for each rule, decide the mechanism: a role check, a policy, a resource-based check, or a domain rule. Write it into `DECISIONS.md` as a table before implementing anything.
:::

::: solution
A workable model:

| Rule | Mechanism | Why |
|---|---|---|
| Read a task | **Resource-based** — is the caller a member of the task's project? | Depends on data, not on the identity alone |
| Create a task | **Resource-based** — member of the project, project not archived | Same |
| Edit a task | **Resource-based** — assignee, project owner, or Admin | Same |
| Delete a task | **Resource-based** — project owner or Admin | Destructive, narrower |
| Assign a task | **Domain rule** — the assignee must be a project member | It is a business invariant, not an access rule |
| Archive a project | **Resource-based** — project owner or Admin | |
| Anything unauthenticated | Health check and OpenAPI only | |
| Removed member with tasks | **Domain rule** — unassign on removal | A data-integrity rule, enforced in the domain |
| Admin | A role claim, bypasses resource checks but **not** domain rules | An admin still cannot complete a cancelled task |

The distinction that matters, and the one candidates usually miss:

- **Authorization** answers "may this caller perform this operation on this resource?" → 403.
- **Domain rules** answer "is this operation valid at all?" → 409/422.

An admin can bypass authorization. An admin cannot bypass a domain invariant, because the invariant is about the data being correct, not about permission. If your admin path skips domain methods to "just force it", you have built a way to corrupt your own data — and someone will use it.

Notice also how few of these are role checks. **Real authorization is mostly resource-based**, because the question is almost always "this user and *this* object", not "this user". Lesson 4 implements that.
:::

::: project Prepare TaskFlow for auth
1. `AddAuthentication`/`AddAuthorization` with both middlewares in the right order.
2. A global `FallbackPolicy` requiring authentication.
3. `[AllowAnonymous]` on health and OpenAPI only.
4. A `User` entity with `Email`, `PasswordHash`, `Role` and `DisplayName` (the hash is filled in next lesson).
5. A `ProjectMember` join entity: project, user, role within the project.
6. The authorization design table in `DECISIONS.md`.
7. `ICurrentUser` in Application (`Guid? UserId`, `bool IsAuthenticated`, `IReadOnlyList<string> Roles`), implemented in Infrastructure from `IHttpContextAccessor`, so application code never touches `HttpContext`.

Point 7 is the one that keeps your architecture intact. Commit.
:::

::: interview What is the difference between authentication and authorization?
Authentication establishes who the caller is — validating a token, a cookie or credentials and producing an identity. Authorization decides whether that identity may perform a particular operation. They fail differently: 401 for unauthenticated, which means "supply credentials", and 403 for forbidden, which means "I know who you are and the answer is no".

In ASP.NET Core they are separate middlewares and the order is fixed: `UseAuthentication` populates `HttpContext.User`, and `UseAuthorization` evaluates policies against it. Reversing them makes every request look anonymous.

Identity itself is modelled as a `ClaimsPrincipal` — a bag of claims rather than a user object — which is what lets the same authorization code work whether the identity came from a JWT, a cookie or an external provider.
:::

::: checkpoint
- [ ] I can state exactly what 401 and 403 each mean
- [ ] I know why `UseAuthentication` must come first
- [ ] A `FallbackPolicy` protects new controllers by default
- [ ] I designed the authorization model before writing code
- [ ] I can explain why an admin may bypass authorization but not domain rules
:::

## Common mistakes

::: mistake
**403 where 401 belongs.** Clients stop retrying instead of refreshing.

**Middleware in the wrong order.** Everything is 401 and nothing explains it.

**No fallback policy.** A forgotten `[Authorize]` is a public endpoint.

**Treating authorization as only roles.** Most real rules are about a specific resource.

**Admin paths that bypass domain rules.** A supported route to corrupt your data.
:::
