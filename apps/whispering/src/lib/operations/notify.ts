import { dev } from '$app/environment';
import { notificationLog } from '$lib/components/NotificationLog.svelte';
import { services } from '$lib/services';
import type { UnifiedNotificationOptions } from '$lib/services/notifications/types';

type NotifyVariant = NonNullable<UnifiedNotificationOptions['variant']>;
type NotifyOptions = Omit<UnifiedNotificationOptions, 'variant'>;

/**
 * Show a notification through both the in-app toast and (for non-loading variants)
 * the OS notification surface. Loading notifications are toast-only because OS
 * notifications can't be updated/replaced with the same ID and loading states would
 * create notification spam.
 */
async function notifyVariant(variant: NotifyVariant, options: NotifyOptions) {
	const fullOptions = {
		...options,
		variant,
	} satisfies UnifiedNotificationOptions;

	if (dev) {
		switch (variant) {
			case 'error':
				console.error('[Notify]', fullOptions);
				break;
			case 'warning':
				console.warn('[Notify]', fullOptions);
				break;
			case 'info':
			case 'loading':
				console.info('[Notify]', fullOptions);
				break;
			case 'success':
				console.log('[Notify]', fullOptions);
				break;
		}
	}

	notificationLog.addLog(fullOptions);
	const toastId = services.toast.show(fullOptions);

	if (variant !== 'loading') {
		const { error: notifyError } =
			await services.notification.notify(fullOptions);
		if (notifyError) {
			console.error('[Notify] OS notification error:', notifyError);
		}
	}

	return toastId;
}

export const notify = {
	success: (options: NotifyOptions) => notifyVariant('success', options),
	error: (options: NotifyOptions) => notifyVariant('error', options),
	warning: (options: NotifyOptions) => notifyVariant('warning', options),
	info: (options: NotifyOptions) => notifyVariant('info', options),
	loading: (options: NotifyOptions) => notifyVariant('loading', options),
	dismiss: (id?: string | number) => services.toast.dismiss(id),
};
