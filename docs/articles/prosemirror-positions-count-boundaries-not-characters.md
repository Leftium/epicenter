# ProseMirror Positions Count Node Boundaries, Not Characters

**TL;DR**: ProseMirror positions count node open/close boundaries in addition to characters, which means a 15-character markdown string doesn't map to 15 positions.

> "When you think you can convert markdown offsets to ProseMirror positions with simple arithmetic, you've misunderstood the position system."

## The Problem

I was building a Y.Text-backed ProseMirror editor. Y.Text stores markdown as a flat string. The user's cursor is at offset 8 in that string. I need to place the ProseMirror cursor at the equivalent position.

My first instinct: markdown offset 8 = ProseMirror position 8. Ship it.

This breaks immediately.

## Show the Mismatch

Here's a markdown string:

```
"# Hello\n\nWorld"
 0123456 7 89...
```

15 characters. Offsets 0-14.

Here's the same content as ProseMirror positions:

```
doc                     0
  heading(level=1)      1  (open boundary)
    "Hello"             2,3,4,5,6
                        7  (close boundary)
  paragraph             8  (open boundary)
    "World"             9,10,11,12,13
                        14 (close boundary)
                        15 (doc close)
```

16 positions. The document has more positions than the markdown has characters.

## Where the Positions Come From

ProseMirror counts every node boundary as a position:

| Markdown String     | ProseMirror Positions |
|---------------------|----------------------|
| `# ` (2 chars)      | 0 positions (encoded as node type) |
| `Hello` (5 chars)   | 5 positions (2-6) |
| heading node        | 2 positions (open=1, close=7) |
| `\n\n` (2 chars)    | 0 positions (implicit in boundaries) |
| paragraph node      | 2 positions (open=8, close=14) |
| `World` (5 chars)   | 5 positions (9-13) |
| doc node            | 2 positions (open=0, close=15) |

The `# ` markup occupies 2 characters in the string but zero positions in ProseMirror. It's not text, it's a signal to create a `heading(level=1)` node. That node's boundaries (positions 1 and 7) are what count.

The blank line `\n\n` also occupies 2 characters but adds no positions. It signals "close the heading, open a paragraph." The transition from position 7 (heading close) to position 8 (paragraph open) encodes that gap.

## Building the Translation Table

You can't convert markdown offset to ProseMirror position with a formula. You need a translation table built during serialization:

```typescript
// Serialize ProseMirror → markdown, track positions
function serialize(doc: Node): { markdown: string, offsetToPos: Map<number, number> } {
  const map = new Map<number, number>();
  let mdOffset = 0;
  let pmPos = 1; // start inside doc

  function walk(node: Node) {
    if (node.isText) {
      for (let i = 0; i < node.text.length; i++) {
        map.set(mdOffset++, pmPos++);
      }
    } else {
      if (node.type.name === 'heading') {
        // "# " in markdown, no positions
        mdOffset += node.attrs.level === 1 ? 2 : 3;
      }
      pmPos++; // node open boundary
      node.forEach(child => walk(child));
      pmPos++; // node close boundary
    }
  }

  walk(doc);
  return { markdown: serialize(doc), offsetToPos: map };
}
```

When a Y.Text cursor lands at offset 0 or 1 (inside `# `), there's no valid ProseMirror position. You snap to the nearest valid position:

```typescript
function snapToValidPosition(mdOffset: number, map: Map<number, number>): number {
  if (map.has(mdOffset)) return map.get(mdOffset)!;

  // Snap forward to next valid position
  for (let i = mdOffset; i < 1000; i++) {
    if (map.has(i)) return map.get(i)!;
  }

  // Fallback: end of doc
  return map.size + 1;
}
```

This is why cursor positions near formatting boundaries lose 1-3 characters of precision in a Y.Text-backed editor.

## Why y-prosemirror Doesn't Need This

The canonical y-prosemirror binding uses Y.XmlFragment. Its tree structure matches ProseMirror's position space:

```
Y.XmlFragment (doc)
  Y.XmlElement('heading', {level: 1})
    Y.Text('Hello')
  Y.XmlElement('paragraph')
    Y.Text('World')
```

A `Y.XmlElement('heading')` IS the open/close boundary. The CRDT tree has the same shape as ProseMirror's position system. No translation needed.

With Y.Text, the CRDT stores `"# Hello\n\nWorld"`. You serialize ProseMirror → markdown, then parse markdown → ProseMirror. The translation table must be rebuilt on every change. Every remote edit from another user forces a full parse to discover where the new positions are.

## The Trade-Off Table

| Approach        | Cursor Precision | Parse Cost | CRDT Simplicity |
|-----------------|------------------|------------|-----------------|
| Y.XmlFragment   | Exact            | None       | Complex tree    |
| Y.Text          | ±1-3 chars       | Every edit | Flat string     |

## When This Breaks Down

Nested nodes amplify the gap:

```markdown
# Hello **bold** text
```

```
doc                           0
  heading                     1
    "Hello "                  2-7
    strong                    8 (open)
      "bold"                  9-12
                              13 (close)
    " text"                   14-18
                              19 (close heading)
```

The `**` markers (4 chars total) occupy zero positions. The strong node adds 2 positions (open/close). A 22-character string maps to 20 positions.

For deeply nested documents (lists inside blockquotes inside lists), the offset/position gap grows. The translation table gets expensive to maintain.

## The Golden Rule

**Node boundaries are positions.** If you're building a ProseMirror binding for a flat CRDT, budget for a translation layer. The precision loss is inherent to the mismatch between flat offsets and hierarchical positions.

---

## Related

- [Nobody Built ProseMirror on Y.Text Because Nobody Needed To](./why-nobody-built-prosemirror-on-ytext.md): The architecture that requires this position mapping
- [Full Doc Replacement Is a UI Problem, Not a Data Problem](./full-doc-replacement-is-a-ui-problem-not-a-data-problem.md): Why cursor restoration matters after replacement
- [Y.Text vs Y.XmlFragment: Pick Your Tradeoff](./ytext-vs-yxmlfragment-pick-your-tradeoff.md): The full comparison
