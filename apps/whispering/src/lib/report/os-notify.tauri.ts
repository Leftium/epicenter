import {
	isPermissionGranted,
	requestPermission,
	sendNotification,
} from '@tauri-apps/plugin-notification';
import { Err, tryAsync } from 'wellcrafted/result';
import { resolveDisplay } from './display';
import type { OsNotifySink } from './types';

export const osNotifySink: OsNotifySink = (event) => {
	if (event.level !== 'error' || document.hasFocus()) return;

	const { title, description: body } = resolveDisplay(event.data);

	void tryAsync({
		try: async () => {
			let permissionGranted = await isPermissionGranted();
			if (!permissionGranted) {
				const permission = await requestPermission();
				permissionGranted = permission === 'granted';
			}
			if (permissionGranted) sendNotification({ title, body });
		},
		catch: (cause) => Err(cause),
	});
};
