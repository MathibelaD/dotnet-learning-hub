# The TaskFlow project

The curriculum has you build **TaskFlow** yourself, from `dotnet new console` in Phase 0
to a containerised API in Phase 15. Building it is the course; nothing here does that for you.

What `starter-kit/` contains is the *supporting* configuration — the files that are tedious
to type, easy to get subtly wrong, and teach you nothing by being typed a second time:

```
starter-kit/
├── Directory.Build.props     nullable, warnings-as-errors, analysers, for every project
├── Directory.Packages.props  central package versions
├── global.json               pins the SDK
├── .editorconfig             formatting + the analyser rules the lessons turn on
├── .gitignore                the standard .NET one
├── docker-compose.yml        PostgreSQL + Redis, with health checks and volumes
├── .env.example              the variables compose requires
└── scripts/
    ├── build.sh              restore → build → test → publish, failing on warnings
    ├── migrate.sh            wraps the dotnet-ef flags so you stop retyping them
    └── serve.sh              docker compose up + wait for health
```

## Using it

Phase 0 tells you to create `~/taskflow`. Copy these in at that point:

```bash
mkdir -p ~/taskflow && cd ~/taskflow
git init
cp -r /path/to/dotnet-learning-hub/project/starter-kit/. .
cp .env.example .env          # fill in DB_PASSWORD
chmod +x scripts/*.sh
docker compose up -d
```

Then follow Phase 0 lesson 3 onward and create the projects yourself.

`Directory.Build.props` applies to every project you create below it, so
`dotnet new classlib -o src/TaskFlow.Domain` immediately has nullable reference types on,
warnings as errors, and the analysers the lessons rely on — which is why the very first
lesson's exercises behave as described.
