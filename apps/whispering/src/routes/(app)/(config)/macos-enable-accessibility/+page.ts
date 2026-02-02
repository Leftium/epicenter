import { desktopServices } from '$lib/services';

export const load = async () => {
	const { data: isAccessibilityGranted } =
		await desktopServices.permissions.accessibility.check();

	return {
		isAccessibilityGranted: isAccessibilityGranted ?? false,
	};
};
