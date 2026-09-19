---
title: Passwords and registration
summary: Storing credentials so that a database breach is survivable.
minutes: 40
stage: Stage 5
---

## What are we learning?

Password hashing done correctly, and the details around registration and login that matter more than the algorithm choice.

## Never store a password

Not in plain text. Not encrypted (you hold the key; an attacker who has your database probably has your configuration too). Not with a fast hash like MD5, SHA-1 or SHA-256.

**Hash with a slow, salted, purpose-built algorithm.**

| Algorithm | Verdict |
|---|---|
| Plain text | Criminal negligence |
| MD5 / SHA-1 | Broken; billions of guesses per second on a GPU |
| SHA-256 | Not broken, but far too fast — designed for speed, which is the opposite of what you want |
| PBKDF2 | Acceptable. In the BCL. What ASP.NET Identity uses |
| bcrypt | Good. Widely available |
| scrypt | Good. Memory-hard |
| **Argon2id** | Best current choice. Memory-hard, resists GPU and ASIC attacks |

::: why Why slowness is the feature
If your database leaks, an attacker has the hashes and can guess offline, as fast as their hardware allows.

- SHA-256: roughly 10 billion guesses per second on a modern GPU. Every password on a common list falls in seconds.
- Argon2id tuned to 100ms per hash with 64 MB of memory: perhaps 10 guesses per second per core, and the memory requirement makes massive GPU parallelism impractical.

That is the difference between "every account compromised by morning" and "only genuinely weak passwords at risk".

**The salt** is a unique random value per password, stored alongside the hash. It means identical passwords produce different hashes, so an attacker cannot crack one and unlock many, and precomputed rainbow tables are useless.
:::

## Using the built-in hasher

.NET ships a solid PBKDF2 implementation, already salted and versioned:

```csharp
using Microsoft.AspNetCore.Identity;

var hasher = new PasswordHasher<User>();

// registration
user.SetPasswordHash(hasher.HashPassword(user, plainPassword));

// login
var result = hasher.VerifyHashedPassword(user, user.PasswordHash, attemptedPassword);
if (result is PasswordVerificationResult.Failed) return Unauthorized();

if (result is PasswordVerificationResult.SuccessRehashNeeded)
    user.SetPasswordHash(hasher.HashPassword(user, attemptedPassword));   // upgrade transparently
```

`SuccessRehashNeeded` is the detail people skip: it means the stored hash used older parameters, and you should re-hash with the current ones. Handling it lets you strengthen your parameters over time without forcing a password reset.

Using `PasswordHasher<T>` requires only `Microsoft.Extensions.Identity.Core`, not the whole ASP.NET Identity stack with its `DbContext` and twelve tables.

## Argon2id

```bash
dotnet add package Konscious.Security.Cryptography.Argon2
```

```csharp
public sealed class Argon2PasswordHasher : IPasswordHasher
{
    private const int SaltSize = 16, HashSize = 32;
    private const int Iterations = 3, MemoryKb = 65536, Parallelism = 2;

    public string Hash(string password)
    {
        var salt = RandomNumberGenerator.GetBytes(SaltSize);
        var hash = Derive(password, salt);
        return $"$argon2id$v=19$m={MemoryKb},t={Iterations},p={Parallelism}${Convert.ToBase64String(salt)}${Convert.ToBase64String(hash)}";
    }

    public bool Verify(string password, string encoded)
    {
        var parts = encoded.Split('$');
        var salt = Convert.FromBase64String(parts[4]);
        var expected = Convert.FromBase64String(parts[5]);
        var actual = Derive(password, salt);
        return CryptographicOperations.FixedTimeEquals(actual, expected);
    }

    private static byte[] Derive(string password, byte[] salt) =>
        new Argon2id(Encoding.UTF8.GetBytes(password))
        {
            Salt = salt, DegreeOfParallelism = Parallelism,
            Iterations = Iterations, MemorySize = MemoryKb
        }.GetBytes(HashSize);
}
```

::: warn `CryptographicOperations.FixedTimeEquals`, not `==`
A normal byte comparison returns as soon as it finds a difference. An attacker who can measure response times can learn how many leading bytes they got right, and recover the hash byte by byte. That is a **timing attack**, and it is practical over a local network.

