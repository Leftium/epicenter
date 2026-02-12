# Classes Make You Say Everything Twice

TypeScript classes have a duplication problem that factory functions don't. It's subtle enough that most people don't notice, but once you see it, it's everywhere.

## The Constructor Tax

Here's a real class from a file system indexer:

```typescript
class FileSystemIndex {
  private unobserve: () => void;

  constructor(private filesTable: TableHelper<FileRow>) {
    this.rebuild();
    this.unobserve = filesTable.observe(() => this.rebuild());
  }

  destroy(): void {
    this.unobserve();
  }
}
```

See `unobserve`? It shows up three times: the type declaration, the assignment, and the usage. The declaration and assignment are pure ceremony. You're telling TypeScript "this field exists" and then separately "here's its value." Two statements for one idea.

TypeScript does have a shorthand for constructor parameters. `private filesTable` in the constructor signature declares the field and assigns it in one shot. But that only works for values passed in from outside. If the value is computed inside the constructor, you're stuck with the two-step dance.

## The Factory Alternative

Same behavior, no duplication:

```typescript
function createFileSystemIndex(filesTable: TableHelper<FileRow>) {
  const rebuild = () => {
    // recompute indexes
  };

  rebuild();
  const unobserve = filesTable.observe(() => rebuild());

  return {
    destroy: () => unobserve(),
  };
}
```

`unobserve` is declared and assigned in one line. There's no type annotation because TypeScript infers it from `filesTable.observe()`. There's no `this.` prefix. There's no separate field declaration. You just write the thing once.

## It Gets Worse With More Fields

Classes scale the duplication linearly. Every computed field costs you two lines instead of one:

```typescript
class SessionManager {
  private refreshTimer: ReturnType<typeof setInterval>;
  private unsubscribe: () => void;
  private cache: Map<string, Session>;

  constructor(
    private client: ApiClient,
    private config: SessionConfig,
  ) {
    this.cache = new Map();
    this.unsubscribe = client.onDisconnect(() => this.cache.clear());
    this.refreshTimer = setInterval(() => this.refresh(), config.interval);
  }
}
```

Six fields. Three of them (`client`, `config`) use parameter shorthand. The other three (`cache`, `unsubscribe`, `refreshTimer`) each need a declaration and an assignment. That's six extra lines of pure bookkeeping.

The factory version:

```typescript
function createSessionManager(client: ApiClient, config: SessionConfig) {
  const cache = new Map<string, Session>();
  const unsubscribe = client.onDisconnect(() => cache.clear());
  const refreshTimer = setInterval(() => refresh(), config.interval);

  // ...

  return { destroy, getSession, refresh };
}
```

Three fields, three lines. The types are inferred. The scope handles privacy: if it's not in the return object, it's private. No `private` keyword needed.

## The Real Cost

The duplication isn't just visual noise. It's a maintenance hazard. Rename a field? You touch the declaration, the assignment, and every `this.` reference. Change a type? You update the annotation, even though the compiler could infer it from the right-hand side. The class forces you to be explicit about things the compiler already knows.

| Class pattern | Factory equivalent |
|---|---|
| `private field: Type;` then `this.field = value;` | `const field = value;` |
| `private` keyword | Not in the return object |
| `this.field` everywhere | Just `field` |
| Explicit type annotation | Inferred from assignment |
| `destroy()` method | Closure captures cleanup automatically |

Factory functions let you write code once and let TypeScript figure out the rest. Classes make you spell it out twice because that's what the syntax demands.
