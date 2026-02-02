# Services and Query Folder Reorganization

## Overview

Reorganize the `services/` and `query/` directories to explicitly separate desktop-only code from isomorphic (cross-platform) code through folder structure.

## Naming Decision

**Chosen: `desktop/` + `isomorphic/`**

Rationale:
- "Desktop" clearly indicates Tauri-specific code
- "Isomorphic" is the established JS ecosystem term for code that runs in multiple environments
- Alternatives considered:
  - `shared/` - too vague, could mean shared between features
  - `universal/` - good but less precise than isomorphic
  - `common/` - implies utility code, not full services
  - `cross-platform/` - verbose

## Current State

### services/index.ts
```typescript
// Desktop-only services bundled in desktopServices constant
export const desktopServices = {
  autostart, command, ffmpeg, fs, tray,
  globalShortcutManager, permissions, cpalRecorder, ffmpegRecorder
};

// Cross-platform services exported individually
export { analytics, text, completions, db, download, ... };
```

### query/index.ts
```typescript
// Cross-platform RPC
export const rpc = {
  analytics, text, commands, db, download, recorder,
  localShortcuts, sound, transcription, transformer, notify, delivery
};

// Desktop-only RPC
export const desktopRpc = {
  autostart, tray, ffmpeg, globalShortcuts
};
```

## Target State

### Services Structure

```
services/
├── desktop/
│   ├── index.ts              # exports desktopServices constant
│   ├── autostart.ts          # (moved from autostart/desktop.ts)
│   ├── command.ts            # (moved from command/desktop.ts)
│   ├── ffmpeg.ts             # (moved from ffmpeg/desktop.ts)
│   ├── fs.ts                 # (moved from fs/desktop.ts)
│   ├── tray.ts               # (moved from tray.ts)
│   ├── global-shortcut-manager.ts
│   ├── permissions.ts        # (moved from permissions/index.ts)
│   └── recorder/
│       ├── cpal.ts
│       └── ffmpeg.ts
├── isomorphic/
│   ├── index.ts              # exports all isomorphic services
│   ├── analytics/
│   ├── completion/
│   ├── db/
│   ├── download/
│   ├── http/
│   ├── notifications/
│   ├── os/
│   ├── recorder/
│   │   └── navigator.ts
│   ├── sound/
│   ├── text/
│   ├── toast.ts
│   ├── transcription/
│   └── local-shortcut-manager.ts
└── types.ts                  # shared type definitions
```

### Query Structure

```
query/
├── desktop/
│   ├── index.ts              # exports desktopRpc constant
│   ├── autostart.ts
│   ├── ffmpeg.ts
│   ├── tray.ts
│   └── shortcuts.ts          # globalShortcuts only
├── isomorphic/
│   ├── index.ts              # exports rpc constant
│   ├── actions.ts
│   ├── analytics.ts
│   ├── db.ts
│   ├── delivery.ts
│   ├── download.ts
│   ├── notify.ts
│   ├── recorder.ts
│   ├── shortcuts.ts          # localShortcuts only
│   ├── sound.ts
│   ├── text.ts
│   ├── transcription.ts
│   ├── transformer.ts
│   └── vad.svelte.ts
└── _client.ts                # shared query client setup
```

## Implementation Tasks

- [ ] Create `services/desktop/` folder structure
- [ ] Create `services/isomorphic/` folder structure
- [ ] Move desktop-only services to `services/desktop/`
- [ ] Move isomorphic services to `services/isomorphic/`
- [ ] Create new index files for each folder
- [ ] Delete `services/index.ts` (no backwards compatibility)
- [ ] Create `query/desktop/` folder structure
- [ ] Create `query/isomorphic/` folder structure
- [ ] Move desktop-only query modules to `query/desktop/`
- [ ] Move isomorphic query modules to `query/isomorphic/`
- [ ] Split `shortcuts.ts` into desktop (global) and isomorphic (local)
- [ ] Create new index files for each folder
- [ ] Delete `query/index.ts` (no backwards compatibility)
- [ ] Update all import paths across the codebase
- [ ] Run type check to verify no regressions
- [ ] Run tests if available

## Import Path Changes

### Before
```typescript
import { desktopServices, analytics, db } from '$lib/services';
import { rpc, desktopRpc } from '$lib/query';
```

### After (breaking change - explicit imports required)
```typescript
// Desktop-only code
import { desktopServices } from '$lib/services/desktop';
import { desktopRpc } from '$lib/query/desktop';

// Isomorphic code
import { analytics, db } from '$lib/services/isomorphic';
import { rpc } from '$lib/query/isomorphic';
```

## Benefits

1. **Clear separation of concerns**: File location immediately indicates platform requirements
2. **Better tree-shaking potential**: Bundlers can more easily exclude desktop code from web builds
3. **Easier onboarding**: New developers understand the architecture at a glance
4. **Consistent pattern**: Same structure in both services/ and query/
5. **Explicit imports**: No ambiguity about where code comes from; imports are self-documenting

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Many file moves | Use git mv to preserve history |
| Import path breakage | Update all imports across codebase in same PR |
| Circular dependencies | Services should only depend on types, not other services |
| Merge conflicts | Complete in one focused PR |

## Open Questions

1. Should types stay in individual service folders or move to a shared `types/` folder?
   - **Recommendation**: Keep types co-located with their services for now

2. Should we also reorganize `recorder/` which has both desktop (cpal, ffmpeg) and isomorphic (navigator)?
   - **Recommendation**: Yes, split into `desktop/recorder/` and `isomorphic/recorder/`

3. Should the types file (`services/types.ts`) move to a specific folder?
   - **Recommendation**: Keep at root level since it contains shared type definitions

## Review

_To be filled after implementation_
