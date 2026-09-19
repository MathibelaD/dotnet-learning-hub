---
title: A production Dockerfile for .NET
summary: Multi-stage builds, small secure images, and the details that matter in a container.
minutes: 40
stage: Stage 8
---

## What are we learning?

Writing a Dockerfile you would be happy to deploy: small, cached, non-root, and correct about signals.

## The naive version, and why it is wrong

```dockerfile
FROM mcr.microsoft.com/dotnet/sdk:10.0
WORKDIR /app
COPY . .
RUN dotnet publish -c Release -o out
ENTRYPOINT ["dotnet", "out/TaskFlow.Api.dll"]
```

It works, and it ships the **SDK** — around 900 MB containing a compiler, MSBuild, NuGet, your source code and your git history. In production that is wasted bandwidth, wasted disk, a large attack surface, and your source code sitting on a server.

## Multi-stage

```dockerfile
# syntax=docker/dockerfile:1

# ---- build ----
FROM mcr.microsoft.com/dotnet/sdk:10.0-alpine AS build
WORKDIR /src

# 1. Copy ONLY the project files first, so restore is cached.
COPY Directory.Build.props Directory.Packages.props global.json ./
COPY src/TaskFlow.Domain/*.csproj          src/TaskFlow.Domain/
COPY src/TaskFlow.Application/*.csproj     src/TaskFlow.Application/
COPY src/TaskFlow.Infrastructure/*.csproj  src/TaskFlow.Infrastructure/
COPY src/TaskFlow.Api/*.csproj             src/TaskFlow.Api/

RUN --mount=type=cache,target=/root/.nuget/packages \
    dotnet restore src/TaskFlow.Api/TaskFlow.Api.csproj

# 2. Now the source, which changes on every commit.
COPY src/ src/

ARG VERSION=1.0.0
RUN --mount=type=cache,target=/root/.nuget/packages \
    dotnet publish src/TaskFlow.Api/TaskFlow.Api.csproj \
      -c Release -o /app/publish \
      --no-restore \
      -p:Version=${VERSION} \
      -p:UseAppHost=false

# ---- runtime ----
FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine AS final
WORKDIR /app

RUN adduser --disabled-password --no-create-home --uid 10001 appuser
USER appuser

COPY --from=build --chown=appuser:appuser /app/publish .

ENV ASPNETCORE_URLS=http://+:8080 \
    ASPNETCORE_ENVIRONMENT=Production \
    DOTNET_gcServer=1 \
    DOTNET_EnableDiagnostics=0

EXPOSE 8080

ENTRYPOINT ["dotnet", "TaskFlow.Api.dll"]
```

::: why What each decision buys you
**Multi-stage.** The final image contains only the runtime and your published output — the SDK, source and intermediate files stay in the build stage and are discarded. 900 MB becomes about 110 MB.

**Copying `.csproj` files before the source.** The restore layer is cached until dependencies change. A code-only commit rebuilds in seconds.

**`--mount=type=cache` for NuGet.** BuildKit keeps the package cache across builds, so even a dependency change does not re-download everything.

**Alpine.** Roughly 110 MB against 210 MB for the Debian-based image. Caveats: musl libc rather than glibc, which occasionally breaks native dependencies, and no ICU unless you add it — see globalization below.

**Non-root user.** A container escape from a root process is a root process on the host. This is one line and it removes an entire class of escalation. The `chown` on `COPY` avoids a separate `RUN chown`, which would duplicate the whole layer.

**`UseAppHost=false`.** Skips producing a native executable you do not need, since the entrypoint invokes `dotnet` explicitly. A few megabytes.

**`DOTNET_EnableDiagnostics=0`.** Disables the diagnostic IPC socket in production. Turn it back on temporarily when you need `dotnet-counters` against a running container.
:::

## Globalization on Alpine

```dockerfile
# Option A: invariant mode — smallest, no ICU
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1

# Option B: include ICU — +30MB, full culture support
RUN apk add --no-cache icu-libs
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=0
```

Phase 14's warning applies: invariant mode changes culture-sensitive behaviour, not just size. For a JSON API over UTC timestamps it is fine. Decide, and test.

## `.dockerignore`

