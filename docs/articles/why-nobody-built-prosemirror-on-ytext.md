# Nobody Built ProseMirror on Y.Text Because Nobody Needed To

**TL;DR: The standard y-prosemirror binding uses Y.XmlFragment because it maps ProseMirror's tree structure directly to CRDT tree structure. That works perfectly until you add a second writer that thinks in strings, not trees.**

> "The problem isn't collaborative editing between browsers. The problem is collaborative editing between a human with a rich text editor and an agent with a file handle."

I was building a file system backed by Y.js and hit a wall. ProseMirror edits the document, user saves, file writes to disk as markdown. Later, an agent modifies the markdown file directly. File watcher picks up the change, needs to sync it back to the ProseMirror editor.

The agent doesn't know about ProseMirror nodes. It just did a string replacement on markdown text. Now I need to translate "here's the new file content" into Y.XmlFragment operations. There's no clean path.

## The Architecture Gap

Here's what normal collaborative editing looks like:

```
ProseMirror ←→ y-prosemirror ←→ Y.XmlFragment ←→ Network
(tree)          (tree binding)    (tree CRDT)
```

Every piece speaks the same language: trees. ProseMirror represents a document as a tree of nodes. Y.XmlFragment represents a CRDT as a tree of elements. The y-prosemirror binding walks both trees in lockstep and keeps them in sync. When you type, it translates tree mutations. When a remote user types, it translates CRDT mutations back to tree mutations.

This works. If you're building Google Docs, this is exactly what you want.

Now add an external writer:

```
ProseMirror ←→ y-prosemirror ←→ Y.XmlFragment ←→ Network
(tree)          (tree binding)    (tree CRDT)
                                      ↑
Agent writes string ──→ ??? ──────────┘
                  (no good path)
```

The agent produces a string: "# Hello\n\nThis is the new content." You need to turn that into Y.XmlFragment operations: insert an XmlElement('heading') at index 0, insert an XmlText with 'Hello', insert an XmlElement('paragraph') at index 1.

The only way to do this is parse the markdown, build a ProseMirror document tree, diff the tree against the existing Y.XmlFragment tree, generate CRDT operations from the diff. But tree diffing is expensive and fragile. You need to track node identity across changes. If the agent rewrote a paragraph, is that an update to the existing node or a delete-and-insert?

The easy path is clear-and-rebuild: delete everything in Y.XmlFragment, rebuild from scratch. But that destroys CRDT identity. Every node gets a new ID. Cursors break. Undo/redo breaks. You lose the entire point of using a CRDT.

## The Y.Text Alternative

What if the CRDT stored a flat string instead of a tree?

```
ProseMirror ←→ custom binding ←→ Y.Text ←→ Network
(tree)          (serialize/parse)  (flat CRDT)
                                     ↑
Agent writes string ──→ diffChars ───┘
                  (clean path)
```

Now the external writer has a natural path to the CRDT. The agent produces a string. You diff the string character-by-character against the Y.Text CRDT. You generate insert/delete operations at specific character positions. The CRDT maintains identity because you're not touching the tree, you're just editing text.

The cost is the custom binding. You need to:

1. Serialize ProseMirror tree to markdown on every keystroke
2. Parse markdown to ProseMirror tree on every remote change
3. Map cursor positions between tree coordinates and string offsets

That sounds expensive. But here's the thing: y-prosemirror already does full document replacement on remote changes. There's an open issue (yjs/y-prosemirror#113) about how the standard binding doesn't do fine-grained updates. It replaces entire subtrees. The custom Y.Text binding adds a parse step on top of similar replacement logic. The marginal cost is the parser, not the replacement.

## When Trees Win vs. When Strings Win

| Scenario | Best CRDT Shape | Why |
|----------|----------------|-----|
| Browser-only collab | Y.XmlFragment | All writers speak tree, direct mapping is faster |
| Filesystem-backed docs | Y.Text | External tools speak strings, avoid tree diffing |
| LLM-generated content | Y.Text | Models output strings, not structured trees |
| API-driven edits | Y.Text | REST endpoints send strings, not node trees |

The trade-off is clear:

**Y.XmlFragment**: Faster synchronization between ProseMirror instances. No serialization overhead. Tree structure preserved in CRDT.

**Y.Text**: Clean integration with string-based writers. Character-level diffing instead of tree diffing. Single source of truth for document content.

If all your writers are ProseMirror instances in browsers, use Y.XmlFragment. The standard y-prosemirror binding is battle-tested and fast.

If you have agents, file watchers, CLI tools, or any writer that produces strings instead of trees, use Y.Text. The parser cost is worth avoiding tree diffing hell.

## Why Nobody Built This Before

The use case didn't exist. Collaborative editors were browser-to-browser. The CRDT lived in memory, synchronized over WebSocket, maybe persisted to a database. But the database stored CRDT updates, not readable text.

The filesystem-backed collaborative editor is new. You want the CRDT benefits (real-time sync, offline edits, conflict resolution) and the filesystem benefits (git, grep, agents, portability). That requires a CRDT that can round-trip through string serialization without losing identity.

Y.Text gives you that. Y.XmlFragment doesn't.

**The Golden Rule**: Match your CRDT shape to your writers. All writers speak tree? Store a tree. Any writer speaks strings? Store a string.

---

## Related

- [ProseMirror Positions Count Boundaries, Not Characters](./prosemirror-positions-count-boundaries-not-characters.md): The position mapping challenge for a Y.Text binding
- [Full Doc Replacement Is a UI Problem, Not a Data Problem](./full-doc-replacement-is-a-ui-problem-not-a-data-problem.md): Why the custom binding's full replacement isn't a CRDT concern
- [Parser Fidelity Is Your Single Point of Failure](./parser-fidelity-is-your-single-point-of-failure.md): The risk of the serialize/parse round-trip
- [Y.Text vs Y.XmlFragment: Pick Your Tradeoff](./ytext-vs-yxmlfragment-pick-your-tradeoff.md): The full comparison
- [yjs/y-prosemirror#113](https://github.com/yjs/y-prosemirror/issues/113): Full doc replacement in y-prosemirror
