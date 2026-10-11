/**
 * Acceptance-only access to the mounted App opener, the captured Account, and
 * the auth client, so a journey can change identity behind the page's back.
 */
export function observeBoot() {
	return {
		name: 'observe-mounted-app-boot',
		enforce: 'pre',
		transform(code, id) {
			if (!id.endsWith('/boot-screens/app-boot.svelte')) return;
			return code.replace(
				'</script>',
				'Reflect.set(globalThis, "observedBoot", { opening, account, auth: props.auth });\n</script>',
			);
		},
	};
}
