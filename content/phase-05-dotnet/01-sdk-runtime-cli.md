---
title: SDK, runtime and the dotnet CLI
summary: What is actually installed on your machine, and driving all of it from the terminal.
minutes: 35
stage: Stage 2
---

## What are we learning?

The difference between the SDK and the runtime, how version selection works, and the `dotnet` commands you will use for the rest of your career.

## SDK versus runtime

```text
.NET SDK
├── the runtime (so you can run things)
├── the Roslyn compiler
├── MSBuild
├── the dotnet CLI (new, build, test, publish, …)
└── templates

.NET Runtime
└── just enough to execute an already-compiled application
```

Developers install the **SDK**. Servers need only the **runtime** — or nothing at all, if you publish self-contained (below).

```bash
dotnet --version        # the SDK version being used right now
dotnet --list-sdks      # everything installed
dotnet --list-runtimes  # runtimes, in three families
dotnet --info           # all of it, plus the RID
```

`--list-runtimes` shows three families and it is worth knowing which is which:

| Family | Contains |
|---|---|
| `Microsoft.NETCore.App` | the base runtime — every app needs it |
| `Microsoft.AspNetCore.App` | the web stack, shipped as a shared framework |
| `Microsoft.WindowsDesktop.App` | WPF and WinForms, Windows only |

## Version selection

Two independent questions:

**Which SDK builds my code?** Controlled by `global.json` at or above your project directory:

```json
{
  "sdk": {
    "version": "10.0.400",
    "rollForward": "latestFeature"
  }
}
```

Without it, the newest installed SDK is used. On a team, pin it — otherwise a colleague with a newer SDK can produce builds yours cannot reproduce.

**Which runtime runs my app?** Controlled by `<TargetFramework>` in the `.csproj`:

```xml
<TargetFramework>net10.0</TargetFramework>
```

At run time, .NET *rolls forward* to the newest installed patch of that major version. So an app built for `net10.0` runs on 10.0.7 if that is what is installed — but not on `net9.0`.

::: note LTS versus STS
Even-numbered releases (8, 10) are **LTS**: supported for 3 years. Odd-numbered (7, 9) are **STS**: 18 months. For anything you will still be running next year, target LTS. We use .NET 10.
:::

## The commands

```bash
# create
dotnet new list                      # all templates
dotnet new console -o src/MyApp
dotnet new classlib -o src/MyLib
dotnet new webapi -o src/MyApi
dotnet new xunit -o tests/MyApp.Tests
dotnet new sln -n MySolution
dotnet new gitignore
dotnet new editorconfig

# wire up
dotnet sln add src/MyApp src/MyLib
dotnet add src/MyApp reference src/MyLib
dotnet add src/MyApp package Serilog

# build and run
dotnet restore                       # fetch packages (implicit in build/run since .NET 6)
dotnet build                         # compile
dotnet build -c Release
dotnet run --project src/MyApp
dotnet run --project src/MyApp -- --my-arg value     # note the --
dotnet watch --project src/MyApp     # rebuild + rerun on save
dotnet test
dotnet clean

# ship
dotnet publish -c Release -o out
dotnet publish -c Release -r linux-x64 --self-contained

# inspect
dotnet list src/MyApp package
dotnet list src/MyApp package --outdated
dotnet list src/MyApp package --vulnerable
dotnet nuget locals all --list
```

## `publish` and its modes

```bash
# framework-dependent (default): small output, requires the runtime on the target
dotnet publish -c Release
# → ~200 KB plus your dependencies

# self-contained: includes the runtime, runs anywhere with no .NET installed
dotnet publish -c Release -r linux-x64 --self-contained
# → ~70 MB

# single file
dotnet publish -c Release -r linux-x64 --self-contained -p:PublishSingleFile=true

# trimmed: removes unused framework code
dotnet publish -c Release -r linux-x64 --self-contained \
  -p:PublishSingleFile=true -p:PublishTrimmed=true
# → ~30 MB, but trimming can break reflection-based code

# Native AOT: compiled ahead of time to native code
dotnet publish -c Release -r linux-x64 -p:PublishAot=true
# → fast startup, small memory, no JIT; many libraries are incompatible
```

For a Docker deployment (Phase 15), framework-dependent publishing onto a runtime base image is usually the right default: the image layers are shared and rebuilds are fast.

## Global tools

```bash
dotnet tool install -g dotnet-ef              # EF Core CLI — Phase 7
dotnet tool install -g dotnet-outdated-tool
dotnet tool install -g dotnet-counters        # live performance counters — Phase 14
dotnet tool list -g
```

Or per-repository, which is better for teams because the version is committed:

```bash
dotnet new tool-manifest
dotnet tool install dotnet-ef
dotnet tool restore        # what a new team member runs
dotnet ef --version        # uses the local manifest version
```

::: exercise Level 1 — Guided · Drive the CLI
Build a complete multi-project solution from nothing, using only the terminal. No IDE.

```bash
mkdir -p ~/dotnet-scratch/cli-practice && cd ~/dotnet-scratch/cli-practice

dotnet new sln -n Practice
dotnet new classlib -o src/Practice.Core
dotnet new console  -o src/Practice.Cli
dotnet new xunit    -o tests/Practice.Tests

dotnet sln add src/Practice.Core src/Practice.Cli tests/Practice.Tests
dotnet add src/Practice.Cli reference src/Practice.Core
dotnet add tests/Practice.Tests reference src/Practice.Core

dotnet build
dotnet test
```

