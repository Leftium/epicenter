# TinyBase's Mergeable Store: A Map of Maps of Maps

I was exploring TinyBase's CRDT implementation when I asked DeepWiki: "What's the internal data structure for mergeable stores? Is it a map of maps?"

The answer is more interesting than I expected. It's not just nested maps; it's nested maps with CRDT metadata at every level.

## The Core Structure

Each level of the hierarchy stores three things: the data object, a timestamp, and a hash.

```javascript
// Tables: Map<tableId, [rowsObject, timestamp, hash]>
// Rows: Map<rowId, [cellsObject, timestamp, hash]>
// Cells: Map<cellId, [value, timestamp, hash]>
```

That's the pattern. Tables contain rows. Rows contain cells. Cells contain values. And at every single level, TinyBase tracks when it changed and what it looks like.

## What The Data Actually Looks Like

When you call `getMergeableContent()`, you get this:

```javascript
[
  [
    {
      pets: [
        {
          fido: [
            {species: ['dog', 'Nn1JUF-----FnHIC', 290599168]},
            '',
            2682656941,
          ],
        },
        '',
        2102515304,
      ],
    },
    '',
    3506229770,
  ],
  [{}, '', 0],
]
```

Let me break that down.

The innermost piece is the cell:

```javascript
{species: ['dog', 'Nn1JUF-----FnHIC', 290599168]}
//         ^       ^                   ^
//         value   timestamp (HLC)     hash
```

The value `'dog'` is the actual data. `'Nn1JUF-----FnHIC'` is a hybrid logical clock timestamp. `290599168` is a hash for integrity checking.

Move up one level to the row:

```javascript
{
  fido: [
    {species: ['dog', 'Nn1JUF-----FnHIC', 290599168]}, // cells object
    '',           // row timestamp
    2682656941,   // row hash
  ],
}
```

The row `fido` contains its cells object, plus its own timestamp and hash.

And the table level:

```javascript
{
  pets: [
    { /* rows object */ },
    '',           // table timestamp
    2102515304,   // table hash
  ],
}
```

Same pattern. Rows object, timestamp, hash.

## Where Do The IDs Live?

Here's a question that tripped me up: do the rows and cells store their own IDs?

No. The IDs are the keys in the containing maps; they're not stored within the objects themselves.

```javascript
{
  pets: [           // "pets" is the table ID (key)
    {
      fido: [       // "fido" is the row ID (key)
        {
          species: ['dog', ...]  // "species" is the cell ID (key)
        },
        ...
      ],
    },
    ...
  ],
}
```

Table ID → key in tables map. Row ID → key in rows object. Cell ID → key in cells object. The data objects themselves only contain values and CRDT metadata.

## The Implementation

TinyBase initializes a `contentStampMap` that tracks this entire hierarchy:

```javascript
var createMergeableStore = (uniqueId) => {
  let listeningToRawStoreChanges = 1;
  let contentStampMap = newContentStampMap();
  let defaultingContent = 0;
  const touchedCells = mapNew();
  const touchedValues = setNew();
  const [getHlc, seenHlc] = getHlcFunctions(uniqueId);
  const store = createStore();
  // ...
};
```

The `contentStampMap` is the source of truth for all the CRDT metadata. When merging changes, TinyBase walks this structure:

```javascript
const mergeContentOrChanges = (contentOrChanges, isContent = 0) => {
  const tablesChanges = {};
  const valuesChanges = {};
  const [
    [tablesObj, incomingTablesTime = EMPTY_STRING, incomingTablesHash = 0],
    values
  ] = contentOrChanges;
  const [tablesStampMap, valuesStampMap] = contentStampMap;
  const [tableStampMaps, oldTablesTime, oldTablesHash] = tablesStampMap;
  let tablesHash = isContent ? incomingTablesHash : oldTablesHash;
  let tablesTime = incomingTablesTime;

  objForEach(
    tablesObj,
    ([rowsObj, incomingTableTime, incomingTableHash], tableId) => {
      // Process each table...
      objForEach(rowsObj, (row, rowId) => {
        // Process each row...
        // Merge cells, update hashes, track changes
      });
    }
  );
  // ...
};
```

It destructures incoming content at each level, comparing timestamps and updating hashes as it goes.

## How Conflicts Resolve

The timestamps come from a hybrid logical clock (HLC). When two clients edit the same cell, the one with the later timestamp wins. TinyBase calls this "last write wins."

But here's the thing: the hashes at each level let TinyBase detect conflicts efficiently. If the hash for a table hasn't changed, there's nothing to merge at that level. The hash is computed from all the children, so changes bubble up.

```javascript
tableHash ^= isContent
  ? 0
  : (oldRowHash ? hashIdAndHash(rowId, oldRowHash) : 0)
    ^ hashIdAndHash(rowId, rowHash);
```

XOR-based hash updates. When a row changes, the table's hash changes. When a cell changes, the row's hash changes. Fast change detection at any level of the hierarchy.

## Regular Store vs Mergeable Store

A regular TinyBase `Store` uses simple nested objects. No timestamps. No hashes. Just data:

```javascript
// Regular store
{
  pets: {
    fido: { species: 'dog' }
  }
}
```

The `MergeableStore` extends this with CRDT capabilities. The API surface (`getCell`, `setCell`) stays the same, but the internal representation carries all the metadata needed for synchronization.

You can still get clean data without metadata using `getContent()`. But when you need to sync, `getMergeableContent()` gives you everything.

## The Takeaway

TinyBase's mergeable store is a clean example of nested CRDT metadata. Every level of the table→row→cell hierarchy carries its own timestamp and hash. IDs are map keys, not embedded data. Hashes enable efficient change detection. Timestamps enable deterministic conflict resolution.

It's a map of maps of maps, yes. But each map entry is also a tuple of `[data, timestamp, hash]`. That's what makes it mergeable.

## Sources

- [TinyBase MergeableStore Guide](https://tinybase.org/guides/synchronization/using-a-mergeablestore/)
- [TinyBase createMergeableStore API](https://tinybase.org/api/mergeable-store/functions/creation/createmergeablestore/)
- [getMergeableContent API](https://tinybase.org/api/mergeable-store/interfaces/mergeable/mergeablestore/methods/getter/getmergeablecontent/)
- DeepWiki Q&A on tinyplex/tinybase
