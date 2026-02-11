# Your Serialization Format Is Your AI's Ceiling

**TL;DR**: The format you choose to serialize rich text for LLM editing determines what fidelity you can actually preserve.

> "You can have a perfect schema and a brilliant LLM, but if you pick markdown for a complex document, you're going to lose data."

I was building AI editing for a ProseMirror document. The schema had custom nodes: callouts, embedded components, metadata attributes on paragraphs. I reached for markdown because that's what LLMs are good at. It worked great for the first prototype. Then I tried editing a document with a table and some custom attributes. The LLM responded. I called `setContent()`. Half the document was gone.

The problem wasn't the LLM. It was me asking it to speak a language that couldn't express what the document actually contained.

## The Four Options

When you connect an LLM to a rich text editor, you have four serialization choices. Each one caps what you can preserve.

### Markdown: Simple but Lossy

This is the obvious choice. Get markdown from the editor, send it to the LLM, parse the response back.

```typescript
const markdown = editor.getMarkdown();
const response = await llm.generate(markdown);
editor.commands.setContent(response, { contentType: "markdown" });
```

LLMs love markdown. They're trained on it. They produce clean, valid markdown reliably. The syntax is compact, so you're not burning tokens on angle brackets.

But markdown has a fixed vocabulary. It knows about headers, bold, italic, links, lists, code blocks. Your schema probably has more. Custom nodes? Gone. Attributes like `data-user-id` or `alignment`? Stripped. Complex tables? Mangled into something simpler.

If your schema is basic, this works. If you've extended ProseMirror with custom nodes, you're going to lose data on every round trip.

### HTML: Verbose but Mappable

TipTap Content AI uses HTML. Their docs say "Make sure the stream returns HTML to render directly as rich text." There's a reason they picked this.

HTML maps better to ProseMirror's node structure than markdown does. Most ProseMirror schemas are designed to convert cleanly to HTML because that's the web's native format. If your custom nodes render as specific HTML tags, you can often round-trip without loss.

The cost is tokens. HTML is verbose. Every `<p>` needs a `</p>`. Attributes add more characters. You're paying for angle brackets and closing tags on every API call.

And LLMs occasionally produce invalid HTML. Missing closing tags, malformed attributes, tags that don't nest properly. ProseMirror's HTML parser is forgiving, but it's not magic. You'll get documents that look almost right but have subtle structural problems.

HTML works well for streaming because you can parse and render fragments as they arrive. That's why TipTap picked it for their AI feature.

### Constrained JSX: High Fidelity, High Maintenance

This is what Liveblocks does. You define a restricted set of tags that mirror your schema exactly.

```jsx
<Doc>
  <Paragraph>
    This is <Bold>important</Bold>.
  </Paragraph>
  <Callout type="warning">
    Custom nodes work fine.
  </Callout>
</Doc>
```

Your schema has a callout node? You teach the LLM about `<Callout>`. It has a `type` attribute? That's part of the contract. The LLM learns to output exactly the tags your schema understands.

This is the most faithful approach. You're not constrained by markdown's limited syntax. You're not paying for HTML's verbosity. You're defining exactly the language your document speaks.

The tradeoff is engineering effort. You have to design the contract, document it for the LLM, and handle parsing errors when the LLM inevitably produces malformed output. Every time your schema changes, you update the contract and hope the LLM adapts.

But if you need to preserve complex structures and you're doing diffing or precise edits, this is your best option.

### Raw JSON: Lossless but Unusable

ProseMirror has `editor.getJSON()`. It gives you the exact node tree. Zero loss. Perfect fidelity.

LLMs cannot reliably produce valid nested JSON trees. They lose track of nesting levels. They forget closing braces. They produce something that's almost valid but breaks on parse. I've tried this. It doesn't work.

JSON is great for feeding context to an LLM. "Here's the document structure" as part of the prompt. But don't ask the LLM to generate JSON as output. You'll spend all your time debugging parse errors.

## The Comparison

| Format          | Fidelity  | LLM Comfort | Token Cost | Round-trip Safety        | Best For                   |
| --------------- | --------- | ----------- | ---------- | ------------------------ | -------------------------- |
| Markdown        | Low       | High        | Low        | Lossy                    | Simple schemas             |
| HTML            | Medium    | Medium      | High       | Mostly safe              | Streaming                  |
| Constrained JSX | High      | Medium      | Medium     | Safe if contract correct | Complex schemas with edits |
| Raw JSON        | Lossless  | Low         | Very High  | LLMs can't produce       | Read-only context only     |

## When to Use What

Start with markdown if your schema is close to standard markdown. Headers, paragraphs, bold, italic, links, lists. If that's all you need, don't overcomplicate it.

Switch to HTML if you're streaming or if your schema uses attributes that map cleanly to HTML. The token cost hurts, but the reliability and streaming support are worth it.

Use constrained JSX when you have custom nodes and you need faithful round trips. Be ready to invest in the contract and the parsing logic. This is the format for complex document schemas where loss is unacceptable.

Never ask an LLM to produce raw JSON for a document tree. Use JSON to feed context, not to receive output.

## The Ceiling Principle

Your serialization format sets an upper bound on fidelity. You can't preserve what you can't express. If markdown can't represent your callout node, that node is going to disappear no matter how good your LLM is.

Pick the format that can express your schema. Everything else is downstream from that choice.

The LLM's job is to produce valid output in the format you chose. Your job is to choose a format that can actually represent your documents. Get that wrong and you're building a lossy compression system that looks like an editor.

> **The Golden Rule**: Match your serialization format's expressiveness to your schema's complexity, or accept that you're going to lose data.
