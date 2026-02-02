# WXT Tab Manager Extension with Epicenter Integration

## Overview

Create a browser extension using the WXT framework with Svelte 5, integrating with the existing Epicenter client pattern. The extension will display browser tabs in a popup and expose tab operations through a query layer.

## Goals

1. Scaffold a WXT + Svelte 5 browser extension in `apps/tab-manager`
2. Create an Epicenter config with a cloned browser workspace
3. Build a query layer (similar to `apps/whispering/src/lib/query`) using `wellcrafted/query`
4. Create a popup UI that displays all tabs using the query layer

## Architecture Decision: Popup-First

The Epicenter client lives in the **popup** as the source of truth:

- Popup can access `browser.tabs` API directly (it's an extension page, not content script)
- Service workers in MV3 are unreliable (can be terminated anytime)
- Yjs + IndexedDB handles persistence; each popup open loads from IndexedDB instantly
- Simpler architecture with no message passing overhead

```
apps/tab-manager/
├── entrypoints/
│   ├── popup/
│   │   ├── index.html
│   │   ├── main.ts
│   │   └── App.svelte
│   └── background.ts             # Minimal: just event listeners for sync
├── src/
│   ├── lib/
│   │   ├── epicenter.config.ts   # defineEpicenter + browser workspace
│   │   └── query/
│   │       ├── _client.ts        # QueryClient + defineQuery/defineMutation factories
│   │       ├── index.ts          # Export rpc namespace
│   │       └── tabs.ts           # Tab queries/mutations wrapping workspace
│   └── workspaces/
│       └── browser.workspace.ts  # Cloned from examples, adapted for extension
├── wxt.config.ts
├── package.json
└── tsconfig.json
```

## Implementation Plan

### Phase 1: WXT Project Scaffolding

- [ ] Create `apps/browser-extension` directory
- [ ] Initialize WXT with Svelte 5 template configuration
- [ ] Configure `wxt.config.ts` with proper module setup
- [ ] Set up `package.json` with dependencies:
  - `wxt` (core framework)
  - `@wxt-dev/module-svelte` (Svelte integration)
  - `svelte` (from catalog)
  - `@tanstack/svelte-query` (query layer)
  - `wellcrafted` (from catalog)
  - `arktype` (from catalog)
  - Workspace packages: `@epicenter/hq`, `@epicenter/ui`

### Phase 2: Epicenter Client Setup

- [ ] Create `src/lib/epicenter.ts`:
  - Import `browser` workspace from examples
  - Define Epicenter config with the browser workspace
  - Export typed client initialization

### Phase 3: Query Layer

- [ ] Create `src/lib/query/_client.ts`:
  - Set up `QueryClient` with browser-aware defaults
  - Export `defineQuery` and `defineMutation` from wellcrafted

- [ ] Create `src/lib/query/tabs.ts`:
  - Define `tabsKeys` for query key management
  - Wrap workspace methods:
    - `getAllTabs` query
    - `getAllWindows` query
    - `syncFromBrowser` mutation
    - Tab actions: `closeTab`, `createTab`, `pinTab`, etc.

- [ ] Create `src/lib/query/index.ts`:
  - Export unified `rpc` namespace

### Phase 4: Extension Entrypoints

- [ ] Create `entrypoints/background.ts`:
  - Initialize Epicenter client
  - Set up browser event listeners to sync state
  - Export client for popup access (via messaging or shared state)

- [ ] Create `entrypoints/popup/`:
  - `index.html` with proper WXT meta tags
  - `main.ts` bootstrapping Svelte + QueryClientProvider
  - `App.svelte` with tab list UI

### Phase 5: Popup UI

- [ ] Create tab list component using existing UI components:
  - Import from `@epicenter/ui`
  - Display tabs with favicon, title, URL
  - Add action buttons (close, pin, mute)
  - Group by window

## Key Patterns to Follow

### Epicenter Client Pattern

```typescript
// src/lib/epicenter.ts
import { defineEpicenter, createEpicenterClient } from '@epicenter/hq';
import { browser } from '../../examples/content-hub/browser/browser.workspace';

export const epicenter = defineEpicenter({
  id: 'browser-extension',
  workspaces: [browser],
});

// Initialize once in background script
export const getClient = () => createEpicenterClient(epicenter);
```

### Query Layer Pattern

```typescript
// src/lib/query/_client.ts
import { QueryClient } from '@tanstack/svelte-query';
import { createQueryFactories } from 'wellcrafted/query';

export const queryClient = new QueryClient();
export const { defineQuery, defineMutation } = createQueryFactories(queryClient);
```

```typescript
// src/lib/query/tabs.ts
import { defineQuery, defineMutation } from './_client';
import { getClient } from '../epicenter';

export const tabsKeys = {
  all: ['tabs'] as const,
  windows: ['windows'] as const,
};

export const tabs = {
  getAll: defineQuery({
    queryKey: tabsKeys.all,
    resultQueryFn: async () => {
      const client = await getClient();
      return client.browser.getAllTabs();
    },
  }),

  close: defineMutation({
    resultMutationFn: async (tabId: string) => {
      const client = await getClient();
      return client.browser.closeTab({ tabId });
    },
  }),
};
```

## Dependencies

From workspace catalog:
- `svelte: ^5.45.2`
- `vite: ^7.2.4`
- `wellcrafted: ^0.25.1`
- `arktype: ^2.1.27`

Additional:
- `wxt: ^0.20.x` (latest)
- `@wxt-dev/module-svelte: ^2.0.x`
- `@tanstack/svelte-query: ^5.x`
- `@wxt-dev/browser` (auto-included by WXT)

## Open Questions

1. Should the Epicenter client be initialized once in background and accessed via messaging, or re-created per popup open?
   - **Recommendation**: Initialize in background, use browser.runtime.sendMessage for popup communication

2. Storage strategy for Yjs document sync in extension context?
   - The browser workspace already uses `setupPersistence` provider
   - May need to adjust for extension storage APIs

## Success Criteria

- [ ] Extension loads in Chrome/Firefox
- [ ] Popup displays current tabs
- [ ] Tab actions (close, pin) work via query mutations
- [ ] State syncs via Epicenter workspace
