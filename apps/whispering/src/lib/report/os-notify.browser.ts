import { Err, tryAsync } from 'wellcrafted/result';
import { resolveDisplay } from './display';
import type { OsNotifySink } from './types';

export const osNotifySink: OsNotifySink = (level, notice) => {
	if (level !== 'error' || document.hasFocus()) return;

	const { title, description: body } = resolveDisplay(notice);

	void tryAsync({
		try: async () => {
			if (!('Notification' in window)) return;
			let permission = Notification.permission;
			if (permission === 'default') {
				permission = await Notification.requestPermission();
			}
			if (permission === 'granted') new Notification(title, { body });
		},
		catch: (cause) => Err(cause),
	});
};
