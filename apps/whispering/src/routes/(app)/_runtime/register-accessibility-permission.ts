import { toast } from '@epicenter/ui/sonner';
import { nanoid } from 'nanoid/non-secure';
import { os } from '#platform/os';
import { tauri } from '#platform/tauri';
import { goto } from '$app/navigation';

/**
 * Owns the macOS Accessibility-granted state for the desktop app: shows the
 * guide toast while ungranted, and calls `onGranted` once the permission lands.
 * It polls every second (like Handy) so granting in System Settings takes effect
 * without an app restart. Accessibility is the single gate for the whole
 * dictation flow (paste-back, selection capture, and the global shortcut
 * listener), so consumers subscribe here rather than each re-checking.
 */
export function registerAccessibilityPermission(options?: {
	onGranted?: () => void;
}) {
	// Only run on macOS desktop; elsewhere there is no Accessibility gate.
	if (!os.isApple || !tauri) return;
	const t = tauri;
	const { onGranted } = options ?? {};

	const accessibilityToastId = nanoid();
	let granted = false;
	let pollId: ReturnType<typeof setInterval> | undefined;

	async function check() {
		const { data: isGranted, error } =
			await t.permissions.accessibility.check();
		if (error) {
			console.error('Failed to check accessibility permissions:', error);
			return;
		}

		if (isGranted) {
			if (granted) return;
			granted = true;
			toast.dismiss(accessibilityToastId);
			if (pollId !== undefined) clearInterval(pollId);
			onGranted?.();
			return;
		}

		// Not granted: show the guide toast (idempotent by id, so the poll just
		// keeps it up rather than stacking).
		toast.warning('Accessibility Permission Issue', {
			id: accessibilityToastId,
			description:
				'Whispering needs accessibility permissions. This often requires removing and re-adding the app after updates.',
			duration: Number.POSITIVE_INFINITY,
			action: {
				label: 'View Guide',
				onClick: () => {
					goto('/macos-enable-accessibility');
					toast.dismiss(accessibilityToastId);
				},
			},
		});
	}

	void check();
	pollId = setInterval(() => void check(), 1000);

	return () => {
		toast.dismiss(accessibilityToastId);
		if (pollId !== undefined) clearInterval(pollId);
	};
}
