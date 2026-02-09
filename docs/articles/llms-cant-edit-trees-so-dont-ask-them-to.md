# LLMs Can't Edit Trees (So Don't Ask Them To)

**TL;DR: Keep Y.XmlFragment for humans and give AI agents a text-based `str_replace` interface instead of tree manipulation tools.**

> Design your data structures for humans. AI agents will adapt.

## Tree Edits Are Unnatural for LLMs

We wanted AI agents to collaboratively edit rich text documents alongside humans in Epicenter. The documents live in Yjs as Y.XmlFragment, which is what ProseMirror and TipTap bind to natively. The obvious approach: give the agent tools that manipulate the XML tree directly.

Here's what that looks like:

```typescript
// What the agent has to produce to create a simple bullet list:
insert_node({
  parentPath: [2],
  index: 0,
  node: {
    type: "bullet_list",
    content: [{
      type: "list_item",
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: "Buy milk" }]
      }]
    }, {
      type: "list_item",
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: "Walk dog" }]
      }]
    }]
  }
})
```

Compare that to how the same agent would express this in text:

```
- Buy milk
- Walk dog
```

The tree version requires the agent to know ProseMirror's schema (list items must contain paragraphs, text nodes are leaves), compute correct tree paths, and construct valid nested JSON. The text version is two lines of markdown. Every LLM on earth has seen millions of markdown bullet lists during training. Almost none have seen ProseMirror node trees.

## Y.Text vs Y.XmlFragment: The Agent's Perspective

Yjs offers two ways to represent rich text:

| | Y.Text | Y.XmlFragment |
|---|---|---|
| Internal structure | Flat sequence with formatting markers | Tree of elements |
| How headings work | `\n` with `{ header: 1 }` attribute | `Y.XmlElement('heading')` with children |
| How lists work | `\n` with `{ list: 'bullet', indent: N }` | Nested `list > list_item > paragraph` |
| str_replace | Find index in flat string, delete+insert | Walk tree to find Y.XmlText node, then delete+insert |
| ProseMirror binding | Not supported (tree model required) | Native via y-prosemirror |

Y.Text is a flat string with formatting sprinkled in via Quill-style deltas. For an AI agent, it's trivial to work with: read the string, find what you want to change, do a `str_replace`. The entire document is one searchable sequence.

Y.XmlFragment is a tree. Rich text editors need trees because documents have structure: a list item inside a blockquote inside a table cell. Y.Text can fake shallow nesting with `indent` attributes, but it falls apart for deeply nested structures. ProseMirror's document model is fundamentally a tree, so y-prosemirror requires Y.XmlFragment.

So you have two options. Force humans onto Y.Text: the agent gets an easy interface, but you lose native ProseMirror support, deep nesting, and the entire y-prosemirror ecosystem. Or keep Y.XmlFragment for humans and make the AI work through a text interface: serialize to markdown, edit via `str_replace`, convert text operations back into Yjs tree mutations.

We chose the second. AI is built to live in a world designed for humans, not the other way around. ProseMirror with Y.XmlFragment is the gold standard for collaborative rich text editing. Degrading the human experience to simplify the AI integration gets the priority order backwards.

## How the AI Interface Works

The agent never sees Yjs types. It gets three tools:

```
Agent                    Middleware                 Yjs
  │                          │                       │
  │  viewDocument()          │                       │
  │─────────────────────────>│   serialize fragment   │
  │                          │<──────────────────────│
  │  <-- markdown string     │                       │
  │                          │                       │
  │  strReplace(old, new)    │                       │
  │─────────────────────────>│   walk tree, find     │
  │                          │   Y.XmlText node,     │
  │                          │   delete+insert       │
  │                          │──────────────────────>│
  │                          │                       │
  │  createList(items)       │                       │
  │─────────────────────────>│   build Y.XmlElement  │
  │                          │   tree, insert into   │
  │                          │   fragment             │
  │                          │──────────────────────>│
```

For reading, serialize the Y.XmlFragment to markdown. The agent sees plain text.

For editing existing content, `str_replace` is the workhorse. The agent says "find this exact string, replace it with that." Your code walks the Y.XmlFragment tree, finds the Y.XmlText node containing that string, and does a surgical `delete` + `insert` inside a `doc.transact()`. Cursors, undo history, and other users' selections are preserved because you're only touching the characters that changed.

For creating new structured content, you need semantic tools. The agent calls `createList({ items: ["Buy milk", "Walk dog"] })` and your tool handles constructing the correct Y.XmlElement tree internally. The agent says what it wants; your code figures out the ProseMirror-compatible node structure.

```typescript
function findAndReplaceInFragment(
  parent: Y.XmlFragment | Y.XmlElement,
  oldStr: string,
  newStr: string,
): boolean {
  for (let i = 0; i < parent.length; i++) {
    const child = parent.get(i);
    if (child instanceof Y.XmlText) {
      const text = child.toString();
      const idx = text.indexOf(oldStr);
      if (idx !== -1) {
        ydoc.transact(() => {
          child.delete(idx, oldStr.length);
          child.insert(idx, newStr);
        }, 'ai-agent');
        return true;
      }
    }
    if (child instanceof Y.XmlElement) {
      if (findAndReplaceInFragment(child, oldStr, newStr)) return true;
    }
  }
  return false;
}
```

The `'ai-agent'` origin tag on the transaction lets you filter AI changes in the UndoManager, so humans can undo agent edits without losing their own work.

## The Trade-off

This approach isn't free. Serializing to markdown and back is lossy for complex formatting. Custom ProseMirror node types with specific attributes might not survive the round-trip. And the semantic tools (createList, insertHeading) need to be built per-schema; there's no generic "insert any ProseMirror content" tool that works reliably.

But the alternative is worse. Asking an LLM to construct valid ProseMirror node trees with correct nesting, required attributes, and schema-compliant structure is asking it to do something it's fundamentally not good at. You'll spend more time debugging malformed tree operations than you'd spend building the middleware.

The pattern we landed on: human-native data structures, AI-friendly interface layer on top. str_replace for edits, semantic tools for creation, markdown serialization for reading. The AI lives in a text world. The humans get their rich editor. The middleware bridges the gap.
