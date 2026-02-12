# Use a Callback with a Switch, Not a Map, for Many-to-One Lookups

**TL;DR:** When multiple keys resolve to the same value, replace your lookup map with a callback function. A switch statement handles many-to-one mappings naturally.

> Accept a function instead of a map. The caller gets switch fall-through, default cases, and zero duplication for free.

You're designing an API that maps strings to values. Something like a file extension registry:

```typescript
const registry = createLensRegistry({
    lenses: [textLens, markdownLens, csvLens],
    extensionMap: {
        '.md': 'markdown',
        '.mdx': 'markdown',
        '.markdown': 'markdown',
        '.csv': 'csv',
        '.tsv': 'csv',
        '.txt': 'text',
        '.log': 'text',
    },
});
```

Three extensions all map to `'markdown'`. Two map to `'csv'`. Two map to `'text'`. And what about `.json`? It silently gets nothing. The map forces you to enumerate every single key, repeat every shared value, and handle the fallback somewhere else entirely.

Now take a function instead:

```typescript
const registry = createLensRegistry({
    lenses: [textLens, markdownLens, csvLens],
    resolveExtension(ext: string): LensType {
        switch (ext) {
            case '.md':
            case '.mdx':
            case '.markdown':
                return 'markdown';
            case '.csv':
            case '.tsv':
                return 'csv';
            default:
                return 'text';
        }
    },
});
```

Same information, completely different ergonomics.

| Map                                  | Callback with switch               |
| ------------------------------------ | ---------------------------------- |
| Repeats values for shared keys       | Groups keys under one return       |
| No built-in fallback                 | `default` case handles it          |
| Flat structure hides relationships   | Visual grouping shows intent       |
| Every key must be listed explicitly  | Unlisted keys fall through cleanly |

The API side is simpler too. With a map, your implementation has to do `map[key] ?? fallback` and decide what the fallback is. With a callback, the caller owns the entire resolution logic:

```typescript
// API implementation: just call it
function createLensRegistry<T extends string>(options: {
    lenses: Lens[];
    resolveExtension: (ext: string) => T;
}) {
    // ...
    const lensType = options.resolveExtension(fileExtension);
    // done. no fallback logic needed here.
}
```

This works beyond simple string lookups. The callback can do prefix matching, regex, or anything else the caller needs. The map locks you into exact key equality forever.

One caveat: if you genuinely need to iterate over all registered keys (like listing supported extensions in a UI), a map gives you that for free. A callback is opaque. Pick the right tool for the actual requirement. But when the job is "given this input, give me the right output," a function with a switch is almost always the cleaner choice.
