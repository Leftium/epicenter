# You Don't Need an Accordion Inside a Virtual List

I tried to put a shadcn Accordion component inside a virtua `VList` in Svelte. Virtual lists expect flat, predictable-height items. Accordions give you nested DOM with variable-height content that expands and collapses. The virtual list needs to measure and position every item; the accordion wants to animate its own height transitions independently. The two models don't compose.

At first I was bummed-it seemed like I had to choose between collapsible groups and virtualization. Then it clicked: I don't need an accordion component. I can accomplish the same thing with headers with arrows that conditionally render their children in the virtual list. A reactive Set, a derived flat list, done.

## The Pattern

An accordion does two things: tracks which groups are open, and shows or hides children accordingly. You don't need a component for that. A reactive Set and a derived flat list do the same job, and they work perfectly inside a virtual list.

```svelte
<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import { VList } from 'virtua/svelte';

  const expandedGroups = new SvelteSet<string>(['focused-group']);

  const flatItems = $derived(
    groups.flatMap((group) => {
      const header = { kind: 'header' as const, group };
      if (!expandedGroups.has(group.id)) return [header];
      return [
        header,
        ...group.children.map((child) => ({ kind: 'item' as const, child })),
      ];
    }),
  );

  function toggle(id: string) {
    if (expandedGroups.has(id)) expandedGroups.delete(id);
    else expandedGroups.add(id);
  }
</script>

<VList data={flatItems} style="height: 100%;">
  {#snippet children(item)}
    {#if item.kind === 'header'}
      <button onclick={() => toggle(item.group.id)}>
        {item.group.name}
      </button>
    {:else}
      <div>{item.child.title}</div>
    {/if}
  {/snippet}
</VList>
```

When you click a header, the Set changes, `$derived` recomputes, and the flat list grows or shrinks. The virtual list sees a new array with more or fewer items. It renders the visible ones. That's it.

```
expandedGroups (Set)        flatItems ($derived)          VList
      |                           |                         |
      |  .add() / .delete()      |  recomputes when        |
      |------------------------->|  Set changes             |
      |                           |                         |
      |                           |  [header, item, item,   |  renders only
      |                           |   header,               |  visible items
      |                           |   header, item, item]   |------------->
```

## Why Real Accordions Don't Work Here

| Approach | Works in virtual list? | Why |
|----------|----------------------|-----|
| Accordion component | No | Needs parent context provider; CSS animations assume nested DOM |
| Conditional rendering + Set | Yes | Flat data; virtual list just sees items appear and disappear |

Accordion components like shadcn's (built on bits-ui) manage their own DOM hierarchy. `Accordion.Root` provides context, `Accordion.Item` wraps a trigger and content panel together, and `Accordion.Content` uses `data-[state=open/closed]` for CSS transitions. All of that assumes a stable, nested DOM tree.

Virtual lists destroy that assumption. They mount and unmount items as you scroll. An `Accordion.Item` that scrolls out of view gets removed from the DOM entirely, and its open/closed state disappears with it. Even if you could keep the state, the context provider relationship between Root and Item breaks when they aren't in the same DOM subtree.

## Not Svelte-Specific

The principle generalizes across frameworks. Accordion components couple state to DOM structure. Virtual lists need flat data with externalized state.

In React: `useState(new Set())` with a derived flat array. In Vue: `reactive(new Set())` with a computed property. In Solid: `createSignal(new Set())` with a memo. The framework-specific reactive primitive changes; the pattern stays the same.

Svelte's `SvelteSet` from `svelte/reactivity` happens to be especially clean here because `.has()`, `.add()`, and `.delete()` all participate in the reactivity system. Call `.has()` inside `$derived` and Svelte tracks the dependency automatically. Mutate the Set elsewhere and the derived value recomputes.

## Heights Handle Themselves

Most virtual list libraries (virtua, tanstack-virtual, react-virtuoso) use `ResizeObserver` to measure item heights automatically. When a group expands and new items appear in the flat list, the library measures them, updates its internal layout cache, and adjusts scroll position. When a group collapses, items vanish and the layout shrinks.

No animation library, no DOM nesting, no context provider headaches. The items appear and disappear, and the virtual list handles the rest.