```text
**/bin/
**/obj/
**/.vs/
**/.vscode/
**/node_modules/
.git/
.github/
**/*.user
**/appsettings.Development.json
**/appsettings.Local.json
Dockerfile*
docker-compose*
README.md
tests/
docs/
```

Without this, `COPY . .` sends your entire `.git` history and every `bin`/`obj` folder to the build daemon — slow, and it can leak secrets from `appsettings.Development.json` into an image layer.

::: warn A secret in any layer is in the image forever
```dockerfile
COPY appsettings.Production.json .     # if it has a secret, it is now permanent
RUN rm appsettings.Production.json     # ← does NOT remove it from the earlier layer
```
Layers are immutable. Deleting a file in a later layer hides it from the final filesystem; anyone can still extract it with `docker save` and unpack the layers.

Never `COPY` a secret. Use BuildKit secret mounts if you need one at build time:
```dockerfile
RUN --mount=type=secret,id=nuget_token \
    dotnet restore --source "https://nuget.example/v3/index.json"
```
and environment variables or a secret manager at runtime.
:::

## Signals and PID 1

```dockerfile
ENTRYPOINT ["dotnet", "TaskFlow.Api.dll"]     # exec form — signals reach the process
ENTRYPOINT dotnet TaskFlow.Api.dll            # shell form — a shell is PID 1, SIGTERM is swallowed
```

**Use the exec form** (the JSON array). With the shell form, PID 1 is `/bin/sh`, which does not forward SIGTERM, so your graceful shutdown from Phase 14 never runs and Docker kills the process after ten seconds — dropping in-flight requests on every deployment.

## Health checks

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:8080/health/live || exit 1
```

Useful for plain Docker and Compose. Under Kubernetes the probes in the manifest take over, and the `HEALTHCHECK` is ignored.

Note this needs `wget` or `curl` in the image. The aspnet Alpine image has `wget` via busybox; the Debian one may not have `curl`. Either add it, or use a tiny .NET health-check executable, or rely on orchestrator probes and omit it.

## Chiselled and distroless images

```dockerfile
FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble-chiseled AS final
```

Chiselled images contain the runtime and nothing else — no shell, no package manager, no `ls`. About 100 MB, and a dramatically smaller attack surface because there are no tools for an attacker to use.

The cost is that you cannot `docker exec` into one to debug. That is a real trade-off: strictly better security, materially worse diagnosis at 3am. Many teams use chiselled in production and a normal image in staging.

::: exercise Level 1 — Guided · Build it properly
1. Write the naive single-stage Dockerfile. Build it and record the size.
2. Convert to multi-stage. Record the size.
3. Switch to Alpine. Record it again.
4. Add `.dockerignore` and note the change in build-context size (Docker prints it).
5. Add the non-root user. Verify with `docker exec api whoami`.
6. Build twice with no changes; time both. Then change one `.cs` file and rebuild; time it.
7. Move `COPY . .` above the restore and rebuild after a code change. Compare the time. Put it back.
8. Use the shell-form `ENTRYPOINT`, send SIGTERM with `docker stop`, and observe that graceful shutdown does not run. Fix it.
:::

::: challenge Level 3 · The smallest safe image
Requirements:

1. Under 120 MB.
2. Non-root, with a read-only root filesystem.
3. No shell and no package manager in the final image.
4. Builds in under 20 seconds on a code-only change.
5. Handles SIGTERM correctly, with graceful shutdown proven.
6. No secret in any layer — verify by unpacking them.
7. A vulnerability scan passing with no high or critical findings.
8. The same Dockerfile produces a debuggable image with a build argument.

Requirement 8 is the practical resolution of the chiselled trade-off.
:::

::: solution
```dockerfile
ARG RUNTIME_IMAGE=mcr.microsoft.com/dotnet/aspnet:10.0-noble-chiseled

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
# ... build stages as above ...

FROM ${RUNTIME_IMAGE} AS final
WORKDIR /app
COPY --from=build --chown=$APP_UID:$APP_UID /app/publish .
USER $APP_UID
ENTRYPOINT ["dotnet", "TaskFlow.Api.dll"]
```

```bash
# production
docker build -t taskflow-api:1.0 .

# debuggable, same Dockerfile
docker build --build-arg RUNTIME_IMAGE=mcr.microsoft.com/dotnet/aspnet:10.0 \
             -t taskflow-api:1.0-debug .
