<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import {
		permissions,
		type PermissionStatus,
	} from '$lib/state/permissions.svelte';

	// Dev-only affordance (rendered behind `import.meta.env.DEV` in AppLayout):
	// cycle the Accessibility override so the notice and guide can be tested on
	// any build, including web dev where the grant is otherwise always 'granted'.
	// `null` resumes the live OS value.
	const current = $derived(permissions.accessibilityOverride);

	function cycle() {
		const next: PermissionStatus | null =
			current === null ? 'granted' : current === 'granted' ? 'denied' : null;
		permissions.setAccessibilityOverride(next);
	}
</script>

<!-- Bottom-right and faint-until-hover so it clears the left sidebar and the
mobile bottom nav (h-14); raised above that nav on narrow viewports. z above
dialogs so the override can be toggled while the guide dialog is open. The
cycling label is self-documenting, so no tooltip box to collide with content. -->
<Button
	variant="outline"
	size="sm"
	class="fixed right-3 bottom-3 z-[60] max-md:bottom-[4.75rem] font-mono text-xs opacity-40 hover:opacity-100"
	onclick={cycle}
>
	AX: {current ?? 'live'}
</Button>
