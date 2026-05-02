# Let Factory Return Types Point Back to the Factory

If a type is only the return shape of one `create*` function, the factory should own the shape. Export the name as `ReturnType<typeof createThing>`, then put the concrete method signatures and JSDoc on the returned object. That gives you one source of truth and keeps Go to Definition pointed at the implementation.

The old pattern writes the same public API twice:

```typescript
export type BrowserDocumentFamily<
  Id extends string | number,
  TDocument extends BrowserDocumentInstance,
> = Disposable & {
  open(id: Id): TDocument & Disposable;
  has(id: Id): boolean;
  syncControl: SyncControl;
  clearLocalData(): Promise<void>;
};

export function createBrowserDocumentFamily<
  Id extends string | number,
  TDocument extends BrowserDocumentInstance,
>(
  source: BrowserDocumentFamilySource<Id, TDocument>,
): BrowserDocumentFamily<Id, TDocument> {
  return {
    open(id) {
      return cache.open(id);
    },
    has(id) {
      return cache.has(id);
    },
    syncControl,
    async clearLocalData() {
      // ...
    },
  };
}
```

That looks clean until you navigate it. Click `cache.open`, and TypeScript has a reasonable reason to send you to `BrowserDocumentFamily.open`. But that is usually not what you wanted. You wanted to see the returned method, the closure it reads, and the helper it delegates to.

Flip the direction:

```typescript
export type BrowserDocumentFamily<
  Id extends string | number,
  TDocument extends BrowserDocumentInstance,
> = ReturnType<typeof createBrowserDocumentFamily<Id, TDocument>>;

export function createBrowserDocumentFamily<
  Id extends string | number,
  TDocument extends BrowserDocumentInstance,
>(source: BrowserDocumentFamilySource<Id, TDocument>) {
  return {
    open(id: Id) {
      return cache.open(id);
    },
    has(id: Id) {
      return cache.has(id);
    },
    /**
     * Reset every id known to the document source after pausing active sync.
     */
    async clearLocalData() {
      // ...
    },
  };
}
```

Now the type name still exists. Consumers can import `BrowserDocumentFamily`, documentation can refer to it, and package exports still have a stable public word. But the source of truth is the returned object.

This is the same instinct as `satisfies`, just pointed at a different problem.

```typescript
// External contract check, value keeps its own shape.
return {
  idb,
  sync,
  clearLocalData() {},
} satisfies BrowserWorkspace;

// Factory-owned type name, factory keeps its own shape.
export type BrowserDocumentFamily = ReturnType<typeof createBrowserDocumentFamily>;
```

`satisfies` says: check this value against a contract without replacing the value. `ReturnType<typeof createX>` says: name the value after the factory defines it.

The rule is narrow on purpose. Use it when the type is exactly the return shape of one factory and the factory is the best place to understand the API. Do not use it for shared contracts implemented by several factories:

```typescript
export type MachineCredentialSecretStorage = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
};

export function createPlaintextMachineCredentialSecretStorage(): MachineCredentialSecretStorage {
  // one implementation
}

export function createKeychainMachineCredentialSecretStorage(): MachineCredentialSecretStorage {
  // another implementation
}
```

Here the contract is the source of truth. The factories are implementations. Turning `MachineCredentialSecretStorage` into the return type of one implementation would lie about ownership.

The nice version is boring:

```txt
one factory owns the shape
        |
        v
export type X = ReturnType<typeof createX>

many factories share a shape
        |
        v
export type X = { ... }
factory result satisfies or returns X
```

This is mostly about editing speed. Factory code is written as a closure: private state first, public API in the return object. Navigation should follow that structure. When a type alias points back to the factory, the editor shows you the place where behavior lives, not a duplicated sketch of it.

Related: [satisfies Lets Go to Definition Follow the Value](./satisfies-lets-go-to-definition-follow-the-value.md) covers the external-contract version of the same idea. [Types Should Be Computed, Not Declared](./types-should-be-computed-not-declared.md) covers the broader rule: when runtime code already defines a type, compute the type from the runtime code.
