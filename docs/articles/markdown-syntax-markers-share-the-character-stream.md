# Markdown Formatting Markers Collide Because CRDTs Don't See Pairs

**TL;DR**: Y.Text treats `**bold**` and `_italic_` as individual characters, not paired delimiters, so concurrent formatting on overlapping ranges produces syntactically invalid markdown.

> When two users format overlapping text at the same time, Yjs merges the `**` characters correctly but doesn't preserve markdown pairing semantics.

## The Working Case

You're editing a Y.Text document. Two users decide to format different words:

```
Initial:   "hello world"
User A:    "**hello** world"  (bolds "hello")
User B:    "hello **world**"  (bolds "world")
Merged:    "**hello** **world**"
```

Perfect. Non-overlapping ranges. Each `**` pair stays intact.

## The Breaking Case

Now they format overlapping ranges:

```
Initial:   "hello world"
User A:    "**hello wor**ld"  (bolds "hello wor")
User B:    "hel**lo world**"  (bolds "lo world")
Merged:    "**hel**lo wor****ld"
```

The CRDT did its job. It merged the character insertions correctly. But the resulting markdown is garbage.

## Why It Happens

Yjs doesn't know that `**` is a delimiter. It sees four separate character insertions:

```
User A inserts "**" at position 0
User A inserts "**" at position 9
User B inserts "**" at position 3
User B inserts "**" at position 11
```

The CRDT resolves conflicts at the character level. It preserves causality, maintains insertion order per user, but has zero awareness of markdown syntax. The `**` characters interleave correctly as individual operations. The markdown pairing breaks.

## Tree-Based Formatting Doesn't Have This Problem

Y.XmlFragment treats formatting as metadata:

```
User A's operation: set attribute strong=true on chars 0-8
User B's operation: set attribute strong=true on chars 2-10

Merged result:
  <text strong="true">hel</text>
  <text strong="true">lo wor</text>
  <text strong="true">ld</text>
```

The tree structure knows formatting is an attribute, not text. Overlapping ranges split into segments with merged attributes. No syntax to break.

## How Often Does This Actually Matter?

Two humans formatting overlapping character ranges of the same sentence at the exact same millisecond? Rare. Agents don't format text. Local-first apps sync fast enough that most edits don't collide.

When it does happen:
- No data loss
- Markdown renders weirdly
- User manually fixes it

This is a nuisance, not a catastrophe.

## The Worse Problem: Formatting vs Content

Concurrent formatting and content edits tangle harder:

```
Initial:   "**hello** world"
User A:    changes bold to italic (delete "**", insert "_" at positions 0 and 7)
User B:    inserts " beautiful" after "hello" (inside the bold)
```

If B's edit arrives first:

```
After B:   "**hello beautiful** world"
A's diff:  computed against "**hello** world"
           now deleting at stale positions 0 and 7
```

A's delete operations, computed via `diffChars` against old text, may delete B's content along with the `**` markers. The diff algorithm doesn't see B's insertion. It just sees "remove these characters at these positions."

## Comparison

| Approach       | Format Storage | Concurrent Overlap | Content Conflicts |
|----------------|----------------|--------------------|--------------------|
| Y.Text         | Characters     | Invalid syntax     | Diff tangles       |
| Y.XmlFragment  | Attributes     | Clean merge        | Node-level ops     |

## The Honest Take

If you're building collaborative markdown and you expect frequent simultaneous formatting, Y.XmlFragment is safer. If you're building a note-taking app where most edits are sequential, Y.Text plus `diffChars` is simpler and the edge cases are tolerable.

Don't over-engineer for theoretical conflicts. Build the simple thing, measure real collisions, then decide if you need the complex thing.

> **Golden Rule**: Character-based formats merge characters, not semantics. When syntax matters, use structured storage.

---

## Related

- [The Blast Radius of Conflict](./blast-radius-of-conflict-character-diff-vs-document-replace.md): Formatting conflicts as a special case of blast radius
- [Diff-Based Sync Guesses Intent, CRDT Operations Express It](./diff-reconciliation-is-not-a-crdt-operation.md): Why the diff can tangle formatting and content edits
- [Y.Text vs Y.XmlFragment: Pick Your Tradeoff](./ytext-vs-yxmlfragment-pick-your-tradeoff.md): When tree-level formatting wins
