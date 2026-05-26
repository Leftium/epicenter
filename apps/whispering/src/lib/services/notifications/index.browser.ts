import { nanoid } from 'nanoid/non-secure';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import type { NotificationService, UnifiedNotificationOptions } from './types';
import { NotificationError, toBrowserNotification } from './types';

export type { NotificationError, NotificationService } from './types';

/**
 * Web-based notification service.
 *
 * Most application code should NOT use this directly. Use the higher-level
 * `notify` API from `$lib/operations/notify` instead, which fires both an
 * in-app toast and (for non-loading variants) the OS notification.
 */

// Cache extension detection result
let extensionChecked = false;
let hasExtension = false;

/**
 * Detects if a browser extension is available for enhanced notification support.
 * Results are cached to avoid repeated detection attempts.
 */
const detectExtension = async (): Promise<boolean> => {
	if (extensionChecked) return hasExtension;
	// Future: ping the extension and wait for a response with a timeout.
	hasExtension = false;
	extensionChecked = true;
	return hasExtension;
};

export const NotificationServiceLive: NotificationService = {
	async notify({
		action,
		id,
		title,
		...notificationOptions
	}: UnifiedNotificationOptions) {
		const notificationId = id ?? nanoid();

		// Try extension first if available
		if (await detectExtension()) {
			// Future: Extension notification support
		}

		// Browser notification fallback
		const { error } = await tryAsync({
			try: async () => {
				const isNotificationsSupported = 'Notification' in window;
				if (!isNotificationsSupported) {
					throw new Error('Browser does not support notifications');
				}

				let permission = Notification.permission;
				if (permission === 'default') {
					permission = await Notification.requestPermission();
				}

				if (permission !== 'granted') {
					throw new Error('Notification permission denied');
				}

				const browserOptions = toBrowserNotification({
					action,
					id,
					title,
					...notificationOptions,
				});
				const notification = new Notification(title, browserOptions);

				if (action?.type === 'link') {
					const linkAction = action;
					notification.onclick = () => {
						window.location.href = linkAction.href;
						notification.close();
					};
				}
			},
			catch: (error) => NotificationError.SendFailed({ cause: error }),
		});

		if (error) return Err(error);
		return Ok(notificationId);
	},

	async clear(_id: string) {
		// Browser notifications don't have a direct clear API; they auto-dismiss
		// or require service worker control.
		return Ok(undefined);
	},
};
