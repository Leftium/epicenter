import type { Shortcuts } from './types';

/**
 * Web build of `#platform/system-shortcuts`: there is no system-global shortcut
 * backend in a browser tab, so this is always `null`. The reach router
 * (`shortcuts.ts`) reads that absence as "this platform caps at focused reach,"
 * so every binding stays in the synced focused store and nothing routes to a
 * system store that does not exist. The Tauri impl supplies the real backend.
 * See ADR-0041.
 */
export const systemShortcuts: Shortcuts | null = null;
