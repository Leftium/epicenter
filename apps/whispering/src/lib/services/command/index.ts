function unreachable(): never {
	throw new Error('Tauri-only service called from web bundle');
}
const stub: any = new Proxy(() => unreachable(), { get: () => unreachable });
export const CommandError = stub;
export const asShellCommand = stub as (str: string) => any;
export const CommandServiceLive = stub;
