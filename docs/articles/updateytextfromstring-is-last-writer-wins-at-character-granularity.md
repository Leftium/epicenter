# updateYTextFromString Is Last-Writer-Wins at Character Granularity

**TL;DR**: `updateYTextFromString` is not a CRDT operation. It's a reconciliation function that converts "desired end state" into CRDT operations using a best-effort diff, and the tradeoff is the same as every last-writer-wins system, just at a finer grain.

> Agents produce strings, not operations. They can't express fine-grained intent. Character-level diff is the best available approximation.

## What the Function Actually Does

```typescript
function updateYTextFromString(yText: Y.Text, newString: string): void {
  const currentString = yText.toString();
  if (currentString === newString) return;

  const diffs = diffChars(currentString, newString);

  yText.doc!.transact(() => {
    let index = 0;
    for (const change of diffs) {
      if (change.added) {
        yText.insert(index, change.value);
        index += change.value.length;
      } else if (change.removed) {
        yText.delete(index, change.value.length);
      } else {
        index += change.value.length;
      }
    }
  });
}
```

This reads the current state, diffs it against the desired state, and applies the minimal operations to bridge the gap. It doesn't know what the caller intended to change. It just makes the string match.

## When It's Correct, When It's Lossy

| Scenario | Outcome |
|---|---|
| No concurrent edits (agent writes while user isn't editing) | Correct. The overwhelmingly common case. |
| Concurrent edits in non-overlapping regions | Correct. Both survive. |
| Concurrent edits overlap with agent's changes | Lossy. Agent wins for the overlapping region. |
| Formatting syntax tangles with concurrent text edits | Lossy. Syntax markers and content share the same character stream. |

The first two rows cover 95%+ of real usage. The last two are real but rare: the user has to be editing the exact same region the agent is rewriting, during the agent's think window.

## The LWW Spectrum

This is the same tradeoff as every "last-writer-wins at the field level" system. The only variable is granularity.

```
┌──────────────────────┬───────────────────────┬─────────────────────┐
│ Strategy             │ Conflict Granularity  │ Blast Radius        │
├──────────────────────┼───────────────────────┼─────────────────────┤
│ clear-and-rebuild    │ entire document       │ everything lost     │
│ diffChars            │ overlapping region    │ a few characters    │
│ native CRDT ops      │ none (intent-based)   │ nothing lost        │
└──────────────────────┴───────────────────────┴─────────────────────┘
```

Clear-and-rebuild is LWW at document granularity. `diffChars` is LWW at character granularity. Native CRDT operations aren't LWW at all because they express intent, not desired end state.

The jump from document granularity to character granularity is massive. A 5000-character document where the agent changes 200 characters goes from 100% blast radius to 4%. That's not a theoretical improvement; that's the difference between "user lost 30 seconds of typing" and "user lost nothing because they were editing a different paragraph."

## Why Not Native CRDT Operations?

Because agents can't produce them. An LLM returns a string. It doesn't return "insert 'Beautiful' at position 6." You'd need to diff the agent's output against its input to recover intent, which is exactly what `updateYTextFromString` does.

```
Native CRDT path:
  Intent → Operation → State

Reconciliation path:
  Old State + Desired State → Diff → Inferred Operations → State
```

The reconciliation path guesses intent from before/after states. The guess is right whenever the changes don't overlap. When they do overlap, the last writer wins for that region. That's the tradeoff, and it's a good one.

---

## Related

- [Clear-and-Rebuild Is the Real CRDT Violation](./clear-and-rebuild-is-the-real-crdt-violation.md): The same tradeoff at document granularity
- [The Read-Modify-Write Race in CRDTs](./the-read-modify-write-race-in-crdts.md): The upstream problem that creates overlapping edits
- [Character Diffs Shrink the Blast Radius](./blast-radius-of-conflict-character-diff-vs-document-replace.md): The math on blast radius reduction
- [Markdown Formatting Markers Collide Because CRDTs Don't See Pairs](./markdown-syntax-markers-share-the-character-stream.md): The formatting-specific overlap case
