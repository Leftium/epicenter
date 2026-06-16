import type { SatisfiedCommand } from '$lib/commands';

/**
 * Browser builds contribute no extra commands. The transformation picker is
 * desktop-only: it captures the selection in another app via a simulated system
 * copy and opens a separate Tauri window, neither of which a browser tab can do.
 * The cross-platform `Run transformation on clipboard` command covers the web
 * transformation path. See `commands.tauri.ts` for the desktop addition.
 */
export const platformCommands = [] as const satisfies SatisfiedCommand[];
