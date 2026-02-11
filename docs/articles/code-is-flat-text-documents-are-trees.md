# Code Is Flat Text; Documents Are Trees. That's Why AI Editing Is Harder in Prose.

**TL;DR**: AI code editors work because code is flat text with line numbers. Rich text editors are trees with schema validation, making LLM-powered editing categorically harder.

> "LLMs output tokens. Code is tokens with newlines. Rich text is a tree you have to validate on every mutation."

Cursor and Copilot make AI editing look solved. You highlight some code, describe what you want, and it just works. The edits apply cleanly. The diffs are readable. It feels like magic.

Then you try the same thing with a rich text editor. ProseMirror, TipTap, Notion. Suddenly everything is harder. Positions are wrong. Edits break schema constraints. Marks don't apply correctly. What changed?

The structure changed. Code lives as flat text. Rich text lives as a tree.

## Why Code Editing Works

Here's what a code file looks like to an LLM:

```
1: function createUser(name: string) {
2:   return { id: generateId(), name };
3: }
```

It's an array of strings split by newlines. Line numbers give you stable anchors. When you want to edit line 2, you point at line 2. Done.

The standard output format for code edits is a unified diff. Search for some text, replace it with other text. Or just output the whole file and let the editor compute the diff. Both approaches work because the underlying structure is simple: a string with line breaks.

Yes, code has AST structure. Parsers build trees from it. But edits happen at the text level. You can rewrite a function without understanding its parse tree. The compiler will tell you if you broke something after you're done.

## Why Rich Text Is Different

Here's what the same content looks like in ProseMirror:

```
Doc
├─ Paragraph
│  ├─ Text("Hello ")
│  └─ Text("world", [bold])
└─ BulletList
   └─ ListItem
      └─ Paragraph
         └─ Text("Item one")
```

It's a tree. Every node has a type. Every type has schema constraints. Text nodes can have marks. Blocks can nest according to specific rules.

When you want to edit "world" to "there", you can't just search and replace. You need to find the text node, compute its position in the document (as a depth-first traversal offset, not a line number), create a transaction that deletes the range and inserts new text, then run schema validation on the result.

If you want to make "there" italic instead of bold, you need to remove the bold mark and add the italic mark. Marks aren't properties on nodes; they're decorations that span across text nodes. The schema defines which marks can coexist.

Want to change a paragraph into a heading? You need to replace the node type, but only if the parent container allows headings at that position. The schema enforces this on every mutation.

## The Structural Divide

| Dimension | Code | Rich Text |
|-----------|------|-----------|
| Structure | Flat (lines) | Tree (nested nodes) |
| Position ref | Line numbers | Depth-first offsets |
| Schema validation | None at edit time | Every mutation |
| Natural diff unit | Line | Node (varies by depth) |
| LLM output format | Just text | Must match schema |
| Full rewrite approach | Output the file | Needs roundtrip format |

The key difference is when validation happens. For code, you write invalid syntax all the time. The editor doesn't stop you. You get squiggly lines, but you can save the file. The compiler complains later. This gives LLMs room to work.

For rich text, invalid structure is rejected immediately. You cannot insert a list item outside a list. You cannot apply a mark the schema doesn't define. ProseMirror throws an error. The document stays in its previous valid state.

This means an LLM can't just output new content. It has to output content that passes schema validation for your specific editor configuration. That's a much harder problem.

## The Convergence Pattern

Both worlds are moving toward the same solution: let the LLM rewrite everything, then compute the diff algorithmically.

Cursor's apply model works this way. You select a region. The model outputs new text. The editor diffs the old and new versions, then applies minimal changes. Since code is flat text, the diff algorithm is straightforward.

Liveblocks does something similar for rich text. Their text editor API has a feature where the LLM outputs markdown or plain text, the system converts it to the internal tree format, then computes a tree diff against the current document. The diff gets transformed into ProseMirror transactions.

The extra step is flattening the tree first. You can't diff trees as easily as strings. You need to serialize both versions to a comparable format, compute the diff there, then translate back to tree operations.

## The Markdown Escape Hatch

"Just convert to markdown" is the rich text equivalent of "just treat code as text."

It works until it doesn't. If your schema maps cleanly to markdown (headings, paragraphs, lists, bold, italic), you can round-trip through markdown without data loss. The LLM edits markdown, you parse it back, done.

But the moment you have custom nodes (callouts, embeds, columns, mentions), markdown can't represent them. You need a custom serialization format. Now you're teaching the LLM a new format for every editor schema.

Some editors use MDX or extend markdown syntax. That helps, but you still need the LLM to understand your extensions. The more complex your schema, the more you're asking the model to learn domain-specific constraints.

Simple schemas survive this approach. Complex ones lose data or break on round-trip.

## What Code Editors Can Learn

Code editors are getting more structured. Jupyter notebooks mix code and prose. Block-based editors like Notion represent code as first-class blocks. Even VS Code has notebook support now.

As code editors move toward richer structure, they'll hit the same tree-diff problems. A notebook isn't a flat file anymore. It's a tree of cells with different types. Editing cell 3 means navigating a structure, not jumping to a line number.

The rich text world is solving these problems first. Tree diffing, schema-aware edits, collaborative cursor positions in nested structures. Code editors will need the same tools as they add more structure.

The irony is that code always had tree structure. We just ignored it for editing. As editors get smarter, we can't ignore it anymore.

## The Golden Rule

**Text is forgiving; trees are strict.** LLMs are good at text generation. Making them respect tree constraints requires either perfect output or algorithmic repair. Pick algorithmic repair.
