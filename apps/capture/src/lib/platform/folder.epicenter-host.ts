/**
 * The Epicenter host leaf: the page was served by the desktop host, so the
 * captures are a real directory reached over the host's same-origin bridge.
 *
 * The page holds no folder handle. The host's browser session is the
 * credential; without it the bridge answers 401 and opening fails with that
 * reason. There is no browser folder to fall back to in this build.
 */
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { createBridgeTransport, openBridgeFolder } from '../bridge/client.js';
import { createShellLifetime, type ShellPort } from './shell-lifetime.js';
import type { OpenCaptureHost } from './types.js';

const tauriPort: ShellPort = {
	listen: (event, handler) =>
		listen<unknown>(event, ({ payload }) => handler(payload)),
	invoke: (command, args) => invoke(command, args),
};

/** Called from a mounted component; importing this module opens nothing. */
export const openCaptureHost: OpenCaptureHost = async () => {
	const bridge = await openBridgeFolder(createBridgeTransport());
	const lifetime = createShellLifetime(isTauri() ? tauriPort : undefined);
	await lifetime.ready;
	return {
		folder: bridge.folder,
		location: { kind: 'directory', path: bridge.root },
		onExternalChange: bridge.onExternalChange,
		onQuitRequested: lifetime.onQuitRequested,
		onHostStopped: lifetime.onHostStopped,
		get quitProtectionProblem() {
			return lifetime.quitProtectionProblem;
		},
		async close() {
			lifetime.close();
			await bridge.close();
		},
	};
};
