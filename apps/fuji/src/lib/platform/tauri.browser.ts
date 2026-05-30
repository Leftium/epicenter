import type { Tauri } from './types';

// No native capability on the web. The materializer guards on `tauri == null`.
// The Tauri impl (tauri.tauri.ts) is never resolved on web, so `@tauri-apps/*`
// and its native commands stay out of the browser bundle entirely.
export const tauri: Tauri | null = null;
