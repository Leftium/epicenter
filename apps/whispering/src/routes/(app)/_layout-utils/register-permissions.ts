import { toast, toastOnError } from '@epicenter/ui/sonner';
import { nanoid } from 'nanoid/non-secure';
import { goto } from '$app/navigation';
import { IS_MACOS } from '$lib/constants/platform';

export function registerAccessibilityPermission() {
	// Only run on macOS desktop
	if (!IS_MACOS) return;

	const accessibilityToastId = nanoid();

	// Check accessibility permission once on mount
	(async () => {
		const { PermissionsServiceLive } = await import(
			'$lib/services/permissions'
		);
		const { data: isAccessibilityGranted, error } =
			await PermissionsServiceLive.accessibility.check();

		if (error) {
			console.error('Failed to check accessibility permissions:', error);
			return;
		}

		if (!isAccessibilityGranted) {
			// Toast if permission not granted
			toast.warning('Accessibility Permission Issue', {
				id: accessibilityToastId,
				description:
					'Whispering needs accessibility permissions. This often requires removing and re-adding the app after updates.',
				duration: Number.POSITIVE_INFINITY,
				action: {
					label: 'View Guide',
					onClick: () => {
						goto('/macos-enable-accessibility');
						// Dismiss the toast
						toast.dismiss(accessibilityToastId);
					},
				},
			});
		}
	})();

	// Return cleanup function
	return () => {
		toast.dismiss(accessibilityToastId);
	};
}

export function registerMicrophonePermission() {
	// Only run on macOS desktop
	if (!IS_MACOS) return;

	const microphoneToastId = nanoid();

	// Check microphone permission once on mount
	(async () => {
		const { PermissionsServiceLive } = await import(
			'$lib/services/permissions'
		);
		const { data: isMicrophoneGranted, error } =
			await PermissionsServiceLive.microphone.check();

		if (error) {
			console.error('Failed to check microphone permissions:', error);
			return;
		}

		if (!isMicrophoneGranted) {
			// Toast if permission not granted
			toast.info('Microphone Permission Required', {
				id: microphoneToastId,
				description: 'Whispering needs microphone access to record audio',
				duration: Number.POSITIVE_INFINITY,
				action: {
					label: 'Enable Permission',
					onClick: async () => {
						const { PermissionsServiceLive } = await import(
							'$lib/services/permissions'
						);
						const { error: requestError } =
							await PermissionsServiceLive.microphone.request();

						if (requestError)
							return toastOnError(
								requestError,
								'Failed to request microphone permission',
							);
						// Dismiss the toast after requesting
						toast.dismiss(microphoneToastId);
					},
				},
			});
		}
	})();

	// Return cleanup function
	return () => {
		toast.dismiss(microphoneToastId);
	};
}
