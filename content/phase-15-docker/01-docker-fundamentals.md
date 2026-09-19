---
title: Docker fundamentals
summary: Images, layers and containers — the mental model that makes everything else obvious.
minutes: 35
stage: Stage 8
---

## What are we learning?

What Docker actually does, the difference between an image and a container, and the layer model that determines your build times.

## The model

```text
DOCKERFILE   a recipe
    ↓ docker build
IMAGE        a read-only, layered filesystem + metadata (like a class)
    ↓ docker run
CONTAINER    a running process with that filesystem (like an instance)
```

An image is a **stack of layers**. Each instruction in a Dockerfile produces a layer, and layers are content-addressed and shared between images. A container adds one thin writable layer on top.

```text
┌─────────────────────────┐
│ writable layer          │  ← the container's changes, lost on removal
├─────────────────────────┤
│ COPY app files          │  ← your application
├─────────────────────────┤
│ RUN apt-get install …   │  ← dependencies
├─────────────────────────┤
│ FROM mcr.../aspnet:10.0 │  ← base image, shared by every .NET image on the host
└─────────────────────────┘
```

::: why Why layers determine your build time
Docker caches layers. A layer is rebuilt only if the instruction or anything before it changed.

```dockerfile
COPY . .                      # ← any file change invalidates this
RUN dotnet restore            # ← so this re-runs. 60 seconds, every build.
```

```dockerfile
COPY *.csproj ./              # ← changes only when dependencies change
RUN dotnet restore            # ← cached across normal code edits
COPY . .                      # ← changes often, but it is the last expensive step
RUN dotnet build
```

Same result; the second builds in seconds instead of minutes on an ordinary code change.

**The rule: order instructions from least to most frequently changing.** It is the single highest-leverage thing to know about Dockerfiles.
:::

## A container is not a virtual machine

```text
VIRTUAL MACHINE                 CONTAINER
├── your app                    ├── your app
├── libraries                   ├── libraries
├── a full guest OS  (GBs)      └── (shares the host kernel)
└── a hypervisor
     boots in ~30s                   starts in ~50ms
     ~1 GB overhead                  ~5 MB overhead
```

A container is a process on the host, isolated with kernel features — namespaces for what it can see, cgroups for what it can use. There is no guest kernel.

Two consequences worth holding onto:
1. **A container cannot run a different OS kernel.** Linux containers on macOS or Windows run inside a Linux VM that Docker Desktop manages for you.
2. **A container is a process.** When process 1 exits, the container stops. There is nothing else keeping it alive.

## The commands

```bash
docker build -t taskflow-api:1.0 .
docker build -t taskflow-api:1.0 --build-arg VERSION=1.0 -f src/TaskFlow.Api/Dockerfile .

docker run -d --name api -p 8080:8080 -e ASPNETCORE_ENVIRONMENT=Production taskflow-api:1.0
docker ps                       # running
docker ps -a                    # including stopped
docker logs -f api
docker exec -it api /bin/sh     # a shell inside
docker stop api && docker rm api

docker images
docker image inspect taskflow-api:1.0
docker history taskflow-api:1.0      # layer sizes — very useful
docker system df                     # what is using your disk
docker system prune -a               # reclaim it
```

`docker history` is the diagnostic to reach for when an image is unexpectedly large: it shows each layer's size and the instruction that produced it.

## Data does not survive

```bash
docker run -d --name db postgres:17
# ... write data ...
docker rm -f db
# the data is gone
```

A container's writable layer is deleted with the container. For anything you want to keep:

```bash
# named volume — managed by Docker, the usual choice
docker volume create taskflow-data
docker run -v taskflow-data:/var/lib/postgresql/data postgres:17

# bind mount — a host directory, useful in development
docker run -v "$PWD/src:/app/src" mcr.microsoft.com/dotnet/sdk:10.0
```

::: warn `docker compose down -v` destroys your data
`down` stops and removes containers. `down -v` also removes **volumes**, which is your database.

There is no confirmation and no undo. Use plain `down` by default, and `-v` only when you deliberately want a clean slate.
:::

## Networking

```bash
docker network create taskflow-net
docker run --network taskflow-net --name db postgres:17
docker run --network taskflow-net --name api taskflow-api:1.0
```

On a user-defined network, containers resolve each other **by container name**. So from the API container, the database is at `Host=db`, not `Host=localhost`.

::: warn `localhost` inside a container means that container
This catches everyone exactly once.

```text
Connection string on your machine:     Host=localhost;Port=5432
Connection string inside a container:  Host=db;Port=5432
```

Inside the API container, `localhost` is the API container — where nothing is listening on 5432. The symptom is `Connection refused` from an application that worked perfectly a minute ago outside Docker.

Related: your application must bind to `0.0.0.0` (or `+`), not `127.0.0.1`. Binding to loopback inside a container makes it unreachable from outside, even with a published port.

```bash
ASPNETCORE_URLS=http://+:8080        # correct
ASPNETCORE_URLS=http://localhost:8080 # unreachable from the host
```
:::

Port publishing is separate from networking:

```bash
-p 8080:8080      # host 8080 → container 8080
-p 5080:8080      # host 5080 → container 8080
-p 127.0.0.1:8080:8080   # bound to loopback on the host only
```

