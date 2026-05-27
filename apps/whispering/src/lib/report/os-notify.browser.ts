import { Err, tryAsync } from 'wellcrafted/result';
import { resolveDisplay } from './display';
import type { Notice, OsNotifySink, Problem } from './types';

export const osNotifySink: OsNotifySink = (event) => {
	if (event.level !== 'error' || document.hasFocus()) return;

	const data = (event.data ?? {}) as Notice | Problem;
	const { title, description: body } = resolveDisplay(data);

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
