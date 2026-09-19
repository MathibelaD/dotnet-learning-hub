---
title: "Checkpoint: TaskFlow with authentication"
summary: Stage 5 complete — real users, real sessions, and access control you have tried to break.
minutes: 100
stage: Stage 5
---

## What are we learning?

Nothing new. **Stage 5** of the project.

::: stop
Do not mark this complete until every attack in lesson 6's challenge fails.
:::

## The deliverable

```text
POST   /api/auth/register            create an account
POST   /api/auth/login               credentials → access + refresh token
POST   /api/auth/refresh             rotate, with reuse detection
POST   /api/auth/logout              revoke the current session
POST   /api/auth/logout-all          revoke every session
GET    /api/auth/sessions            list active sessions
DELETE /api/auth/sessions/{id}       revoke one
GET    /api/auth/me                  the current user

POST   /api/projects/{id}/members    add a member          (owner or admin)
DELETE /api/projects/{id}/members/{userId}                  (owner or admin)
```

Every existing endpoint is now protected, scoped and tested.

## Requirements

### Identity
- Passwords hashed with a slow salted algorithm; parameters recorded
- Registration race handled by a unique index
- Login timing identical for unknown user and wrong password
- Lockout after repeated failures

### Tokens
- 15-minute access tokens, every validation flag on, `ClockSkew` ≤ 30s
- Opaque refresh tokens, stored hashed, 14-day lifetime
- Rotation on every refresh, with reuse detection revoking the chain
- Refresh token in an httpOnly, Secure, SameSite=Strict, path-scoped cookie
- Maximum 5 concurrent sessions

### Authorization
- Global fallback policy requiring authentication
- Resource-based handlers for task and project operations
- List endpoints scoped in SQL, applied **before** counting and faceting
- Admin bypasses authorization but not domain rules
- 403 vs 404 decided, documented and consistent

### Hardening
- CORS with explicit origins
- Security headers, forwarded headers, HSTS
- No secret in the repository; `gitleaks` in the build
- Dependency vulnerability scan failing the build
- No exception detail in production responses

## Checkpoint

::: checkpoint
- [ ] A new user can register, log in, work, refresh and log out
- [ ] User A cannot see, edit or delete any of user B's data — through any endpoint, filter or page
- [ ] `totalCount` never reveals data the caller cannot see
- [ ] A forged token is rejected
- [ ] An altered payload is rejected
- [ ] A reused refresh token revokes the chain and writes a security event
- [ ] Brute-forcing login is rate limited and locked out
- [ ] All twelve attacks from lesson 6 fail
- [ ] The test matrix covers every user type × every operation
- [ ] `SECURITY.md` and `DECISIONS.md` are complete
:::

::: project Finish Stage 5
```bash
cd ~/taskflow
dotnet test
./scripts/attack.sh                  # your attack script from lesson 6
git commit -am "Stage 5 complete: authentication and authorization"
git tag stage-5
```
:::

::: solution The things that are still not right, and why that is fine
An honest account of what a production system would add, so you can say it before an interviewer asks:

**Email verification.** Right now anyone can register with any address. Real systems send a verification link and restrict unverified accounts. It is not hard — a token, a table, an email — but it needs an email provider, which is Phase 14's territory.

**Password reset.** Same machinery: a single-use, short-lived, hashed token sent by email. The details that matter are that the token is single-use, that requesting a reset for an unknown address gives the same response as a known one, and that a reset revokes every session.

**Multi-factor authentication.** TOTP is roughly 80 lines with `Otp.NET`. It is the single highest-value security addition after password hashing.

**External identity.** In many real systems you would not build any of this — you would use Entra ID, Auth0, Okta or Keycloak, and your API would only *validate* tokens. That is often the right call: identity is a solved problem with expensive failure modes.

**Why build it anyway?** Because you now understand what those providers do, which is what lets you configure them correctly and debug them when they misbehave. "We use Auth0" is not an answer to "how does your authentication work".

**Say this in an interview.** "I implemented password hashing, JWT issuance and refresh-token rotation myself to understand the mechanics, and in production I would evaluate whether an identity provider is a better trade — it usually is, because the failure modes are severe and the problem is not differentiating." That is a more senior answer than either "I built it" or "I used a library".
:::

::: interview Walk me through your authentication
> "Registration hashes the password with PBKDF2 through `PasswordHasher<T>`, with a unique index on the lowercased email so the duplicate-registration race is resolved by the database rather than by a check-then-insert. Login always hashes — against a dummy hash when the user does not exist — so unknown accounts and wrong passwords are indistinguishable in both response and timing.
>
> A successful login issues a 15-minute JWT and an opaque refresh token stored hashed with a 14-day lifetime. Every refresh rotates: new token, old one revoked. If a revoked refresh token is ever presented again, two parties hold it, so I revoke the entire chain and write a security event — that is how token theft gets detected, since you cannot prevent it.
>
> Authorization is mostly resource-based rather than role-based, because the real rules are about a specific task and project. For list endpoints the same rule is a SQL filter applied before the count, so totals cannot leak hidden data. There is a global fallback policy, so a new controller is protected by default.
>
> I wrote an attack script covering cross-user access, id enumeration, user enumeration by timing, token forgery, payload tampering, refresh reuse, SQL injection and over-posting. All of it is in the repository and runs in CI."
:::

::: checkpoint Phase 9 complete
- [ ] Stage 5 is committed and tagged
- [ ] My attack script runs in CI
- [ ] I can explain every security decision and its trade-off
- [ ] I know what I did not build and why
:::
