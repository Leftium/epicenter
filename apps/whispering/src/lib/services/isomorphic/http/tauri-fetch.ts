import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

/** Use Tauri's HTTP plugin when running in the desktop app, native fetch otherwise. */
export const customFetch = window.__TAURI_INTERNALS__ ? tauriFetch : undefined;
