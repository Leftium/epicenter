# Gate Rendering to Avoid Effect Seeding

The focused window in our tab manager wouldn't stay open. It was supposed to default to an expanded state, but every time the sidepanel opened, the accordion stayed shut. We had the data, we had the logic, but the timing was wrong.

The bug lived in `FlatTabList.svelte`. We were initializing a `SvelteSet` to track which windows were expanded.

```typescript
// FlatTabList.svelte
const expandedWindows = new SvelteSet<WindowCompositeId>(
  browserState.windows.filter((w) => w.focused).map((w) => w.id),
);
```

On paper, this works. In reality, `browserState` fetches windows asynchronously in its constructor. When `FlatTabList` mounts, `browserState.windows` is still an empty array. The filter finds nothing, the set stays empty, and the user sees a collapsed list.

Our first instinct was to fix it with an effect. We added a flag to track if we had seeded the initial state and waited for the data to arrive.

```svelte
const expandedWindows = new SvelteSet<WindowCompositeId>();

let hasSeeded = false;
$effect(() => {
  const focused = browserState.windows.filter((w) => w.focused);
  if (hasSeeded || focused.length === 0) return;
  for (const w of focused) expandedWindows.add(w.id);
  hasSeeded = true;
});
```

It worked, but it felt defensive. We were forcing a component to manage the lifecycle of global state. If we added a second component that needed the same data at mount, we would have to copy-paste this effect or move the seeding logic into the service.

The real problem was structural. We were mounting the UI before the application was actually ready to be seen.

We moved the async tracking into the `browserState` service itself. Instead of a fire-and-forget IIFE in the constructor, we captured the initialization as a promise.

```typescript
// browser-state.svelte.ts
const whenReady = (async () => {
  const [browserWindows, id] = await Promise.all([
    browser.windows.getAll({ populate: true }),
    getDeviceId(),
  ]);
  // ... populate state ...
})();

return {
  whenReady,
  get windows() { return [...windowStates.values()].map((s) => s.window) },
  // ...
};
```

This allowed us to implement a render gate at the root of the application. By using Svelte's `{#await}` block in `App.svelte`, we ensured that no child components would mount until the data was guaranteed to be there.

```svelte
<!-- App.svelte -->
{#await browserState.whenReady}
  <div class="flex-1 flex items-center justify-center">
    <p class="text-sm text-muted-foreground">Loading tabs…</p>
  </div>
{:then}
  <Tabs.Content value="windows" class="flex-1 min-h-0 mt-0">
    <FlatTabList />
  </Tabs.Content>
{/await}
```

With the gate in place, the complexity in `FlatTabList` vanished. We could revert to the simple, synchronous constructor. We no longer needed to check if the data had seeded because the component only exists in a world where the data is already loaded.

```typescript
// FlatTabList.svelte (Simplified)
const expandedWindows = new SvelteSet<WindowCompositeId>(
  browserState.windows.filter((w) => w.focused).map((w) => w.id),
);
```

This follows the sync construction with async property pattern. The service is created synchronously so it can be exported and used anywhere, but it exposes a promise that the UI respects.

| Aspect | $effect seeding | Render gate |
| :--- | :--- | :--- |
| Responsibility | Component handles service timing | App handles its own readiness |
| Complexity | Flags and effects per consumer | Standard synchronous code |
| Scalability | Every consumer needs a workaround | One fix covers all children |
| UX | UI pops in and shifts | Clean loading state to ready state |

```
App.svelte           browserState           FlatTabList
    │                     │                      │
    │  await whenReady    │                      │
    │────────────────────>│                      │
    │                     │                      │
    │  promise resolves   │                      │
    │<────────────────────│                      │
    │                     │                      │
    │  mount component    │                      │
    │─────────────────────┼─────────────────────>│
    │                     │                      │
    │                     │   read windows()     │
    │                     │<─────────────────────│
    │                     │   (data is ready)    │
    │                     │─────────────────────>│
```

The render gate turned a timing bug into a non-issue. By lifting the async boundary to the root, we allowed our components to remain simple, synchronous, and predictable.

If a component needs data to initialize its internal state, don't write an effect to wait for it. Gate the component.
