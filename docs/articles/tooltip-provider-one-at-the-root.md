# Tooltip.Provider Goes at the Root, Not Around Every Tooltip

bits-ui's `Tooltip.Provider` does two things: it sets default props (`delayDuration`, `skipDelayDuration`) for all descendant tooltips, and it enforces that only one tooltip within its scope can be open at a time. That second behavior is the one most people miss.

When you wrap a component in its own `Tooltip.Provider`, you're creating an isolated tooltip group. Tooltips inside that provider don't know about tooltips outside it. Two tooltips from different providers can be open simultaneously, which is almost never what you want.

```
App Root
├── Tooltip.Provider (root)          ← one-at-a-time scope
│   ├── Button tooltip="Save"
│   ├── Button tooltip="Delete"
│   └── PmCommand
│       └── Tooltip.Provider (nested) ← separate one-at-a-time scope
│           └── Tooltip.Root           ← can be open ALONGSIDE "Save" or "Delete"
```

The fix: remove the nested provider and use `Tooltip.Root`'s own `delayDuration` prop to override the ancestor's default.

```
App Root
├── Tooltip.Provider (root)          ← single one-at-a-time scope
│   ├── Button tooltip="Save"
│   ├── Button tooltip="Delete"
│   └── PmCommand
│       └── Tooltip.Root delayDuration={0}  ← overrides default, stays in root scope
```

## How the Override Works

bits-ui's `TooltipRootState` resolves `delayDuration` with nullish coalescing:

```js
delayDuration = $derived.by(
  () => this.opts.delayDuration.current ?? this.provider.opts.delayDuration.current
);
```

If `Tooltip.Root` has a `delayDuration` prop, it wins. Otherwise it falls back to the closest ancestor `Tooltip.Provider`. The same pattern applies to `disableHoverableContent`, `disableCloseOnTriggerClick`, `disabled`, and `ignoreNonKeyboardFocus`.

This means you only need a nested `Tooltip.Provider` when you genuinely want an independent tooltip group with its own "one at a time" behavior. The sidebar is a legitimate case: collapsed sidebar icon tooltips should open instantly and independently of the app's other tooltips. A copy button inside a code block is not.

## What We Changed

Our `Tooltip.Provider` wrapper in `packages/ui` was a pure pass-through with no defaults, inheriting bits-ui's 700ms delay. Every app had to configure its own values, and some forgot (tab-manager was using the sluggish 700ms default).

We added opinionated defaults to the UI package's `tooltip-provider.svelte`:

```svelte
let {
  delayDuration = 300,
  skipDelayDuration = 150,
  ...restProps
}: TooltipPrimitive.ProviderProps = $props();
```

| Before | After |
|--------|-------|
| Each app sets `delayDuration={300} skipDelayDuration={150}` | UI package provides the defaults |
| pm-command wraps one tooltip in its own `Tooltip.Provider` | pm-command uses `Tooltip.Root delayDuration={0}` |
| tab-manager gets bits-ui's 700ms default | tab-manager gets 300ms for free |
| Sidebar provider sets `delayDuration={0}` | Unchanged; intentional independent group |

Apps that need different timing still override via props on `Tooltip.Provider`. Components that need a different delay for one specific tooltip set it on `Tooltip.Root` directly.

## When to Use a Nested Provider

Nest a `Tooltip.Provider` only when you need a genuinely separate tooltip group. The sidebar is the canonical example: when the sidebar collapses to icon-only mode, those tooltips should appear instantly and independently. That's a different UX context from the rest of the app, so a separate provider makes sense.

For everything else, set `delayDuration` on the individual `Tooltip.Root`.

## References

- [bits-ui Tooltip docs](https://bits-ui.com/docs/components/tooltip): "It also ensures that only a single tooltip within the same provider can be open at a time."
- [shadcn-svelte Tooltip docs](https://www.shadcn-svelte.com/docs/components/tooltip): "Tooltips use the closest ancestor provider."
- bits-ui source (`tooltip.svelte.js` line 66): nullish coalescing for `delayDuration` resolution.
