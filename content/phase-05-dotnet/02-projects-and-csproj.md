---
title: Projects, solutions and the .csproj file
summary: MSBuild without the mystery — what is in a project file and how to control the whole solution from one place.
minutes: 35
stage: Stage 2
---

## What are we learning?

The `.csproj` file, what MSBuild does with it, and `Directory.Build.props` — the single most useful file most .NET developers have never created.

## A modern `.csproj` is small

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>

</Project>
```

Everything else is defaults. Crucially, the SDK-style project **globs all `.cs` files under the project directory automatically** — you never list source files, and adding a file requires no project edit. (Pre-2017 project files listed every file, which is why merge conflicts in `.csproj` used to be a daily event.)

## The properties worth knowing

```xml
<PropertyGroup>
  <!-- targeting -->
  <TargetFramework>net10.0</TargetFramework>
  <TargetFrameworks>net10.0;net8.0</TargetFrameworks>   <!-- plural: multi-target -->

  <!-- language -->
  <LangVersion>latest</LangVersion>
  <ImplicitUsings>enable</ImplicitUsings>
  <Nullable>enable</Nullable>

  <!-- quality -->
  <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  <WarningsAsErrors>CS8509;CS4014</WarningsAsErrors>    <!-- or just specific ones -->
  <NoWarn>CS1591</NoWarn>
  <EnableNETAnalyzers>true</EnableNETAnalyzers>
  <AnalysisLevel>latest-recommended</AnalysisLevel>
  <EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>

  <!-- output -->
  <AssemblyName>taskflow</AssemblyName>
  <RootNamespace>TaskFlow.Cli</RootNamespace>
  <OutputType>Exe</OutputType>                          <!-- or Library -->
  <InvariantGlobalization>true</InvariantGlobalization> <!-- smaller containers -->

  <!-- packaging -->
  <Version>1.2.3</Version>
  <IsPackable>false</IsPackable>
  <GenerateDocumentationFile>true</GenerateDocumentationFile>
</PropertyGroup>
```

## Items

```xml
<ItemGroup>
  <PackageReference Include="Serilog" Version="4.1.0" />
  <ProjectReference Include="..\TaskFlow.Domain\TaskFlow.Domain.csproj" />
  <InternalsVisibleTo Include="TaskFlow.Domain.Tests" />
  <Using Include="TaskFlow.Domain" />            <!-- adds a global using -->
  <None Update="appsettings.json" CopyToOutputDirectory="PreserveNewest" />
  <Compile Remove="Scratch/**" />                <!-- exclude from the glob -->
</ItemGroup>
```

`<Using Include="..."/>` is a neat one: it adds a `global using` from the project file, so every file in the project sees the namespace with no per-file import.

## `Directory.Build.props` — set it once for the whole solution

Put this at the repository root and **every** project below it inherits the settings, automatically, with no edits to individual `.csproj` files.

```xml
<Project>
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <LangVersion>latest</LangVersion>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <EnableNETAnalyzers>true</EnableNETAnalyzers>
    <AnalysisLevel>latest-recommended</AnalysisLevel>
    <EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>
    <GenerateDocumentationFile>true</GenerateDocumentationFile>
    <NoWarn>$(NoWarn);CS1591</NoWarn>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
</Project>
```

Now a new project file is four lines, and you can never again end up with one project that quietly has nullable checks disabled.

There is a matching `Directory.Build.targets` (evaluated *after* project files, for overriding) and `Directory.Packages.props` for central package versions — the next lesson.

::: note `$(NoWarn);CS1591`
MSBuild properties are string variables; `$(Name)` reads one. Writing `<NoWarn>$(NoWarn);CS1591</NoWarn>` *appends* rather than replacing, so a project that sets its own `NoWarn` does not silently lose yours. Get into the habit — the same idiom applies to `DefineConstants` and most list-like properties.
:::

## Conditions

```xml
<PropertyGroup Condition="'$(Configuration)' == 'Release'">
  <Optimize>true</Optimize>
  <DebugType>portable</DebugType>
</PropertyGroup>

<ItemGroup Condition="'$(TargetFramework)' == 'net8.0'">
  <PackageReference Include="Some.Backport" Version="1.0.0" />
</ItemGroup>
```

## Debugging the build

```bash
dotnet build -v normal                    # more output
dotnet build -v diagnostic                # everything, very long
dotnet msbuild -pp:full.xml               # the fully evaluated project — every import inlined
dotnet msbuild -t:Clean;Build
dotnet build -bl                          # binary log -> msbuild.binlog
```

`dotnet msbuild -pp:full.xml` is the one to remember. When you cannot work out where a property is coming from, that file shows you the entire effective project after all imports — usually about 20,000 lines, and searchable.

::: exercise Level 1 — Guided · Take control of the build
In your TaskFlow solution:

1. Create `Directory.Build.props` at the repo root with the block above.
2. Strip the now-redundant properties from every individual `.csproj`. They should be four or five lines each.
3. Build. Fix everything `TreatWarningsAsErrors` reveals — this will find real problems.
4. Add `<InternalsVisibleTo Include="TaskFlow.Domain.Tests" />` to the Domain project and confirm a test can reach an `internal` member.
5. Add a `<Using Include="TaskFlow.Domain" />` to the Application project and remove the now-unnecessary per-file usings.
6. Run `dotnet msbuild -pp:full.xml` in the Domain project, open the file, and find where `TargetFramework` is set.
:::

::: challenge Level 3 · Enforce the architecture in the build
Your `TaskFlow.Domain` must never reference anything. Right now that is a convention held together by discipline. Make the build enforce it.

Requirements:
1. Adding a `ProjectReference` or a `PackageReference` to `TaskFlow.Domain` fails the build with a clear message.
2. The message explains *why*, not just that it failed.
3. A small allowlist is possible (some domains legitimately need, say, `System.Text.Json`).
4. It works for anyone who clones the repository, with no extra setup.

Hint: MSBuild `Target` with `BeforeTargets="Build"` and the `Error` task.
:::

::: solution
In `src/TaskFlow.Domain/TaskFlow.Domain.csproj`:

```xml
<PropertyGroup>
  <AllowedPackages>System.Text.Json</AllowedPackages>
