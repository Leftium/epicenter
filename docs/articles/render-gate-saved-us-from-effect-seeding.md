# Gate Rendering to Avoid Effect Seeding

[PR #1376](https://github.com/EpicenterHQ/epicenter/pull/1376) · See also: [Gate the Component, Not the Data](/docs/articles/gate-the-component-not-the-data.md) (the general pattern)

The focused window in our tab manager wouldn't stay open. It was supposed to default to an expanded state, but every time the sidepanel opened, all windows stayed collapsed. We had the data, we had the logic, but the timing was wrong.

Some context: the tab manager is a browser extension sidepanel (Svelte 5, WXT). It shows your browser windows as collapsible headers with their tabs nested underneath. `browserState` is a singleton service that calls `browser.windows.getAll({ populate: true })` asynchronously in its constructor, storing results in a `SvelteMap`. The UI reads from this service reactively.

The bug lived in `FlatTabList.svelte`, which uses a virtualized list (`VList` from virtua) with a `SvelteSet` to track expand/collapse state. At construction, it seeds the set with the focused window's ID so that window starts expanded.

```typescript
// FlatTabList.svelte — the component that renders the window/tab list
const expandedWindows = new SvelteSet<WindowCompositeId>(
  browserState.windows.filter((w) => w.focused).map((w) => w.id),
);
```

On paper, this works. In reality, `browserState` fetches windows asynchronously in its constructor. The service is a module-level singleton created at import time, so the async seed fires immediately but the IIFE resolves later. When `FlatTabList` mounts, `browserState.windows` is still an empty array. The filter finds nothing, the set starts empty, and the user sees every window collapsed.

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

We moved the async tracking into the `browserState` service itself. The original code used a fire-and-forget IIFE to seed state. The promise resolved, the `SvelteMap` got populated, but nobody outside could know when that happened.

```typescript
// browser-state.svelte.ts — BEFORE (fire-and-forget)
function createBrowserState() {
  const windowStates = new SvelteMap<WindowCompositeId, WindowState>();
  let deviceId: string | null = null;

  (async () => {
    const [browserWindows, id] = await Promise.all([
      browser.windows.getAll({ populate: true }),
      getDeviceId(),
    ]);
    // ... populate windowStates ...
    deviceId = id;
  })();

  return {
    get windows() { return [...windowStates.values()].map((s) => s.window) },
    // ... no way to know when data is ready
  };
}
```

The fix was one word: `const`. Capture the IIFE's promise and expose it.

```typescript
// browser-state.svelte.ts — AFTER (captured promise)
const whenReady = (async () => {
  const [browserWindows, id] = await Promise.all([
    browser.windows.getAll({ populate: true }),
    getDeviceId(),
  ]);
  // ... populate windowStates ...
  deviceId = id;
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

If a component needs data to initialize its internal state, don't write an effect to wait for it. Gate the component. See [Gate the Component, Not the Data](/docs/articles/gate-the-component-not-the-data.md) for the general pattern, and the [sync construction, async property](/docs/articles/sync-construction-async-property-ui-render-gate-pattern.md) article for the underlying approach.
