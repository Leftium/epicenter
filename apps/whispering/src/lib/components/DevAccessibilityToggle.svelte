<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { dictationCapability } from '$lib/state/dictation-capability.svelte';
	import type { DictationCapability } from '$lib/tauri/commands';

	// Dev-only affordance (rendered behind `import.meta.env.DEV` in GlobalDialogs):
	// cycle the capability override so the notice and guide can be tested on any
	// build, including web dev where the value is otherwise always `unknown`.
	// `null` resumes the live value.
	const current = $derived(dictationCapability.override);

	// The states the accessibility surfaces branch on: never-granted, working,
	// and the stale post-update grant. `null` returns to the live value.
	const CYCLE: (DictationCapability | null)[] = [
		'untrusted',
		'active',
		'broken',
		null,
	];
	function next(value: DictationCapability | null): DictationCapability | null {
		const index = CYCLE.indexOf(value);
		return CYCLE[(index + 1) % CYCLE.length] ?? null;
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
	onclick={() => dictationCapability.setOverride(next(current))}
>
	AX: {current ?? 'live'}
</Button>
