function unreachable(): never {
	throw new Error('Tauri-only service called from web bundle');
}
const stub: any = new Proxy(() => unreachable(), { get: () => unreachable });
export const FsError = stub;
export const FsServiceLive = stub;
