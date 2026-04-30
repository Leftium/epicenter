# Whole-Workspace Action Discovery

## Summary

Daemon action paths match the object path developers return from their workspace factory.

```ts
return {
	actions: {
		notes: {
			add: defineMutation({ ... }),
		},
	},
};
```

```sh
epicenter run notes.actions.notes.add
```

`actions` is a convention, not a reserved daemon root. If a workspace returns a top-level action group, the CLI path follows that shape.

```ts
return {
	notes: {
		add: defineMutation({ ... }),
	},
};
```

```sh
epicenter run notes.notes.add
```

## Rule

The daemon exposes every `defineQuery` or `defineMutation` leaf reachable through plain object properties on the returned workspace object.

The first CLI path segment selects the config export. The remaining path is resolved literally inside that export.

```text
<configExport>.<literal path through returned plain objects>
```

## Safety Boundary

Discovery only recurses into plain object literals. It does not recurse into class instances, arrays, or ordinary functions. This keeps infrastructure such as `Y.Doc`, table attachments, sync attachments, presence, and RPC objects out of the public action surface unless an app deliberately returns action leaves through plain objects.

Returning an action leaf through a plain object is a public API decision. Private actions should stay in local variables, class instances, or non-returned helpers.

## RPC Alignment

Peer RPC uses the same inner path the CLI sees after removing the config export prefix.

```sh
epicenter run notes.actions.notes.add --peer notes-repro-peer-a
```

sends:

```text
actions.notes.add
```

Apps should pass the same public shape to RPC that they want peers to see:

```ts
const rpc = sync.attachRpc({ actions: { actions } });
```

or, for a top-level action group:

```ts
const rpc = sync.attachRpc({ actions: { notes } });
```

## Non-Goals

- No hidden `workspace.actions` root.
- No short-path aliasing.
- No `attachActions` primitive.
- No registry marker on `defineActions`.
- No whole-source scan. Only the runtime object exported from `epicenter.config.ts` is inspected.
