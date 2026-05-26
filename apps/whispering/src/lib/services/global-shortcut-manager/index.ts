function unreachable(): never {
	throw new Error('Tauri-only service called from web bundle');
}
const stub: any = new Proxy(() => unreachable(), { get: () => unreachable });
export const GlobalShortcutManagerLive = stub;
export const isValidElectronAccelerator = stub as (accelerator: string) => boolean;
export const pressedKeysToTauriAccelerator = stub;
