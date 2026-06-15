<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import WandSparklesIcon from '@lucide/svelte/icons/wand-sparkles';
	import { permissions } from '$lib/state/permissions.svelte';

	// A capability pitch, not an error: the headline "dictate anywhere" feature
	// is locked, not broken. Off the gated platform (web, non-macOS desktop)
	// accessibility always reads 'granted', so a 'denied' status is inherently
	// macOS desktop with the grant actually off. The owner re-checks on window
	// focus, so returning from System Settings clears this with nothing to
	// dismiss and nothing stored: granting the permission is the dismiss.
	const isLocked = $derived(permissions.accessibility === 'denied');
</script>

{#if isLocked}
	<Alert.Root class="w-full text-left">
		<WandSparklesIcon class="size-4" />
		<Alert.Title>Dictate into any app, hands-free</Alert.Title>
		<Alert.Description>
			Grant Accessibility to start recording with your global shortcut and paste
			transcripts where you're typing. Until then, transcripts go to your
			clipboard.
		</Alert.Description>
		<Alert.Action>
			<Button size="sm" onclick={() => permissions.requestAccessibility()}>
				Enable
			</Button>
		</Alert.Action>
	</Alert.Root>
{/if}
