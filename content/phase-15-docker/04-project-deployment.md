---
title: "Checkpoint: TaskFlow, containerised"
summary: Stage 8 — the whole application running with one command, ready to deploy.
minutes: 90
stage: Stage 8
---

## What are we learning?

Nothing new. **Stage 8**, the final project stage.

::: stop
The acceptance test is a clean machine. If it needs anything beyond Docker and one command, it is not done.
:::

## The deliverable

```bash
git clone <your repo>
cd taskflow
cp .env.example .env     # fill in two values
docker compose up
```

and TaskFlow is running, migrated, seeded and documented at `http://localhost:5080`.

## Requirements

### Image
- Multi-stage build; final image under 150 MB
- Non-root user
- A code-only change rebuilds in under 20 seconds
- Exec-form entrypoint; `docker stop` triggers graceful shutdown
- `.dockerignore` excluding `bin`, `obj`, `.git`, tests and development settings
- No secret in any layer — verified by unpacking
- A vulnerability scan with no high or critical findings

### Stack
- api, db, cache, migrate, plus observability and test profiles
- Health checks on every service; correct `depends_on` conditions
- Named volumes for the database and cache
- Resource limits, with the .NET GC configured for them
- `.env.example` committed; every secret required with `:?`

### Application
- Binds to `http://+:8080`
- Production configuration by default in the base compose file
- Structured JSON logs to stdout
- `/health/live` and `/health/ready` behaving correctly
- Graceful shutdown with a readiness delay
- Migrations applied by a separate container, not at startup

### CI
- Build, test, scan and image build on every push
- The image built once and tagged with the commit SHA
- Layer-secret scan and dependency vulnerability scan, both failing the build
- OpenAPI document regenerated and diffed

## Checkpoint

::: checkpoint
- [ ] A clean clone runs with one command
- [ ] `docker compose ps` shows every service healthy
- [ ] The whole `.http` file passes against the containerised API
- [ ] `docker compose down && up` preserves data
- [ ] `docker stop` completes in-flight requests
- [ ] The image is under 150 MB and runs as non-root
- [ ] No secret is extractable from any layer
- [ ] `docker compose --profile test run --rm tests` passes
- [ ] CI runs everything on push
- [ ] The README takes under five minutes to follow
:::

::: project Finish Stage 8
```bash
cd ~/taskflow
docker compose build
docker compose up -d
docker compose ps
./scripts/smoke-test.sh          # runs your .http file with curl or httpyac

git commit -am "Stage 8 complete: fully containerised TaskFlow"
git tag stage-8
```

Then the real test: on a different machine, or a fresh VM, or a colleague's laptop with only Docker installed —

```bash
git clone <repo> && cd taskflow && cp .env.example .env && docker compose up
```

If that works, you are done.
:::

::: solution A CI workflow that does all of it
```yaml
name: ci
on: [push, pull_request]

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-dotnet@v4
        with: { dotnet-version: '10.0.x' }

      - run: dotnet restore --locked-mode
      - run: dotnet build -c Release --no-restore
      - run: dotnet test -c Release --no-build --logger trx --collect:"XPlat Code Coverage"

      - name: Dependency vulnerabilities
        run: |
          dotnet list package --vulnerable --include-transitive 2>&1 | tee audit.txt
          ! grep -q "has the following vulnerable packages" audit.txt

      - name: Secret scan
        uses: gitleaks/gitleaks-action@v2

      - name: OpenAPI has not drifted
        run: |
          dotnet build src/TaskFlow.Api -c Release
          git diff --exit-code docs/TaskFlow.Api.json \
            || { echo "::error::The OpenAPI document changed. Review and commit it."; exit 1; }

  image:
    needs: build-and-test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3

      - uses: docker/build-push-action@v6
        with:
          context: .
          file: src/TaskFlow.Api/Dockerfile
          tags: taskflow-api:${{ github.sha }}
          load: true
          cache-from: type=gha
          cache-to: type=gha,mode=max
          build-args: VERSION=1.0.${{ github.run_number }}

      - name: Image vulnerabilities
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: taskflow-api:${{ github.sha }}
          severity: HIGH,CRITICAL
          exit-code: '1'

      - name: No secrets in layers
        run: ./scripts/scan-layers.sh taskflow-api:${{ github.sha }}

      - name: Smoke test the image
        run: |
          docker compose -f docker-compose.yml up -d
          timeout 90 bash -c 'until curl -sf localhost:5080/health/ready; do sleep 2; done'
          ./scripts/smoke-test.sh
          docker compose down
```

Three details worth stealing:

**`cache-from: type=gha`.** Without a cache, every CI build downloads every NuGet package and rebuilds every layer — typically four minutes. With the GitHub Actions cache backend, a code-only change builds in under thirty seconds.

**`! grep -q ...` for the vulnerability check.** `dotnet list package --vulnerable` exits 0 even when it finds vulnerabilities, which is a genuine trap — the step passes and nobody notices. Inverting a grep over its output is the reliable way to fail on a finding.

**The health-check wait loop before the smoke test.** `docker compose up -d` returns as soon as the containers are created, not when the application is ready. Without the loop, the smoke test fails intermittently — and intermittent CI failures get retried until they pass, which trains everyone to ignore the signal.

**What this workflow does not include, deliberately:** deployment. Where TaskFlow deploys — Kubernetes, ECS, Container Apps, a single VM — is a separate concern with its own tooling, and the image tagged with a commit SHA is the correct handoff point. Being able to say "CI produces a scanned, tested, tagged image; deployment is a separate pipeline that consumes it" is the right shape.
:::

::: interview How would you deploy this?
The build produces a single artefact: an image tagged with the commit SHA, built in CI after tests, dependency scanning and secret scanning have passed, and scanned again for OS vulnerabilities.

Configuration comes entirely from the environment — connection strings, signing keys, feature flags — so the same image runs in every environment with no rebuild. Migrations run as a separate step before the deployment rolls, not at application startup, so several replicas cannot race and a failed migration does not leave a half-started service.

The rollout relies on the health endpoints: readiness gates traffic, liveness only checks the process, and the application reports not-ready and waits for the load balancer's check interval before exiting, which is what makes a deployment produce zero failed requests rather than a burst of 502s.

For local development and small deployments, Compose with health conditions and profiles gives a one-command stack. For anything larger the same image goes to Kubernetes with probes, resource limits and secrets from the platform's secret store.
:::

::: checkpoint Phase 15 complete
- [ ] Stage 8 is committed and tagged
- [ ] It runs from a clean clone on a machine with only Docker
- [ ] CI builds, tests, scans and produces a tagged image
- [ ] I can explain every line of my Dockerfile and compose file
:::
