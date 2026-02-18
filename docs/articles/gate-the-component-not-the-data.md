# Gate the Component, Not the Data

When a service initializes asynchronously and a component needs that data at construction time, the tempting fix is an effect that watches for data arrival. Don't do it. Gate the component instead.

The pattern shows up everywhere: a store fetches data in the background, a component reads the store at mount, and finds nothing there yet. So you write a `$effect` to catch the moment the data appears and seed your local state.

```svelte
<script>
  const items = new SvelteSet();

  let seeded = false;
  $effect(() => {
    const data = store.items;
    if (seeded || data.length === 0) return;
    for (const d of data) items.add(d.id);
    seeded = true;
  });
</script>
```

This works. But it's a workaround masquerading as a solution. Every component that needs data at construction time will need its own version of this effect. The `seeded` flag exists solely because you're fighting a timing problem that doesn't belong in the component.

## The Alternative

Move the timing concern to the parent. If your service exposes a promise that resolves when initialization is done, the parent can hold off rendering children until the data exists.

The service side is one line: capture the async IIFE as a variable instead of firing and forgetting it.

```typescript
// Before: fire-and-forget
(async () => {
  const data = await fetchAll();
  populate(data);
})();

// After: captured promise
const whenReady = (async () => {
  const data = await fetchAll();
  populate(data);
})();

return { whenReady, /* ...other methods */ };
```

The parent awaits it once:

```svelte
{#await service.whenReady}
  <p>Loading…</p>
{:then}
  <ChildComponent />
{/await}
```

The child component never mounts until the promise resolves. By the time its `<script>` block executes, the data is there. No effects, no flags, no timing dance.

```svelte
<script>
  // This is safe now. Data is guaranteed to exist.
  const items = new SvelteSet(
    store.items.filter((d) => d.active).map((d) => d.id),
  );
</script>
```

## Why This Is Better Than Effects

An effect reacts to a change. A render gate prevents the change from being a problem in the first place. The distinction matters when you have multiple components that each need data at construction.

With effects, each component independently handles the timing problem. Three components that need store data at mount means three `$effect` blocks with three `seeded` flags. If you add a fourth, you have to remember to add the effect there too.

With a render gate, you handle it once in the parent. Every child component is born into a world where the data already exists. You can write plain, synchronous initialization code and it just works.

| Approach | Effect seeding | Render gate |
| :--- | :--- | :--- |
| Where timing is handled | Each component, independently | Once, in the parent |
| Component code | Defensive (effects, flags, guards) | Straightforward (sync constructors) |
| Adding new components | Must remember to add effect | No extra work needed |
| Loading UX | Content shifts as effects fire | Clean loading → ready transition |

## When This Doesn't Apply

If the data is truly optional and the component should render even without it, a render gate is too heavy. Use a conditional or an effect. The gate is for the case where there's no point rendering the component until the data exists: a tab list without tabs, a user profile without user data, a dashboard without metrics.

The test is simple: if the component would show an empty state that immediately fills in, you probably want a gate instead.

## In Practice

We hit this exact bug in a browser extension tab manager ([PR #1376](https://github.com/EpicenterHQ/epicenter/pull/1376)). The singleton service [`browserState`](https://github.com/EpicenterHQ/epicenter/blob/9b893eddc/apps/tab-manager/src/lib/state/browser-state.svelte.ts) fetches browser windows asynchronously and stores them in a `SvelteMap`. [`FlatTabList`](https://github.com/EpicenterHQ/epicenter/blob/9b893eddc/apps/tab-manager/src/lib/components/FlatTabList.svelte) needed to know which window was focused at construction to expand it by default. The data loaded asynchronously. The original code used a `SvelteSet` constructor that always received an empty array.

The `$effect` fix worked but pushed timing concerns into the component. The render gate fixed it structurally: one [`{#await}` in `App.svelte`](https://github.com/EpicenterHQ/epicenter/blob/9b893eddc/apps/tab-manager/src/entrypoints/sidepanel/App.svelte#L43-L54), and the component went back to a one-liner.

See [Gate Rendering to Avoid Effect Seeding](/docs/articles/render-gate-saved-us-from-effect-seeding.md) for the full walkthrough with code. This pattern is a specific application of the [sync construction, async property](/docs/articles/sync-construction-async-property-ui-render-gate-pattern.md) pattern: build the object synchronously, track async work as a property, let the UI await it at the boundary.
