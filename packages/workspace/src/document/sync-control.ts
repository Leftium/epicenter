import type { SyncControl } from './attach-sync.js';

export function composeSyncControls(
	...controls: readonly (SyncControl | null)[]
): SyncControl {
	return {
		pause() {
			for (const control of controls) control?.pause();
		},
		reconnect() {
			for (const control of controls) control?.reconnect();
		},
	};
}
