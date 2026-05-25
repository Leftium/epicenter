import { isTauri } from '@tauri-apps/api/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

/**
 * Custom `fetch` function implementation for SDK clients.
 * Uses Tauri's HTTP plugin in the desktop app to bypass CORS restrictions.
 * When `undefined`, SDKs fall back to the global `fetch`.
 */
export const customFetch = isTauri() ? tauriFetch : undefined;
