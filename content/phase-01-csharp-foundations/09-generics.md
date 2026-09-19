---
title: Generics
summary: Type parameters, constraints, variance — and why generics are not just "templates for collections".
minutes: 40
stage: Stage 1
---

## What are we learning?

How to write code that works over a type you do not know yet, without losing type safety or paying a performance cost.

## The problem generics solve

```csharp
// Without generics: everything becomes object
public class Box
{
    public object Value { get; set; }
}

var box = new Box { Value = 42 };
int n = (int)box.Value;          // cast — can throw at runtime
box.Value = "oops";              // no compiler complaint
```

```csharp
// With generics: the type travels with the value
public class Box<T>
{
    public required T Value { get; init; }
}

var box = new Box<int> { Value = 42 };
int n = box.Value;               // no cast
// box.Value = "oops";           // CS0029 at compile time
```

::: why Generics in .NET are not Java generics
Java erases type parameters at compile time — at runtime a `List<String>` is just a `List`. .NET **reifies** them: the runtime knows the type argument, `typeof(List<int>)` is a distinct type from `typeof(List<string>)`, and the JIT generates specialised machine code for value types.

Two practical consequences:
- `List<int>` stores actual `int`s with no boxing. In Java, `List<Integer>` boxes every element.
- You can ask for the type argument at runtime: `typeof(T)`, `default(T)`, `new T()` (with a constraint).
:::

## Constraints

Without a constraint, `T` could be anything, so you can only do what you can do to `object`. Constraints trade flexibility for capability.

```csharp
where T : class                 // reference type
where T : struct                // non-nullable value type
where T : notnull               // neither null nor a nullable type
where T : new()                 // has a public parameterless constructor
where T : IComparable<T>        // implements an interface
where T : TaskItem              // derives from a class
where T : IEntity, new()        // combine, with new() last
where TKey : notnull            // what Dictionary<TKey, TValue> requires
```

```csharp
public class Repository<TEntity, TKey>
    where TEntity : class, IEntity<TKey>
    where TKey : notnull
{
    private readonly Dictionary<TKey, TEntity> _items = [];

    public void Add(TEntity entity) => _items[entity.Id] = entity;   // .Id available thanks to the constraint
    public TEntity? Get(TKey id) => _items.GetValueOrDefault(id);
}

public interface IEntity<TKey> { TKey Id { get; } }
```

## Generic methods and inference

```csharp
public static T? FirstOrDefaultWhere<T>(IEnumerable<T> items, Func<T, bool> predicate)
{
    foreach (var item in items)
        if (predicate(item)) return item;
    return default;
}

var urgent = FirstOrDefaultWhere(tasks, t => t.Priority == Priority.Urgent);
//                               ^ T inferred as TaskItem — no <TaskItem> needed
```

Type inference works for **method** type parameters, never for class type parameters. `new Box(42)` will not infer `Box<int>` — this is why the BCL has static factory helpers like `Tuple.Create`.

## `default(T)`

```csharp
default(int)        // 0
default(bool)       // false
default(string)     // null
default(TaskItem)   // null
default(DateTime)   // 0001-01-01
default(Guid)       // 00000000-0000-0000-0000-000000000000
```

Inside a generic method, write plain `default` and let it infer. Careful: `default(T)` for an unconstrained `T` may be `null`, which is why `T?` in a generic context means something subtly different depending on whether `T` is a value or reference type — a corner you will meet again in Phase 13.

## Variance: `out` and `in`

```csharp
IEnumerable<string> strings = new List<string>();
IEnumerable<object> objects = strings;      // legal — IEnumerable<out T> is covariant

Action<object> printAny = o => Console.WriteLine(o);
Action<string> printString = printAny;      // legal — Action<in T> is contravariant

List<string> a = new();
// List<object> b = a;                      // NOT legal — List<T> is invariant
```

The rule, in one line: **`out` means T only comes out (safe to widen), `in` means T only goes in (safe to narrow), and if T does both, neither is safe.** `List<T>` both returns and accepts `T`, so it is invariant — if it were covariant you could add a `Cat` to a `List<Dog>` viewed as `List<Animal>`.

You mostly consume variance rather than declaring it, but knowing the rule explains a whole category of confusing compiler errors.

::: exercise Level 1 — Guided · A generic result type
Build `Result<T>` — a type that represents either a success with a value or a failure with an error message. You will use this constantly from Phase 6 onward.

Requirements:
1. `Result<T>.Success(T value)` and `Result<T>.Failure(string error)` static factories.
2. `bool IsSuccess`, `T? Value`, `string? Error`.
3. A private constructor so the only way to build one is through the factories.
4. `TOut Match<TOut>(Func<T, TOut> onSuccess, Func<string, TOut> onFailure)`.
5. Implicit conversion from `T` so `return task;` works where a `Result<TaskItem>` is expected.

Then use it: rewrite a method that currently throws on "not found" to return `Result<TaskItem>` instead, and handle both cases with `Match`.
:::

::: solution
```csharp
public readonly struct Result<T>
{
    private Result(bool ok, T? value, string? error)
    {
        IsSuccess = ok; Value = value; Error = error;
    }

    public bool IsSuccess { get; }
    public T? Value { get; }
    public string? Error { get; }

    public static Result<T> Success(T value) => new(true, value, null);
    public static Result<T> Failure(string error) => new(false, default, error);

    public TOut Match<TOut>(Func<T, TOut> onSuccess, Func<string, TOut> onFailure) =>
        IsSuccess ? onSuccess(Value!) : onFailure(Error!);

    public static implicit operator Result<T>(T value) => Success(value);
}
```