</PropertyGroup>

<Target Name="EnforceDomainPurity" BeforeTargets="Build">
  <Error Condition="'@(ProjectReference)' != ''"
         Code="TFARCH001"
         Text="TaskFlow.Domain must not reference other projects (found: @(ProjectReference->'%(Filename)')). The domain layer is the centre of the dependency graph: everything depends on it and it depends on nothing. If the domain needs something from another layer, that something belongs in the domain, or the dependency should be inverted behind an interface the domain owns." />

  <ItemGroup>
    <DisallowedPackage Include="@(PackageReference)"
                       Condition="!$(AllowedPackages.Contains('%(Identity)'))" />
  </ItemGroup>

  <Error Condition="'@(DisallowedPackage)' != ''"
         Code="TFARCH002"
         Text="TaskFlow.Domain may not depend on @(DisallowedPackage->'%(Identity)'). Allowed: $(AllowedPackages)." />
</Target>
```

Try it: `dotnet add src/TaskFlow.Domain reference src/TaskFlow.Application` then `dotnet build`. You get `error TFARCH001` with the explanation.

Two things to take from this beyond the syntax:

**Architecture rules that are not enforced are not rules.** "The domain does not reference infrastructure" survives exactly until a Friday afternoon when adding the reference is the fastest fix. A build error survives indefinitely.

**The error message teaches.** A message that says "reference not allowed" causes someone to find a workaround. A message that explains the principle causes them to fix the design. Whenever you write a guard — an exception, a validation message, a build error — write the sentence you would say to the person who hit it.

For a bigger codebase, the library **NetArchTest** or **ArchUnitNET** lets you express these rules as unit tests instead, which is more expressive. Phase 10 revisits this.
:::

::: project Standardise the TaskFlow build
1. `Directory.Build.props` as above.
2. The domain-purity target on `TaskFlow.Domain`.
3. `.editorconfig` at the root with the async analysers from Phase 4 plus formatting rules:
   ```ini
   [*.cs]
   indent_style = space
   indent_size = 4
   csharp_new_line_before_open_brace = all
   dotnet_sort_system_directives_first = true
   csharp_style_namespace_declarations = file_scoped:error
   csharp_style_var_for_built_in_types = false:suggestion
   dotnet_diagnostic.CA2016.severity = error
   dotnet_diagnostic.CS4014.severity = error
   ```
4. Run `dotnet format --verify-no-changes`. Fix what it reports, then run `dotnet format` to apply the rest.
5. Confirm a fresh `dotnet build` is warning-free.

Commit. Every project you create from here inherits all of it.
:::

::: interview What is a .csproj file?
An MSBuild project file: XML describing how to build the project. In the modern SDK-style format it is small, because the `Microsoft.NET.Sdk` it imports supplies the defaults and source files are globbed rather than listed.

It contains `PropertyGroup` elements — scalar settings like `TargetFramework`, `Nullable`, `TreatWarningsAsErrors` — and `ItemGroup` elements — lists like `PackageReference`, `ProjectReference` and content files.

Worth adding: solution-wide settings belong in `Directory.Build.props` at the repository root, which every project below inherits automatically. That is how you guarantee consistent language version, nullable settings and analyser rules across a whole codebase without editing each project.
:::

::: checkpoint
- [ ] Every TaskFlow `.csproj` is under six lines
- [ ] `Directory.Build.props` controls the settings for the whole solution
- [ ] Adding a reference to `TaskFlow.Domain` fails the build with a useful message
- [ ] `dotnet format --verify-no-changes` passes
- [ ] I found a property's origin using `dotnet msbuild -pp:full.xml`
:::

## Common mistakes

::: mistake
**Listing `<Compile Include="...">` for every file.** SDK-style projects glob. Adding that back reintroduces the merge conflicts the format was designed to remove.

**Settings duplicated across ten `.csproj` files.** They drift, and one project quietly has nullable off. `Directory.Build.props`.

**`<NoWarn>CS1591</NoWarn>` without `$(NoWarn);`.** You just discarded every inherited suppression.

**Committing `Directory.Build.props` with a machine-specific path.** Use `$(MSBuildThisFileDirectory)` for repo-relative paths.

**Architecture documented in a wiki.** Nobody reads it. Enforce it in the build or in a test.
:::
