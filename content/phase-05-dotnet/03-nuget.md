---
title: NuGet and dependency management
summary: Adding packages, pinning versions centrally, and treating dependencies as a liability you manage.
minutes: 30
stage: Stage 2
---

## What are we learning?

How packages get onto your machine and into your build, how to control versions across a solution, and how to keep the dependency list from becoming a security problem.

## The basics

```bash
dotnet add package Serilog                      # latest stable
dotnet add package Serilog --version 4.1.0      # pinned
dotnet add package Serilog --prerelease
dotnet remove package Serilog
dotnet list package
dotnet list package --outdated
dotnet list package --vulnerable --include-transitive
dotnet list package --deprecated
```

Which writes:

```xml
<PackageReference Include="Serilog" Version="4.1.0" />
```

Packages are downloaded to a global cache (`~/.nuget/packages`), not into your project. There is no `node_modules`. Several projects on your machine share one copy of a given version.

## Version ranges

```xml
<PackageReference Include="X" Version="4.1.0" />       <!-- minimum 4.1.0; resolves to the lowest available ≥ that -->
<PackageReference Include="X" Version="[4.1.0]" />     <!-- exactly 4.1.0 -->
<PackageReference Include="X" Version="[4.0,5.0)" />   <!-- ≥4.0 and <5.0 -->
<PackageReference Include="X" Version="4.*" />         <!-- floating — avoid -->
```

::: warn A bare version is a minimum, not a pin
`Version="4.1.0"` means "at least 4.1.0". NuGet resolves to the *lowest* version satisfying all constraints, so in practice you usually get exactly 4.1.0 — but a transitive dependency demanding 4.3.0 silently upgrades you.

The reliable answer is a **lock file**:
```xml
<RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>
```
This produces `packages.lock.json`, which you commit. Then:
```bash
dotnet restore --locked-mode    # fails if anything would change
```
Use `--locked-mode` in CI. It turns "our build broke and nobody changed anything" into an explicit, reviewable diff.
:::

## Central Package Management

With more than two projects, versions drift. Fix it in one file.

`Directory.Packages.props` at the repository root:

```xml
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
    <CentralPackageTransitivePinningEnabled>true</CentralPackageTransitivePinningEnabled>
  </PropertyGroup>

  <ItemGroup>
    <PackageVersion Include="Microsoft.EntityFrameworkCore" Version="10.0.0" />
    <PackageVersion Include="Npgsql.EntityFrameworkCore.PostgreSQL" Version="10.0.0" />
    <PackageVersion Include="Serilog.AspNetCore" Version="9.0.0" />
    <PackageVersion Include="FluentValidation" Version="12.0.0" />
    <PackageVersion Include="xunit" Version="2.9.2" />
    <PackageVersion Include="NSubstitute" Version="5.3.0" />
  </ItemGroup>
</Project>
```

Individual projects then reference without a version:

```xml
<PackageReference Include="Serilog.AspNetCore" />
```

One place to upgrade, no possibility of two projects using different versions of the same library — which is the cause of a whole family of confusing runtime errors.

## Transitive dependencies

```bash
dotnet list package --include-transitive
```

You depend on far more than you think. A single web API package can pull in fifty. `CentralPackageTransitivePinningEnabled` lets you pin a transitive dependency's version from the central file, which is how you patch a vulnerable library that you do not reference directly.

## Choosing a dependency

::: design Before you run `dotnet add package`
Every dependency is a permanent liability: a supply-chain risk, an upgrade obligation, and code you did not write but will have to debug.

Ask:
1. **Is it in the BCL already?** .NET has a great deal built in. `System.Text.Json` instead of Newtonsoft. `HttpClient` instead of RestSharp. `System.Threading.RateLimiting` instead of a package.
2. **How much of it will I use?** Pulling in a 200-type library for one helper method is a bad trade. Write the method.
3. **Is it maintained?** Check the last release date, open issue count, and whether it supports the current .NET version. A package whose last release targeted .NET 6 will work, and will become a problem.
4. **How many transitive dependencies does it drag in?** Look on nuget.org before installing.
5. **Who owns it?** `Microsoft.*` and well-known community packages (Serilog, Polly, FluentValidation, xUnit, NSubstitute, Npgsql) are safe bets. A package with 4,000 downloads and one contributor is a risk.

