# Full Doc Replacement Is a UI Problem, Not a Data Problem

**TL;DR**: When you rebuild the ProseMirror document tree from Y.Text, you're not breaking CRDT semantics. You're just re-rendering the view.

> The panic around "full document replacement" comes from confusing two layers. At the CRDT layer, nothing gets replaced. At the view layer, everything does. One preserves data integrity, the other causes cursor jumps.

## The Two Layers

When people hear "full document replacement" in a CRDT context, they assume data integrity is at risk. It's not. You need to separate what's happening at the data layer from what's happening at the UI layer.

Here's what actually runs:

```typescript
// Y.Text layer: CRDT operations (data)
function updateYTextFromString(yText: Y.Text, newContent: string) {
  const diff = diffChars(yText.toString(), newContent);
  yText.doc.transact(() => {
    diff.forEach(op => {
      if (op.removed) yText.delete(op.position, op.count);
      if (op.added) yText.insert(op.position, op.value);
    });
  });
}

// ProseMirror layer: view rebuild (UI)
function replaceProseMirrorDoc(view: EditorView, newContent: string) {
  const newDoc = parseMarkdown(newContent);
  const tr = view.state.tr.replaceWith(
    0,
    view.state.doc.content.size,
    newDoc.content
  );
  view.dispatch(tr);
}
```

The Y.Text function applies minimal diffs. The ProseMirror function nukes the entire tree and rebuilds it. Both run in a typical syncing flow, but they operate on different layers.

## What Stays Intact

At the Y.Text layer, nothing is fully replaced. `updateYTextFromString` runs `diffChars` and applies minimal insert/delete ops. Unchanged characters keep their CRDT identity. This is textbook correct CRDT usage.

```
Y.Text (CRDT layer):
  diffChars("Hello World", "Hello Beautiful World")
  → keep "Hello ", insert "Beautiful ", keep "World"
  → CRDT identity preserved for "Hello " and "World" ✅
```

When another user inserts "Wonderful" at position 0, the CRDT merge works correctly because the character identities are intact. Your "Beautiful" and their "Wonderful" both resolve to the right positions. No data loss, no merge confusion.

## What Gets Replaced

At the ProseMirror layer, yes, the entire document tree gets rebuilt from the parsed Y.Text string. But ProseMirror is not a CRDT. It's a view. Replacing the ProseMirror document is like re-rendering a React component. The source of truth (Y.Text) is intact; you're just refreshing the screen.

```
ProseMirror (view layer):
  parse("Hello Beautiful World") → new doc tree
  tr.replaceWith(0, doc.content.size, newDoc.content)
  → entire tree replaced, all nodes are new objects
  → cursor position lost, plugins recalculate ⚠️
```

Every node in the ProseMirror tree is a new JavaScript object. Your cursor position is gone. Your IME composition state is gone. Your plugin decorations need to recalculate.

These are UI problems, not data problems.

## The Actual Problems

The problems from full doc replacement at the ProseMirror level are UX issues:

**Cursor jumps**: Your cursor was at position 23. The doc tree gets rebuilt. Position 23 might now be inside a different paragraph or off the end of the document. You need to save cursor position as a `Y.RelativePosition` (anchored to CRDT characters) and restore it after the rebuild.

**IME composition breaks**: You're typing Japanese with an IME. The composition input is holding "k" and "a" waiting for you to select "か". If the doc rebuilds mid-composition, the IME state is lost. The half-composed characters vanish. You need to guard against updates during active IME composition.

**Plugin decorations recalculate**: Your syntax highlighting plugin decorated 50 code blocks. The doc rebuilds. All those decorations are gone. The plugin has to re-scan the entire document and recalculate. This causes visible flashing or lag.

None of these break data integrity. They make the editor feel janky.

## The Status Quo

Here's the kicker: y-prosemirror already does full document replacement on remote changes. Look at issue #113 in the y-prosemirror repo. The `_typeChanged` function rebuilds the entire ProseMirror fragment when remote updates come in. This is the production status quo everyone ships today.

```typescript
// From y-prosemirror source
_typeChanged(event) {
  // ...builds new ProseMirror fragment from Y.XmlFragment...
  const tr = this.view.state.tr.replaceWith(
    startPos,
    endPos,
    fragment
  );
  this.view.dispatch(tr);
}
```

Local edits get incremental updates. Remote edits get full replacement. This asymmetry is already in production. The cursor jumping and IME issues people report in y-prosemirror? This is why.

## The Real Data Problem

Now compare to full replacement at the Y.XmlFragment level. That's a different story.

```typescript
// ❌ This breaks CRDT semantics
function replaceYXmlFragment(fragment: Y.XmlFragment, newContent: Node[]) {
  fragment.doc.transact(() => {
    // Delete all existing children
    while (fragment.length > 0) {
      fragment.delete(0, 1);
    }
    // Insert new children
    newContent.forEach(node => fragment.push([createYXmlElement(node)]));
  });
}
```

When you delete all children from Y.XmlFragment, you're deleting CRDT nodes. If another user has a concurrent edit targeting one of those deleted nodes (like inserting a child inside paragraph 2), their operation targets a tombstone. The CRDT merge can't resolve it. Their edit is lost.

This is a data integrity problem. You've destroyed CRDT identity at the data layer, not just the view layer.

## The Matrix

| Layer | Full replacement | Data problem? | UI problem? |
|---|---|---|---|
| Y.Text (diffChars) | Not full replacement; minimal ops | No | No |
| ProseMirror view | Full tree rebuild | No | Yes (cursor, IME, plugins) |
| Y.XmlFragment (clear-rebuild) | Delete all + reinsert | YES | Yes |

The first row is what we're doing. The third row is what people fear we're doing.

## The Golden Rule

View rebuilds are fine as long as the CRDT layer applies minimal diffs. The cursor jumps and IME breakage are real problems, but they're solvable UI problems. You fix them with cursor position tracking and composition guards. You don't fix them by avoiding diffChars at the data layer.

---

## Related

- [Clear-and-Rebuild Is the Real CRDT Violation](./clear-and-rebuild-is-the-real-crdt-violation.md): When full replacement IS a data problem
- [ProseMirror Positions Count Boundaries, Not Characters](./prosemirror-positions-count-boundaries-not-characters.md): Why cursor restoration after replacement is hard
- [Nobody Built ProseMirror on Y.Text Because Nobody Needed To](./why-nobody-built-prosemirror-on-ytext.md): The architecture that leads to this tradeoff
- [yjs/y-prosemirror#113](https://github.com/yjs/y-prosemirror/issues/113): Remote changes trigger full doc replacement
- Y.RelativePosition API: CRDT-aware cursor position encoding