`FixedTimeEquals` always takes the same time. Use it for any comparison of secrets: password hashes, API keys, HMAC signatures, tokens.
:::

The parameters (`m`, `t`, `p`) are stored **in the hash string**, which is what lets you verify old hashes after changing your settings.

## Registration

```csharp
public async Task<Result<User>> RegisterAsync(RegisterCommand command, CancellationToken ct)
{
    var email = command.Email.Trim().ToLowerInvariant();

    if (await users.ExistsAsync(email, ct))
        return Result<User>.Failure("An account with that email already exists.");

    var user = User.Register(email, command.DisplayName, hasher.Hash(command.Password), clock);
    await users.AddAsync(user, ct);
    await uow.SaveChangesAsync(ct);
    return user;
}
```

::: warn The duplicate-email check has three problems
**1. A race.** Two simultaneous registrations both pass the check and both insert. Fix with a **unique index** on `email` and by handling the resulting `DbUpdateException` — the database is the only place that can make this atomic.

**2. User enumeration.** "An account with that email already exists" tells an attacker which addresses are registered. The privacy-preserving approach is to always return "check your email", and send either a verification link or a "someone tried to register with your address" notice. Whether that is worth the usability cost is a product decision — but it must be a decision.

**3. Email normalisation.** `Sam@Example.COM` and `sam@example.com` are the same mailbox. Lowercase and trim on the way in, and make the unique index match (`citext`, or a lowercased column).
:::

## Password policy

```csharp
RuleFor(x => x.Password)
    .NotEmpty()
    .MinimumLength(12).WithMessage("Use at least 12 characters.")
    .MaximumLength(256)
    .Must(NotBeCommon).WithMessage("That password is too common. Choose something less predictable.");
```

::: design What the current guidance actually says
NIST SP 800-63B, which is the modern reference, says:

**Do:**
- Require a minimum length of 8, and encourage much longer.
- Accept **all** printable characters including spaces and emoji.
- Allow at least 64 characters, so passphrases and password managers work.
- Check against a list of known-breached passwords.
- Support paste, so password managers work.

**Do not:**
- Require composition rules ("one uppercase, one digit, one symbol"). They push people toward `Password1!` and reduce real entropy.
- Force periodic expiry without evidence of compromise. It produces `Summer2026!` → `Autumn2026!`.
- Impose a low maximum length. Anything under 64 characters signals that you are not hashing properly.
- Use security questions. Mother's maiden name is public information.

A length floor plus a breached-password check beats composition rules comprehensively. `HaveIBeenPwned`'s k-anonymity API lets you check without sending the password: hash it with SHA-1, send the first five characters of the hash, and match the remainder locally against what comes back.
:::

::: exercise Level 1 — Guided · Implement registration
1. Add `PasswordHash` to `User` with a `private set`, only settable through `User.Register` and `ChangePassword`.
2. Implement `IPasswordHasher` with `PasswordHasher<User>`.
3. `POST /api/auth/register` with FluentValidation.
4. A unique index on lowercased email, and handle the `DbUpdateException` race.
5. Register the same email twice concurrently (two parallel requests) and confirm exactly one succeeds.
6. Print two hashes of the same password and confirm they differ — that is the salt.
7. Time `hasher.HashPassword` and confirm it takes between 50ms and 250ms. If it is under 10ms, your parameters are too weak.
:::

::: challenge Level 3 · Login, done properly
Implement `POST /api/auth/login` with every detail right.

Requirements:
1. Returns the same response and takes the same time for "no such user" and "wrong password" — no enumeration through messages or timing.
2. Rate limited per IP **and** per account.
3. Account lockout after 5 failures within 15 minutes, with exponential backoff.
4. A successful login clears the failure count.
5. Never logs the password, and never logs the full email at `Information`.
6. Timing-safe comparison throughout.
7. `SuccessRehashNeeded` upgrades the stored hash transparently.
8. A test proving that "unknown user" and "wrong password" are indistinguishable in both response and timing.
:::

::: solution
The timing requirement is the interesting one:

