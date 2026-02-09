# Parser Fidelity Is Your Single Point of Failure

**TL;DR**: When ProseMirror sits on Y.Text, every edit runs a parse→serialize cycle. If your parser doesn't understand a markdown construct, the serialize step silently destroys it.

> With Y.Text, your parser is the bottleneck. Incomplete plugin support means permanent data loss on the next edit.

## The Concrete Failure

I was testing a Y.Text-backed ProseMirror setup. Someone had written this in a document:

```markdown
some ~~strikethrough~~ text
```

My parser didn't have the GFM plugin loaded. Watch what happens when a user fixes a typo somewhere else in the document:

```
┌─────────────────────────────────────────────────────┐
│ Y.Text: "some ~~strikethrough~~ text"              │
└─────────────────────────────────────────────────────┘
                     │
                     ▼ parse (no GFM plugin)
┌─────────────────────────────────────────────────────┐
│ ProseMirror: plain text with literal ~~ characters │
└─────────────────────────────────────────────────────┘
                     │
                     ▼ user edits (different paragraph)
┌─────────────────────────────────────────────────────┐
│ ProseMirror: needs to serialize full document back │
└─────────────────────────────────────────────────────┘
                     │
                     ▼ serialize
┌─────────────────────────────────────────────────────┐
│ Y.Text: "some \\~\\~strikethrough\\~\\~ text"       │
└─────────────────────────────────────────────────────┘
```

The strikethrough is gone. Permanently. The serializer saw literal tilde characters in ProseMirror's tree and escaped them. The markup is now backslash-escaped plain text.

Here's the code that creates this trap:

```typescript
// Your ProseMirror schema knows about strikethrough
const schema = new Schema({
  marks: {
    strikethrough: { /* ... */ }
  }
});

// But your parser doesn't
const parser = MarkdownParser.fromSchema(schema, remarkParse, {
  // No remark-gfm plugin loaded
  // Parser sees ~~ as literal characters, not markup
});

// User makes any edit
doc.apply(transaction);

// Serialize runs on the full document
const markdown = serializer.serialize(doc);

// Y.Text gets updated with escaped tildes
ytext.delete(0, ytext.length);
ytext.insert(0, markdown);
```

This isn't a formatting preference swap like `*italic*` vs `_italic_`. Both of those preserve the semantic meaning. This is destruction. The markup is gone and you can't get it back.

## The Rule

Your parser and serializer must handle every markdown construct that will ever appear in your documents. Not most of them. Every single one. No partial support.

If you add GFM tables to your schema later, you need table support in both parser and serializer at the same time. Not next week. Not after the feature ships. Simultaneously.

Otherwise, existing tables in Y.Text get mangled the first time someone edits a document that contains them.

## Y.XmlFragment Doesn't Have This Problem

Compare to Y.XmlFragment backing. The CRDT stores a tree. If that tree has a node type the editor doesn't understand, y-prosemirror can represent it as an opaque block:

```typescript
// Y.XmlFragment contains a node type your schema doesn't know about
const unknownNode = doc.firstChild; // type: "customWidget"

// y-prosemirror creates a placeholder node
const pmNode = schema.node("unknown", { xmlNode: unknownNode });

// User edits something else
// Serialize runs

// The serializer writes back what it got
unknownNode.parent.insertAfter(unknownNode, editedContent);
// The unknown node survives untouched
```

Unknown constructs survive because the tree preserves them structurally. The editor doesn't need to understand them; it just needs to not delete them.

With Y.Text, the string passes through two layers on every round trip:

1. **Interpretation layer** (parse): text → tree
2. **Generation layer** (serialize): tree → text

Both layers must be lossless for everything in your documents. The interpretation layer is the single point of failure. If the parser doesn't understand something, it's not in the tree. If it's not in the tree, the serializer can't write it back.

## The Comparison

| Backing Type    | Unknown Constructs | Parser Coverage | Data Loss Risk |
|-----------------|--------------------|-----------------|----------------|
| Y.XmlFragment   | Preserved as nodes | Partial OK      | Low            |
| Y.Text          | Lost on parse      | Must be total   | High           |

## Mitigation

Audit your remark plugins before you ship. Every plugin your parser loads must have a matching serializer rule.

Test round-trip fidelity for every markdown construct in your documents:

```typescript
const testCases = [
  "~~strikethrough~~",
  "==highlight==",
  "[[wikilink]]",
  "^footnote[1]",
  // Every construct users can create
];

testCases.forEach(markdown => {
  const doc = parser.parse(markdown);
  const serialized = serializer.serialize(doc);
  assert.equal(serialized.trim(), markdown);
});
```

Add parser plugins before users start creating content that uses them. Not after you notice broken documents.

If you inherit a Y.Text setup with incomplete parser support, your options are grim: audit every document for unsupported constructs, add the plugins, then hope no one saved during the gap. Or migrate to Y.XmlFragment where this isn't a trap.

## The Golden Rule

With Y.Text backing, your parser coverage defines your data integrity. 99% fidelity means 1% of your users' content gets destroyed. Aim for 100% or pick a different backing type.

---

## Related

- [Markdown Normalization Converges in One Pass](./markdown-normalization-converges-in-one-pass.md): When the parse-serialize cycle changes syntax but not content
- [Markdown Formatting Markers Collide Because CRDTs Don't See Pairs](./markdown-syntax-markers-share-the-character-stream.md): Another Y.Text-specific failure mode
- [Y.Text vs Y.XmlFragment: Pick Your Tradeoff](./ytext-vs-yxmlfragment-pick-your-tradeoff.md): When parser risk tips the balance
- `RESEARCH_TREE_DIFFING_ANALYSIS.md`: Tree diffing challenges for Y.XmlFragment