The packages this course uses, and why each earns its place:
| Package | Why not do it myself |
|---|---|
| `Npgsql.EntityFrameworkCore.PostgreSQL` | A database driver. Obviously. |
| `Serilog` | Structured logging with sinks. The built-in `ILogger` needs a provider. |
| `FluentValidation` | Validation rules as testable code; DataAnnotations runs out quickly. |
| `Polly` | Retry, circuit breaker, timeout — easy to write badly. |
| `xunit`, `NSubstitute` | Testing. Not optional. |
| `Testcontainers` | Real PostgreSQL in tests, disposed automatically. |

That is a short list on purpose.
:::

## Security

```bash
dotnet list package --vulnerable --include-transitive
```

Run it in CI and fail the build on anything found:

```xml
<PropertyGroup>
  <NuGetAuditMode>all</NuGetAuditMode>      <!-- include transitive -->
  <NuGetAuditLevel>moderate</NuGetAuditLevel>
  <WarningsAsErrors>$(WarningsAsErrors);NU1901;NU1902;NU1903;NU1904</WarningsAsErrors>
</PropertyGroup>
```

NuGet audit is built in since .NET 8 — it checks the GitHub Advisory Database during restore. Turning those warnings into errors means a known-vulnerable dependency cannot reach production silently.

::: exercise Level 1 — Guided · Set up dependency management
In TaskFlow:

1. Create `Directory.Packages.props` with central management enabled and the packages listed above.
2. Add `xunit` and `NSubstitute` to the test project — with no version attribute — and confirm it builds.
3. Run `dotnet list package --include-transitive` and count the total.
4. Enable lock files, restore, and inspect `packages.lock.json`. Commit it.
5. Change a version in `Directory.Packages.props` and run `dotnet restore --locked-mode`. Read the error.
6. Regenerate with `dotnet restore --force-evaluate`.
7. Turn on NuGet audit at error level and build.
:::

::: challenge Level 3 · Audit and justify
For your TaskFlow solution:

1. Produce the full transitive dependency list.
2. For every **direct** dependency, write one sentence in `DECISIONS.md`: what it does, and what you would have to write yourself without it.
3. Find one dependency you could remove, and remove it.
4. Add `dotnet list package --vulnerable` to a CI script that exits non-zero on any finding.
5. Deliberately add a known-vulnerable old package (`Newtonsoft.Json 12.0.1` is a reliable example), confirm the audit catches it, then remove it.

The habit this builds — knowing what every dependency is for — is one that interviewers probe and most candidates fail.
:::

::: project TaskFlow's dependency policy
Commit `Directory.Packages.props`, `packages.lock.json` and a short `DEPENDENCIES.md` stating:

- The rule for adding a dependency (who decides, what is checked).
- The current list with one-line justifications.
- The upgrade cadence.

Three paragraphs is enough. The point is that you have thought about it and can say so.

Commit.
:::

::: interview How do you manage NuGet package versions across a large solution?
Central Package Management: a `Directory.Packages.props` at the repository root declares every version once with `PackageVersion` elements, and individual projects reference packages with no version attribute. That removes version drift between projects, which is a common source of runtime binding problems.

Beyond that: a bare `Version="1.2.3"` is a *minimum*, not a pin, so transitive constraints can move you — lock files with `dotnet restore --locked-mode` in CI make dependency changes explicit and reviewable. And NuGet's built-in audit, with `NuGetAuditMode` set to `all` and the NU19xx warnings promoted to errors, fails the build on known vulnerabilities including transitive ones.
:::

::: checkpoint
- [ ] TaskFlow uses central package management
- [ ] A lock file is committed and `--locked-mode` is used in my build script
- [ ] I can list every direct dependency and justify it
- [ ] NuGet audit fails the build on a vulnerable package — I proved it
- [ ] I removed at least one dependency I did not need
:::

## Common mistakes

::: mistake
**Assuming `Version="1.0.0"` pins the version.** It is a minimum.

**Different versions of the same package across projects.** Causes `MethodNotFoundException` at runtime with a stack trace that points nowhere useful.

**Adding a package for one helper method.** Write the method.

**Floating versions (`4.*`) in production.** Your build is not reproducible and can break without any commit.

**Never running `--vulnerable`.** Transitive dependencies are the most common supply-chain exposure and they are invisible unless you look.
:::
