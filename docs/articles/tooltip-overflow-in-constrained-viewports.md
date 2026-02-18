# Tooltip Overflow in Constrained Viewports: Two Props That Work Together

We added a tooltip to the tab manager extension that shows the full URL when you hover a tab's domain. Most URLs fit fine. Then we hovered a GitHub diff link:

```
https://github.com/EpicenterHQ/epicenter/pull/1155/changes#diff-ba2c48ee61d8c9f062cc1dbcb7c36f916294aae8ddef183c96200ed8cd6cdddc
```

120+ characters, no natural break points. It blew right past the edge of the popup.

## Problem

The [shadcn-svelte](https://next.shadcn-svelte.com/) `Tooltip.Content` component renders fine on a normal page. But in a browser extension sidepanel, the viewport is narrow and user-controlled. A long tooltip has nowhere to go, and the default positioning can push it flush against the viewport edge.

Here's what the component looked like before the fix:

```svelte
<Tooltip.Content side="bottom">
  {tab.url}
</Tooltip.Content>
```

Two issues: the tooltip element itself can be wider than the viewport, and even when it fits, it can be positioned right up against the edge with no breathing room.

## Solution

The fix is twofold:

```svelte
<Tooltip.Content
  side="bottom"
  collisionPadding={8}
  class="max-w-[calc(100vw-2rem)] break-all"
>
  {tab.url}
</Tooltip.Content>
```

**`max-w-[calc(100vw-2rem)]`** constrains how wide the tooltip element can be. `100vw` in an extension popup is the popup itself; subtracting `2rem` reserves 1rem of space on each side. The tooltip's max width tracks the viewport whether it's 300px or 500px wide. A fixed value like `max-w-sm` (384px) breaks the moment the sidepanel is narrower than that.

`break-all` is necessary alongside it because URLs are a single unbroken string. `break-words` only breaks at word boundaries, and a URL has none. Without `break-all`, the browser treats the entire URL as one "word" and lets it overflow.

**`collisionPadding={8}`** constrains where the tooltip is placed. [bits-ui](https://bits-ui.com/docs/components/tooltip) exposes this prop on all its floating content components: [Tooltip.Content](https://bits-ui.com/docs/components/tooltip), [Popover.Content](https://bits-ui.com/docs/components/popover), [Select.Content](https://bits-ui.com/docs/components/select), and others. Under the hood, bits-ui passes it to [Floating UI](https://floating-ui.com/)'s [`shift()` middleware](https://floating-ui.com/docs/shift#padding) as the `padding` option in [`detectOverflow`](https://floating-ui.com/docs/detectoverflow#padding). This adds virtual padding around the viewport edges when calculating position: with `collisionPadding={8}`, Floating UI's shift middleware repositions the tooltip to stay at least 8px from any viewport edge.

| What | Controls | Layer |
|------|----------|-------|
| `max-w-[calc(100vw-2rem)]` | How wide the tooltip can be | CSS |
| `break-all` | Whether long strings wrap | CSS |
| `collisionPadding={8}` | How close it can get to viewport edges | [Floating UI](https://floating-ui.com/docs/shift) positioning |

These solve different problems and you need both. A tooltip can be narrow enough to fit but still positioned flush against the left wall. And a tooltip can be perfectly centered but too wide for the viewport.

```
Without collisionPadding:        With collisionPadding={8}:

|tooltip text here    |          |  tooltip text here  |
|                     |          |                     |
├─────────────────────┤          ├─────────────────────┤
 ^ flush against edge             ^ 8px gap
```

This applies to any bits-ui floating content in a constrained viewport, not just tooltips.