```

`$APP_UID` is defined by the Microsoft base images (it is 1654) — using it rather than creating your own user means the chiselled image, which has no `adduser`, still works.

**Requirement 2, a read-only root filesystem**, needs writable mounts for the paths .NET actually writes to:
```yaml
read_only: true
tmpfs:
  - /tmp
volumes:
  - dataprotection:/home/app/.aspnet/DataProtection-Keys
```
Data Protection keys are the one that catches people: ASP.NET Core writes them to disk by default, and with an ephemeral or read-only filesystem they are regenerated on every restart — which invalidates every antiforgery token and every encrypted cookie. For more than one replica you need shared key storage (Redis, a database or a mounted volume) regardless of read-only mode.

**Requirement 6, verifying no secrets:**
```bash
docker save taskflow-api:1.0 -o image.tar
mkdir -p extract && tar -xf image.tar -C extract
for layer in extract/blobs/sha256/*; do
  tar -tf "$layer" 2>/dev/null | grep -Ei 'secret|password|\.env|appsettings\.(Development|Local)' && echo "  ^ in $layer"
done
```
Run this in CI. It is fifteen lines and it catches the mistake that is otherwise found by a security researcher.

**Requirement 7, scanning:**
```bash
docker scout cves taskflow-api:1.0
trivy image --severity HIGH,CRITICAL --exit-code 1 taskflow-api:1.0
```
`--exit-code 1` fails the build. Note that chiselled images usually pass trivially, because most CVEs in a container image are in packages you removed — which is a large part of their value.

Typical progression through the exercise:
```text
sdk single-stage           912 MB
aspnet multi-stage         218 MB
aspnet alpine              112 MB
chiselled                   98 MB
+ trimmed, self-contained   42 MB      (breaks reflection — Phase 13)
+ Native AOT                28 MB      (many libraries incompatible)
```
For most services, stop at chiselled. Trimming and AOT are worth it for serverless cold starts and genuinely constrained environments, and they cost real compatibility.
:::

::: project TaskFlow's Dockerfile
1. Multi-stage, cached restore, BuildKit cache mounts.
2. Non-root, chiselled or Alpine.
3. `.dockerignore` covering everything unnecessary.
4. Exec-form entrypoint; graceful shutdown verified with `docker stop`.
5. `HEALTHCHECK` or documented reliance on orchestrator probes.
6. A build argument for a debuggable variant.
7. The layer-secret scan and a vulnerability scan in CI.
8. `DECISIONS.md`: image sizes at each step, and why you stopped where you did.

Commit.
:::

::: interview How would you containerise a .NET application?
A multi-stage Dockerfile. The build stage uses the SDK image, and the final stage uses the much smaller ASP.NET runtime image — or a chiselled one — copying only the published output, so the compiler, the source and the intermediate files never ship.

The caching structure matters as much as the size: copy the `.csproj` files and run `dotnet restore` before copying the source, so the restore layer is cached and a code-only change rebuilds in seconds rather than re-downloading every package. A BuildKit cache mount for the NuGet folder helps further.

Then the production details: run as a non-root user, use the exec form of `ENTRYPOINT` so SIGTERM reaches the process and graceful shutdown actually runs, bind to `http://+:8080` rather than localhost, and a `.dockerignore` so `bin`, `obj`, `.git` and development settings never enter the build context.

And never `COPY` a secret — layers are immutable, so deleting it in a later layer leaves it extractable from the image forever.
:::

::: checkpoint
- [ ] My image is under 150 MB
- [ ] It runs as a non-root user
- [ ] A code-only change rebuilds in under 20 seconds
- [ ] `docker stop` triggers graceful shutdown
- [ ] I unpacked the layers and confirmed there are no secrets
- [ ] A vulnerability scan runs in CI and fails the build
:::

## Common mistakes

::: mistake
**Shipping the SDK image.** Nine times larger, with your source code in it.

**`COPY . .` before restore.** Every build re-downloads every package.

**Running as root.** A container escape becomes a host root process.

**Shell-form `ENTRYPOINT`.** SIGTERM is swallowed and graceful shutdown never runs.

**A secret in any layer.** It is in the image permanently, whatever you delete later.

**Ephemeral Data Protection keys.** Cookies and antiforgery tokens break on every restart.
:::