Then:
1. Add a class to `Practice.Core` and use it from `Practice.Cli`. Build.
2. Write a failing test. Run `dotnet test` and read the output properly.
3. Fix it. Run again.
4. `dotnet publish src/Practice.Cli -c Release -o out` and run the output directly.
5. Publish self-contained and compare the two output directory sizes with `du -sh`.
6. Add `global.json` pinning your SDK version, then temporarily change the version to `9.0.100` and see what `dotnet build` says.
:::

::: challenge Level 3 · A build script
Write `build.sh` for the practice solution that:

1. Fails immediately on any error (`set -euo pipefail`).
2. Restores, builds in Release, runs tests, and publishes.
3. Fails the build on any compiler warning.
4. Prints a timing summary per step.
5. Accepts `--skip-tests` and `--version X.Y.Z` (passed to the build as a property).
6. Writes test results to a file that a CI system could read (`--logger "trx;LogFileName=results.trx"`).

Then answer: what is the difference between `dotnet build` and `dotnet msbuild`, and why does `dotnet build` take a `-p:` flag at all?
:::

::: solution
```bash
#!/usr/bin/env bash
set -euo pipefail

VERSION="1.0.0"
SKIP_TESTS=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-tests) SKIP_TESTS=true; shift ;;
    --version)    VERSION="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
done

step() {
  local name="$1"; shift
  local start=$SECONDS
  echo "── $name"
  "$@"
  echo "   ${name} took $((SECONDS - start))s"
}

step restore dotnet restore
step build   dotnet build -c Release --no-restore \
                 -p:Version="$VERSION" -p:TreatWarningsAsErrors=true
$SKIP_TESTS || step test dotnet test -c Release --no-build \
                 --logger "trx;LogFileName=results.trx" --results-directory ./artifacts
step publish dotnet publish src/Practice.Cli -c Release --no-build -o ./artifacts/app
```

`--no-restore` and `--no-build` matter: without them each step redoes the previous one's work, and a four-step script does the build three times.

**`dotnet build` vs `dotnet msbuild`:** `dotnet build` is a friendly wrapper that invokes MSBuild with a sensible target and argument set. `dotnet msbuild` exposes MSBuild directly, so you can invoke arbitrary targets (`dotnet msbuild -t:Pack`) and see the full evaluation.

`-p:` passes an **MSBuild property**, which is the same mechanism a `<PropertyGroup>` in the `.csproj` uses — command line wins over the file. That is how CI systems inject a version number without editing files, and it is why you can flip `TreatWarningsAsErrors` on for CI while leaving it off locally.
:::

::: project Restructure TaskFlow into a solution
This is **Stage 2** of the project. Your code is currently one console project. Split it.

```bash
cd ~/taskflow

dotnet new sln -n TaskFlow
dotnet new classlib -o src/TaskFlow.Domain
dotnet new classlib -o src/TaskFlow.Application
dotnet new xunit    -o tests/TaskFlow.Domain.Tests

dotnet sln add src/TaskFlow.Domain src/TaskFlow.Application src/TaskFlow.Console tests/TaskFlow.Domain.Tests
dotnet add src/TaskFlow.Application reference src/TaskFlow.Domain
dotnet add src/TaskFlow.Console reference src/TaskFlow.Application
dotnet add tests/TaskFlow.Domain.Tests reference src/TaskFlow.Domain
```

Then move the code:
- `TaskItem`, `Project`, `User`, `Comment`, enums, `TaskRules`, exceptions, value objects → **Domain**
- `ITaskStore`, `InMemoryStore`, `TaskSearch`, `TaskQuery`, importers/exporters → **Application**
- The CLI, argument parsing, `Program.cs` → **Console**

Delete the default `Class1.cs` files. Fix every namespace. Build until clean.

Then verify the dependency direction is what you intended:
```bash
dotnet list src/TaskFlow.Domain reference     # should print NOTHING
```

**The Domain project must reference nothing.** If it does, something has leaked. That rule is the entire basis of Phase 8's architecture, and enforcing it now costs nothing.

Add a `global.json` pinning your SDK, and commit.
:::

::: interview What is the difference between the .NET SDK and the .NET runtime?
The runtime is what executes a compiled application: the CLR, the JIT, the garbage collector and the base class library. The SDK contains the runtime plus everything needed to *produce* an application — the Roslyn compiler, MSBuild, the `dotnet` CLI and the project templates.

Developers install the SDK; a server that only runs a framework-dependent application needs just the runtime, and needs none of it at all if you publish self-contained.

Worth adding: the SDK version used for a build can be pinned with `global.json`, while the runtime an app requires comes from `<TargetFramework>` and rolls forward across patch versions within the same major.
:::

::: checkpoint
- [ ] I built a three-project solution from the terminal with no IDE
- [ ] I can explain framework-dependent vs self-contained publishing and the size difference
- [ ] I pinned an SDK version with `global.json` and saw what a mismatch reports
- [ ] I wrote a build script with `--no-restore`/`--no-build` used correctly
- [ ] TaskFlow is a solution, and `TaskFlow.Domain` references nothing
:::

## Common mistakes

::: mistake
**Installing the runtime and wondering why `dotnet new` is missing.** You need the SDK.

**Forgetting `--` before your app's arguments.** `dotnet run --project X --verbose` passes `--verbose` to `dotnet run`, not to your app.

**Committing `bin/` and `obj/`.** `dotnet new gitignore` in every repo.

**No `global.json` on a team.** Two developers, two SDK versions, one unreproducible build.

**Rebuilding at every step of a CI script.** `--no-restore` and `--no-build` exist for this.
:::
