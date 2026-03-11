import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

/**
 * Custom `fetch` function implementation for SDK clients.
 * Uses Tauri's HTTP plugin in the desktop app to bypass CORS restrictions.
 * When `undefined`, SDKs fall back to the global `fetch`.
 */
export const customFetch = window.__TAURI_INTERNALS__ ? tauriFetch : undefined;