Usage:
```csharp
Result<TaskItem> Find(Guid id) =>
    _store.Get(id) is { } task ? task : Result<TaskItem>.Failure($"No task with id {id}.");

var message = Find(id).Match(
    onSuccess: t => $"Found: {t.Title}",
    onFailure: e => $"Error: {e}");
```

`Value!` uses the null-forgiving operator — we know it is non-null when `IsSuccess`, but the compiler cannot. The next lesson explains exactly what `!` does and why using it should always make you pause.

Design note worth arguing about: this is a `readonly struct` so that returning results in a hot path does not allocate. A `record` would be equally defensible and simpler to read. Both are fine; know which trade-off you made.
:::

::: challenge Level 3 · A type-safe, in-memory, generic store
Build `EntityStore<TEntity, TKey>` with:
- `Add`, `Update`, `Remove`, `Get`, `All`
- `IReadOnlyList<TEntity> Where(Func<TEntity, bool> predicate)`
- `bool Exists(TKey id)`
- An event or callback fired whenever an entity changes (any mechanism you like — Phase 2 gives you `event`)
- Constraints that make `Add` impossible to call with a type that has no `Id`

Then use it for **both** `TaskItem` (keyed by `Guid`) and a new `User` (keyed by `string` email) with no changes to the store. That second usage is the actual test of whether your generics are right.
:::

::: debug Level 4 · Why does this not compile?
Three separate errors. Diagnose each, then fix.

```csharp
public class Cache<T>
{
    private readonly Dictionary<string, T> _items = new();

    public T GetOrAdd(string key)
    {
        if (!_items.ContainsKey(key))
            _items[key] = new T();

        return _items[key];
    }

    public bool IsEmpty(string key) => _items[key] == null;

    public int CompareTo(T a, T b) => a.CompareTo(b);
}
```
:::

::: solution
**1. `new T()` — `CS0304`.** The compiler has no idea whether `T` has a parameterless constructor. Add `where T : new()`.

**2. `== null` — `CS0019`.** For an unconstrained `T`, the compiler does not know whether `==` is defined. If `T` is a struct, comparing to null is meaningless. Use `EqualityComparer<T>.Default.Equals(value, default)`, or constrain `where T : class`.

**3. `a.CompareTo(b)` — `CS1061`.** `T` is only known to be `object`, which has no `CompareTo`. Add `where T : IComparable<T>`.

```csharp
public class Cache<T> where T : class, IComparable<T>, new()
```

The general lesson: **a type parameter can only do what its constraints permit.** When the compiler says "T does not contain a definition for X", you are not missing a `using` — you are missing a constraint. Each constraint you add is a promise callers must keep, so add the weakest one that lets you do the job.
:::

::: project Make TaskFlow's store generic
Refactor `ITaskStore` / `InMemoryTaskStore` into `IStore<TEntity, TKey>` / `InMemoryStore<TEntity, TKey>`:

```csharp
public interface IEntity<TKey> where TKey : notnull { TKey Id { get; } }

public interface IStore<TEntity, TKey>
    where TEntity : class, IEntity<TKey>
    where TKey : notnull
{
    TEntity? Get(TKey id);
    IReadOnlyList<TEntity> All();
    void Add(TEntity entity);
    bool Remove(TKey id);
}
```

Then:
1. Make `TaskItem` implement `IEntity<Guid>`.
2. Add a `User` record/class implementing `IEntity<Guid>` with `Email` and `DisplayName`.
3. Use `InMemoryStore<TaskItem, Guid>` and `InMemoryStore<User, Guid>` in `Program.cs` from the same implementation.
4. Keep `LoggingTaskStore` working — it becomes `LoggingStore<TEntity, TKey>`.

Commit. You will replace this with EF Core in Phase 7, and the interface is what makes that replacement a drop-in.
:::

::: interview What are generics and why do they matter in .NET?
They let you parameterise a type or method by another type, so the same code works over many types while keeping compile-time type checking. The alternatives are casting through `object` — unsafe and slow — or duplicating code per type.

The .NET-specific point worth making: generics are **reified**, not erased. The runtime knows the type argument, so `List<int>` stores unboxed integers and the JIT produces specialised code for value-type arguments. That makes generics a performance feature in .NET, not only an ergonomics one.

Expect a follow-up on constraints: they are how you tell the compiler what `T` is capable of, and a generic type parameter can only do what its constraints allow.
:::

::: checkpoint
- [ ] I built `Result<T>` and used it instead of throwing
- [ ] I can name five constraints and say what each enables
- [ ] I understand why `List<T>` cannot be covariant
- [ ] I fixed all three constraint errors without looking them up
- [ ] TaskFlow stores `TaskItem` and `User` through one generic store
:::

## Common mistakes

::: mistake
**Adding `where T : class` reflexively.** It forbids value types for no reason. Add the weakest constraint that compiles.

**Generic types with five type parameters.** `Handler<TRequest, TResponse, TContext, TError, TLogger>` is a sign that something wants to be a plain class with properties.

**Using `typeof(T)` and a switch inside a generic method.** If your generic code has to ask what `T` actually is, it is not generic — it is a switch statement with extra steps. Use an interface or overloads.

**Expecting inference on constructors.** `new Box(42)` will not produce `Box<int>`. Either write it out or add a static factory.
:::
