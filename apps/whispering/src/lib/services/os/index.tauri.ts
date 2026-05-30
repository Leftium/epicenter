import { type } from '@tauri-apps/plugin-os';

// Tauri exposes the real OS synchronously and it never changes during a
// session, so we read it once at module load and expose plain booleans.
const currentOs = type();

export const IS_MACOS = currentOs === 'macos';
export const IS_LINUX = currentOs === 'linux';
export const IS_WINDOWS = currentOs === 'windows';