```csharp
public async Task<Result<User>> LoginAsync(string email, string password, CancellationToken ct)
{
    var user = await users.FindByEmailAsync(email.Trim().ToLowerInvariant(), ct);

    // ALWAYS hash, even when the user does not exist, so the timing is identical.
    var hashToVerify = user?.PasswordHash ?? DummyHash;
    var result = hasher.VerifyHashedPassword(user ?? DummyUser, hashToVerify, password);

    if (user is null || result is PasswordVerificationResult.Failed)
    {
        await failures.RecordAsync(email, ct);
        return Result<User>.Failure("Invalid email or password.");
    }

    if (await failures.IsLockedOutAsync(email, ct))
        return Result<User>.Failure("Too many attempts. Try again later.");

    if (result is PasswordVerificationResult.SuccessRehashNeeded)
    {
        user.SetPasswordHash(hasher.HashPassword(user, password));
        await uow.SaveChangesAsync(ct);
    }

    await failures.ClearAsync(email, ct);
    return user;
}

private static readonly string DummyHash = new PasswordHasher<User>()
    .HashPassword(DummyUser, "not-a-real-password");
```

`DummyHash` computed once at startup is the whole trick. Without it, an unknown email returns in 2ms while a known one takes 150ms, and an attacker can enumerate your entire user base by measuring response times — no responses needed beyond the timing.

The lockout check placed *after* verification is deliberate: checking first and returning early would reintroduce a timing difference between locked and unlocked accounts.

The test:
```csharp
[Fact]
public async Task Unknown_user_and_wrong_password_are_indistinguishable()
{
    var unknown = await Time(() => client.PostAsJsonAsync("/api/auth/login",
        new { email = "nobody@example.com", password = "whatever" }));
    var wrong = await Time(() => client.PostAsJsonAsync("/api/auth/login",
        new { email = "known@example.com", password = "wrong" }));

    Assert.Equal(unknown.Status, wrong.Status);
    Assert.Equal(unknown.Body, wrong.Body);
    Assert.True(Math.Abs(unknown.Ms - wrong.Ms) < 30,
        $"Timing differs: {unknown.Ms}ms vs {wrong.Ms}ms — enumeration is possible.");
}
```

Run it 20 times and compare medians; a single measurement is too noisy to be meaningful.
:::

::: project Registration and login for TaskFlow
1. `IPasswordHasher` abstraction in Domain, implementation in Infrastructure.
2. `POST /api/auth/register` and `POST /api/auth/login` (login returns the user for now; tokens come next lesson).
3. Unique index on lowercased email, race handled.
4. Password validation following NIST guidance, with a breached-password check.
5. Timing-safe login with a dummy hash.
6. Lockout after repeated failures.
7. A test proving indistinguishability.
8. `DECISIONS.md`: your hashing algorithm, parameters, and how you would change them later.

Commit.
:::

::: interview How do you store passwords securely?
You never store the password. You store a hash produced by a deliberately slow, salted, memory-hard algorithm — Argon2id is the current best choice, with bcrypt and PBKDF2 acceptable. Each password gets a unique random salt stored alongside the hash, so identical passwords hash differently and precomputed tables are useless.

Slowness is the point: a fast hash like SHA-256 allows billions of offline guesses per second against a leaked database, whereas Argon2id tuned to around 100ms with 64MB of memory allows a handful per core and resists GPU parallelism.

Two details I would add: compare hashes with a constant-time function, because a normal comparison leaks information through timing; and on login, hash a dummy value when the user does not exist, so an unknown email takes the same time as a wrong password and the user base cannot be enumerated by timing alone.
:::

::: checkpoint
- [ ] Two hashes of the same password differ
- [ ] Hashing takes between 50 and 250ms
- [ ] Login timing is identical for unknown user and wrong password — proved by a test
- [ ] Concurrent registration with the same email produces exactly one account
- [ ] My password policy follows NIST guidance, not composition rules
:::

## Common mistakes

::: mistake
**SHA-256 for passwords.** Fast is exactly wrong.

**A single application-wide salt, or no salt.** One crack unlocks every identical password.

**`==` on hashes.** Timing attack.

**"Email not found" vs "wrong password".** Free user enumeration.

**Composition rules and forced expiry.** Measurably worse passwords, per current guidance.

**A maximum password length under 64.** A reliable signal that something is being stored wrong.
:::
