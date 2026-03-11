/**
 * Dev server ports for apps with cross-app URL references.
 *
 * Single source of truth—consumed by {@link createApps} for URL derivation
 * and by vite configs for server port assignment.
 *
 * @example
 * ```typescript
 * // In a vite config:
 * import { PORTS } from '@epicenter/constants/ports';
 *
 * export default defineConfig({
 *   server: { port: PORTS.AUDIO, strictPort: true },
 * });
 *
 * // In app code (prefer `createApps` or the vite re-export instead):
 * import { PORTS } from '@epicenter/constants/ports';
 *
 * const apiPort = PORTS.API; // 8787
 * ```
 */
export const PORTS = {
	/** Elysia API server (Cloudflare Workers via wrangler) */
	API: 8787,
	/** epicenter.sh web app (SvelteKit) */
	SH: 5173,
	/** Whispering audio transcription app (SvelteKit + Tauri) */
	AUDIO: 1420,
} as const satisfies Record<string, number>;

/**
 * App identifier derived from {@link PORTS}.
 *
 * Used by `createApps` to enforce that every port has a corresponding app
 * entry—and vice versa. Adding a key to `PORTS` without a matching entry in
 * `createApps` produces a compile error.
 */
export type AppId = keyof typeof PORTS;