::: exercise Level 1 — Guided · Get the model into your hands
1. `docker run --rm -it mcr.microsoft.com/dotnet/sdk:10.0 /bin/bash`. Look around: `ls /`, `dotnet --version`, `cat /etc/os-release`. Exit and note the container is gone (`--rm`).
2. Start PostgreSQL with a named volume, create a table, remove the container, start a new one with the same volume, and confirm the table survived.
3. Repeat without the volume and confirm the data is gone.
4. Create a network, run two containers, and `ping` one from the other by name.
5. From one container, try to reach the other on `localhost` and observe the failure.
6. Build any small image twice. Time both. Change one source file and build again; note which layers were cached.
7. `docker history` on a .NET image and find the three largest layers.
:::

::: challenge Level 3 · Diagnose five broken containers
For each, predict the failure, reproduce it, diagnose it from the logs, and fix it:

1. A container that exits immediately with code 0.
2. A container running, port published, but `curl localhost:8080` gets connection refused.
3. An API container that cannot reach its database, though the database container is healthy.
4. A container killed with exit code 137.
5. A container whose logs are empty although the application is clearly running.
:::

::: solution
**1 — exits with code 0.** The main process finished. A container lives exactly as long as PID 1. Often this is `CMD ["bash"]` with no TTY, or a script that ends. `docker ps -a` shows `Exited (0)`. Fix: the entrypoint must be a long-running foreground process. A .NET app run with `dotnet app.dll` stays in the foreground; anything backgrounded with `&` will not.

**2 — connection refused despite a published port.** The application is bound to `127.0.0.1` inside the container. Confirm with `docker exec api netstat -tlnp` — you will see `127.0.0.1:8080` rather than `0.0.0.0:8080`. Fix: `ASPNETCORE_URLS=http://+:8080`.

**3 — cannot reach the database.** Either the connection string says `localhost`, or the containers are on different networks. Diagnose: `docker exec api getent hosts db` — no result means DNS cannot resolve it, so it is a network problem; a result means the connection string is wrong. Fix: same network, and `Host=db`.

**4 — exit code 137.** 137 = 128 + 9 = SIGKILL. Almost always the OOM killer. Confirm with `docker inspect api --format '{{.State.OOMKilled}}'`. Fix: raise the memory limit, or — better — find out why the application needs more than you budgeted (Phase 13's leaks). See the note below about .NET and container limits.

**5 — empty logs.** Docker captures stdout and stderr of PID 1. If the application writes to a file, or buffers stdout without flushing, or logs from a child process, nothing appears. Fix: log to the console, and make sure the console sink flushes. For Serilog, the console sink is unbuffered by default; a file sink writes nowhere Docker can see.

::: note .NET and container memory limits
.NET reads cgroup limits and sizes its heap accordingly, so a container limited to 512 MB gets a smaller GC budget automatically. That works — but `ServerGarbageCollection` creates one heap per core, and in a container limited to 0.5 CPU but able to *see* 16 cores, it creates 16 heaps and uses far more memory than intended.

```yaml
environment:
  DOTNET_gcServer: "1"
  DOTNET_GCHeapHardLimit: "0x10000000"   # 256MB, hex
deploy:
  resources:
    limits: { memory: 512M, cpus: "0.5" }
```

Or set `DOTNET_GCHeapCount`. Exit code 137 on a service that looks idle is very often this.
:::
:::

::: project Containerise the database properly
Your `docker-compose.yml` from Phase 0 is already close. Verify it:

1. A named volume for PostgreSQL data.
2. A health check so dependents can wait for it.
3. A user-defined network.
4. `docker compose down` then `up` preserves data; `down -v` destroys it (test in a scratch copy).
5. Connect from your host with `psql`, and from another container by service name — confirm both work and note the different host values.

Commit.
:::

::: interview What is the difference between an image and a container?
An image is a read-only template: a stack of filesystem layers plus metadata about how to start a process. A container is a running instance of an image, with a thin writable layer on top — roughly the relationship between a class and an object.

The layer model is the practically important part. Each Dockerfile instruction creates a layer, layers are cached and shared, and a layer is rebuilt only when it or something before it changes. So ordering instructions from least to most frequently changing — copying project files and restoring packages before copying source — is what makes builds take seconds instead of minutes.

The other thing worth stating is that a container is a process sharing the host kernel, not a virtual machine: it starts in milliseconds, it has no guest OS, and when its main process exits the container stops.
:::

::: checkpoint
- [ ] I can explain the image/container relationship and the layer cache
- [ ] I proved data survives with a volume and not without
- [ ] Containers on my network resolve each other by name
- [ ] I know why `localhost` inside a container is wrong
- [ ] I can diagnose exit codes 0 and 137
:::

## Common mistakes

::: mistake
**`localhost` in a container's connection string.** It means that container.

**Binding to `127.0.0.1` inside a container.** Unreachable even with a published port.

**`COPY . .` before `dotnet restore`.** Every build re-downloads every package.

**`docker compose down -v` out of habit.** That is your database.

**Assuming a container preserves state.** Only volumes survive.
:::
