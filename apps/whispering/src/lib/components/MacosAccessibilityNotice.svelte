<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import WandSparklesIcon from '@lucide/svelte/icons/wand-sparkles';
	import { accessibilityGuide } from '$lib/components/MacosAccessibilityGuideDialog.svelte';
	import { permissions } from '$lib/state/permissions.svelte';

	// A capability pitch, not an error: the headline "dictate anywhere" feature
	// is locked, not broken. Off the gated platform (web, non-macOS desktop)
	// accessibility always reads 'granted', so a 'denied' status is inherently
	// macOS desktop with the grant actually off; the permission state already
	// encodes the platform, so there is no separate os.isApple branch. The owner
	// re-checks on window focus, so granting clears this with nothing to dismiss
	// and nothing stored: granting the permission is the dismiss.
	const isLocked = $derived(permissions.accessibility === 'denied');
</script>

{#if isLocked}
	<Alert.Root class="w-full text-left">
		<WandSparklesIcon class="size-4" aria-hidden="true" />
		<Alert.Title>Dictate into any app, hands-free</Alert.Title>
		<Alert.Description>
			Grant Accessibility to start recording with your global shortcut and paste
			transcripts where you're typing. Until then, transcripts go to your
			clipboard.
			<Button
				variant="link"
				class="h-auto p-0 text-sm font-normal"
				onclick={() => accessibilityGuide.open()}
			>
				Already enabled but not working?
			</Button>
		</Alert.Description>
		<Alert.Action>
			<Button size="sm" onclick={() => permissions.requestAccessibility()}>
				Enable
			</Button>
		</Alert.Action>
	</Alert.Root>
{/if}
