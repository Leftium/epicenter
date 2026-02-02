# Flat Y.Map with Dot-Notation Keys

At Epicenter, we store settings in a flat Y.Map with keys namespaced by periods: `editor.fontSize`, `recording.quality`, `shortcuts.global.toggle`. This pattern is inspired by VS Code's settings.json.

The insight: you get logical grouping without the complexity of nested Y.Maps. And you avoid an entire class of CRDT bugs.

## The Pattern

Instead of:

```typescript
const settings = doc.getMap('settings');
const editor = new Y.Map();
editor.set('fontSize', 14);
editor.set('tabSize', 2);
settings.set('editor', editor);
```

Use:

```typescript
const kv = doc.getMap('kv');
kv.set('editor.fontSize', 14);
kv.set('editor.tabSize', 2);
kv.set('recording.quality', 'high');
```

One flat map. Keys are just strings with dots in them. No nesting.

## Why Flat Beats Nested

With nested Y.Maps, updating a subtree is dangerous. If you call `settings.set('editor', newEditorMap)`, you replace the entire editor map. Any concurrent edits to keys inside that map are lost. (See [nested Y.Map replacement danger](./nested-ymap-replacement-danger.md) for details.)

With flat keys, each setting is independent. `editor.fontSize` and `editor.tabSize` are separate keys in the same map. You can never accidentally blow away a sibling key by updating another.

The dot is just a convention. Yjs doesn't care; it's a valid string. But it gives you logical namespacing without structural overhead.

## VS Code Does This

VS Code's settings.json is flat:

```json
{
  "editor.fontSize": 14,
  "editor.tabSize": 2,
  "workbench.colorTheme": "One Dark Pro"
}
```

Not nested objects. Just prefixed keys. It's been battle-tested at massive scale.

## Querying by Prefix

Need all editor settings? Iterate and filter:

```typescript
const editorSettings = [...kv.entries()]
  .filter(([key]) => key.startsWith('editor.'))
  .map(([key, value]) => [key.replace('editor.', ''), value]);
```

Not as elegant as `settings.get('editor')`, but you avoid an entire class of CRDT bugs. That's a worthwhile trade.

## When to Use Nested Maps

Nested Y.Maps make sense when each subtree is truly independent and you'll never replace the parent reference. Collections of entities (users, documents) where you add/remove items but never replace the container.

For key-value settings? Keep it flat.
