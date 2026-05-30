import { type as osType } from '@tauri-apps/plugin-os';
import type { Os } from './os.types';

// Tauri reads the real OS synchronously and it never changes during a session,
// so identity is resolved once at module load. whispering's desktop targets are
// macOS, Windows, and Linux; 'ios' is matched anyway so both seam impls compute
// `isApple` identically.
const current = osType();

export const os: Os = {
	isApple: current === 'macos' || current === 'ios',
	isLinux: current === 'linux',
};
