export const load = async () => {
	if (!window.__TAURI_INTERNALS__) {
		return { isAccessibilityGranted: false };
	}
	const { PermissionsServiceLive } = await import(
		'$lib/services/permissions'
	);
	const { data: isAccessibilityGranted } =
		await PermissionsServiceLive.accessibility.check();

	return {
		isAccessibilityGranted: isAccessibilityGranted ?? false,
	};
};
