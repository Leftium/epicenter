import {
	active,
	isPermissionGranted,
	removeActive,
	requestPermission,
	sendNotification,
} from '@tauri-apps/plugin-notification';
import { nanoid } from 'nanoid/non-secure';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { NotificationService, UnifiedNotificationOptions } from './types';
import {
	hashNanoidToNumber,
	NotificationError,
	toTauriNotification,
} from './types';

export type { NotificationError, NotificationService } from './types';

/**
 * Desktop notification service using Tauri's notification plugin.
 */

const removeNotificationById = async (
	id: number,
): Promise<Result<void, NotificationError>> => {
	const { data: activeNotifications, error: activeNotificationsError } =
		await tryAsync({
			try: async () => await active(),
			catch: (error) => NotificationError.ListActiveFailed({ cause: error }),
		});
	if (activeNotificationsError) return Err(activeNotificationsError);
	const matchingActiveNotification = activeNotifications.find(
		(notification) => notification.id === id,
	);
	if (matchingActiveNotification) {
		const { error: removeActiveError } = await tryAsync({
			try: async () => await removeActive([matchingActiveNotification]),
			catch: (error) => NotificationError.RemoveFailed({ id, cause: error }),
		});
		if (removeActiveError) return Err(removeActiveError);
	}
	return Ok(undefined);
};

export const NotificationServiceLive = {
	async notify({
		id: notificationId,
		...notificationOptions
	}: UnifiedNotificationOptions) {
		const idStringified = notificationId ?? nanoid();
		const id = hashNanoidToNumber(idStringified);

		await removeNotificationById(id);

		const { error: notifyError } = await tryAsync({
			try: async () => {
				let permissionGranted = await isPermissionGranted();
				if (!permissionGranted) {
					const permission = await requestPermission();
					permissionGranted = permission === 'granted';
				}
				if (permissionGranted) {
					const tauriOptions = toTauriNotification({
						id: notificationId,
						...notificationOptions,
					});
					sendNotification({
						...tauriOptions,
						id, // Override with our numeric id
					});
				}
			},
			catch: (error) => NotificationError.SendFailed({ cause: error }),
		});
		if (notifyError) return Err(notifyError);
		return Ok(idStringified);
	},

	clear: async (idStringified) => {
		const removeNotificationResult = await removeNotificationById(
			hashNanoidToNumber(idStringified),
		);
		return removeNotificationResult;
	},
} satisfies NotificationService;
