---
title: How to use this hub
summary: The rules of engagement. Read this once, properly, then never passively read again.
minutes: 15
stage: Stage 1
---

## What are we learning?

How this course is structured, and what is expected of you. This is the only lesson where reading is the point.

You already program. You know what a loop is, what a function is, what a hash map is. So this course does not teach programming — it teaches **C#, the .NET platform, and how professionals build applications on it**.

## The loop

Every lesson runs the same loop:

```text
LEARN        a short, dense explanation — no padding
EXAMPLE      small, focused, complete code you can run
YOUR TURN    you write code, not me
EXERCISE     requirements, not implementations
PROJECT      the concept goes into TaskFlow, the real app
CHALLENGE    harder problem, no hand-holding
FORWARD      next lesson
```

The target split is roughly **10% explanation, 20% examples, 70% you typing**. If you find yourself scrolling and nodding, you are doing it wrong.

## The four exercise levels

Exercises escalate deliberately.

| Level | Name | What you get | What you must supply |
|---|---|---|---|
| 1 | Guided | Step-by-step instructions and hints | The typing and the understanding |
| 2 | Independent | Requirements only | The whole implementation |
| 3 | Challenge | A problem | The design *and* the implementation |
| 4 | Debug | Broken code | The diagnosis and the fix |

Level 4 matters more than it looks. Most of your professional life is spent reading code that does not work and figuring out why.

## Solutions are collapsed on purpose

Every solution block in this course is closed until you click it.

::: solution The rule about solutions
Open it **after** you have written something — even something wrong. A wrong attempt followed by the solution teaches you far more than reading the solution first, because you find out precisely where your model of the language was incorrect.

If you open this before attempting the exercise, you will finish the course and still not be able to write C# without a reference open.
:::

## Your progress is saved locally

Checkboxes, completed lessons and project stages are stored in your browser's `localStorage`. Nothing is sent anywhere, there is no account, and clearing your browser data resets it. The sidebar percentage is honest only if you are honest.

## The project

You build one application: **TaskFlow**, a task management API. Look at the [Project](#/project) page now to see all eight stages.

It starts as a console app with a `List<TaskItem>` and finishes as a containerised ASP.NET Core service with PostgreSQL, JWT auth, layered architecture and a test suite. You never delete it and start again — every stage refactors the code you already have, which is exactly how real systems evolve.

::: exercise Level 1 — Guided · Set up your workspace
You need somewhere to write code. The hub does not run your code — your terminal does.

1. Open a terminal beside your browser. You will be switching between them constantly.
2. Confirm the SDK is there:
   ```bash
   dotnet --version
   ```
   If that prints a version starting with `10.`, you are ready. If not, do the next lesson's setup section first.
3. Create a scratch folder you can throw away. You will use it for every small experiment in this course:
   ```bash
   mkdir -p ~/dotnet-scratch && cd ~/dotnet-scratch
   dotnet new console -o hello
   cd hello
   dotnet run
   ```
4. You should see `Hello, World!`. Open `Program.cs`, change the message, and run it again.

That loop — edit, `dotnet run`, read the output — is the innermost loop of your next few weeks.
:::

::: stop Before you continue
Do not move to the next lesson until you have actually run `dotnet run` and seen your own changed message in the terminal.
:::

::: checkpoint Verify you are set up
- [ ] I have a terminal open next to this browser window
- [ ] `dotnet --version` prints a version
- [ ] I created a scratch project and ran it
- [ ] I changed the output and ran it again
- [ ] I understand that solutions stay closed until I have attempted the exercise
:::

## Common mistakes people make with courses like this

::: mistake
**Reading ahead without coding.** The material will feel easy while you read it. It will feel impossible the first time you face a blank `Program.cs`. The gap between those two feelings is the entire point of the exercises.

**Copying code instead of typing it.** Typing is slow, and that slowness is where the learning happens. You notice the semicolons, the `using` directives, the capitalisation of `String` vs `string`. Copy-paste skips all of it.

**Skipping the project steps.** The project steps are the part that turns twenty disconnected concepts into one application you can talk about in an interview. A phase without its project step is trivia.

**Treating compiler errors as failure.** The C# compiler is unusually helpful. Read the error, including the error code (`CS8618`, `CS0246`). Those codes are searchable and precise.
:::

## Checkpoint

You are ready to continue when you can answer these without scrolling up:

1. What are the four exercise levels, and what changes between them?
2. What proportion of your time should be spent writing code?
3. When are you allowed to open a solution block?
4. What is the one application you build across the whole course?
