# Every AI Editor Flattens the Tree

Every production AI editor -- Cursor, Tiptap AI, Copilot, Notion AI -- follows the same pattern: serialize to text or markdown for AI interaction, parse back, apply with review. No one works at the tree level for AI generation. Cursor specifically uses a two-model architecture (generator + applier) on text, not trees.

This isn't a hack. It's a correct architectural decision that reveals something fundamental about what LLMs are and aren't.

## The Pattern

Every editor maintains a tree internally. ProseMirror has nodes. Notion has blocks. Code editors have ASTs. Yjs has document trees. The tree _is_ the document.

But the moment AI enters the picture, everyone does the same thing:

```
Tree Structure
      |
      | serialize (to text/markdown)
      v
 Text Representation  →  LLM  →  Text Output
      ^                                |
      |                                | parse + apply (deterministic)
      |                                v
Tree Structure (updated)
```

Flatten the tree. Hand the LLM text. Get text back. Use deterministic code to reconstruct the tree. Every single production system does this. Not because they haven't thought of alternatives -- because they tried the alternatives and they were worse.

## Notion Tried the Tree Approach. It Failed.

Notion's story is the most instructive because they actually tried the intuitive thing first.

Everything in Notion is a block. Blocks have types, properties, relationships, nesting. The obvious engineering choice: serialize blocks as JSON or XML for the AI. Give the model the real structure.

It performed badly.

Ryan Nystrom, Notion's AI engineering lead, described the pivot to markdown as "a step function improvement." Their principle became: if you can't explain the instruction to a person with no context and have them understand it, the model is going to do a bad job.

They eventually built "Notion-flavored Markdown" -- a custom superset of CommonMark with extensions for callouts, colors, and column layouts. This was an explicit reversal of their 2022 decision to use JSON. Three years of building a block-based editor, and the AI interface ended up being markdown.

## Cursor's Two-Model Architecture

Cursor doesn't even try to work with code structure. They separated the problem into two models:

**The generator** (Claude, GPT-4o, or their own model) produces "semantic diffs" -- partial code with comments like `// ... existing code ...` where unchanged lines should remain. This is text output. The model is acting as a writer, not a programmer.

**The applier** (a fine-tuned Llama-3-70b) takes the semantic diff and the original file and stitches them together. This model doesn't reason about _what_ to change -- it only knows _how to merge text_.

Neither model touches the AST. The intelligence is in text-space. The structure is handled by deterministic tooling -- linters, formatters, tree-sitter validation.

They even built "speculative edits" -- a technique that feeds chunks of the original file back to the model as speculation, achieving a 13x speedup because most of the output is identical to the input. The model only generates new tokens at points of disagreement. This only works because the representation is text.

## Copilot, Tiptap, Everyone Else

**Copilot** sends and receives plain text. Tree-sitter is used on the IDE side for validation and ranking -- _after_ generation. The model itself has no knowledge of the AST.

**Tiptap** serializes ProseMirror nodes to HTML or markdown, sends that to the LLM, then parses the response back into ProseMirror fragments using a `defaultTransform` function. Their newer AI Toolkit gives LLMs tool definitions for structured operations (`tiptapRead`, `tiptapEdit`), but the document content is still serialized as HTML for the LLM to read.

**BlockNote** is one of the few that attempts structured block operations -- giving the LLM `add`, `update`, and `delete` tools. But even there, the document is serialized as HTML or markdown for the LLM to read. The operations are coarse block-level actions, not fine-grained tree manipulations.

The pattern is universal. Nobody works at the tree level.

## Why Trees Don't Work for LLMs

### Token Efficiency

ASTs are absurdly verbose. A 50-line function might produce hundreds of AST nodes, each with type, location metadata, and child references. JSON serialization uses roughly 2x the tokens of equivalent plain text. Full AST JSON would be worse.

You're burning context window on structure that the model can't meaningfully use. Markdown is compact. Code-as-text is compact. AST-as-JSON is not.

### Training Data Distribution

LLMs have seen billions of lines of code as text. Documentation as markdown. Prose as paragraphs. They've seen vanishingly few examples of serialized ASTs. The model is simply better at producing what it's practiced on.

This is the same reason Notion's markdown pivot worked so well -- markdown is _native_ to LLMs in a way that JSON block structures aren't.

### Autoregressive Generation Is Linear, Trees Are Not

LLMs generate tokens left-to-right, one at a time. Trees are hierarchical with branching. To serialize a tree, you need some linearization strategy, and the model must maintain a mental stack of open nodes as it generates.

This is fragile. A single early mistake -- the wrong node type, a missing closing bracket -- cascades through the entire subtree. Long-range structural dependencies across hundreds of tokens are exactly where autoregressive models are weakest.

Research shows that constraining LLM output format measurably degrades reasoning performance. The stricter the structural constraints, the worse the thinking.

### The Separation of Concerns Is Just Better

The LLM is a text generator. That's what it's good at. Deterministic code handles structural parsing, tree construction, and validation. That's what _it's_ good at.

This is a clean architectural boundary:
- **AI side**: Generate text that communicates intent
- **Tooling side**: Parse, validate, apply, lint

As Morph's engineering team puts it: "The hard part isn't generating code -- it's applying it without breaking the file."

## What This Means for Collaborative Editors

I've been building a Yjs-based editor, and this pattern has direct implications.

Yjs document trees have strict integration requirements. Every shared type -- Y.Map, Y.Array, Y.Text -- must be properly integrated into the document tree to function. Orphaned Y types silently fail. Mutations don't persist. Observers don't fire. The tree structure isn't a nice-to-have; it's load-bearing.

If you wanted an LLM to directly manipulate a Yjs document, it would need to understand:
- Parent-child integration (orphaned types silently break)
- CRDT operation ordering and conflict resolution
- Observer propagation through the tree
- The difference between Y.Map containers and plain objects

That's asking a text predictor to understand a distributed data structure. It's the wrong tool for the job.

The correct approach is the same one everyone else discovered: serialize the Yjs document to markdown or text, let the AI work in that space, parse the result back, and apply changes through the proper Yjs API. Let the CRDT handle consistency. Let the AI handle language.

## The Markdown Convergence

It's worth pausing on the fact that every system converged on markdown independently.

- Notion moved from JSON/XML to markdown
- Tiptap has dedicated markdown serialization as the AI bridge
- BlockNote uses `blocksToMarkdownLossy()` for AI interactions
- Cursor uses text-based semantic diffs
- Copilot sends and receives plain text
- Aider offers multiple text-based edit formats (diff, whole-file, search-replace)

Markdown is the lingua franca between structured editors and language models because it sits at exactly the right point on the spectrum: structured enough to preserve meaning, flat enough for LLMs to work with, and so heavily represented in training data that models are fluent in it.

## The Takeaway

The universal serialize-to-text pattern isn't a limitation waiting to be fixed. It's the correct architectural response to what LLMs actually are: text transformers, not tree transformers.

The sophistication in production AI editors isn't in the format -- it's in the apply step. Fuzzy matching. Speculative decoding. Linting feedback loops. Chunked document processing. Two-model pipelines. That's where the engineering challenge lives.

The tree stays on the editor side. The text stays on the AI side. And the bridge between them is markdown.

Everyone figured this out independently. That's how you know it's right.
