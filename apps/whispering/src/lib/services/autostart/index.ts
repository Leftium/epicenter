/**
 * Web stub for a Tauri-only service. See `index.tauri.ts` for the real
 * implementation. Web bundles include this stub because some consumers
 * (mostly under `rpc/desktop/`) are part of the web dependency graph even
 * though their call sites gate on `window.__TAURI_INTERNALS__`. Anything
 * called on web throws clearly.
 */
function unreachable(): never {
	throw new Error('Tauri-only service called from web bundle');
}
const stub: any = new Proxy(() => unreachable(), { get: () => unreachable });
export const AutostartError = stub;
export const AutostartServiceLive = stub;
