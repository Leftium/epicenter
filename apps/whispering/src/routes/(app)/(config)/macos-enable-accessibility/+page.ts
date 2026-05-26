import { tauri } from '$lib/tauri';

export const load = async () => {
	if (!tauri) {
		return { isAccessibilityGranted: false };
	}
	const { data: isAccessibilityGranted } =
		await tauri.permissions.accessibility.check();

	return {
		isAccessibilityGranted: isAccessibilityGranted ?? false,
	};
};
