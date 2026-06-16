<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import WandSparklesIcon from '@lucide/svelte/icons/wand-sparkles';
	import {
		accessibilityGuide,
		openSystemSettings,
	} from '$lib/components/MacosAccessibilityGuideDialog.svelte';
	import { dictationCapability } from '$lib/state/dictation-capability.svelte';

	// A capability pitch, not an error: the headline "dictate anywhere" feature
	// is locked, not broken. The capability owner reports `needsAccessibility`
	// only on macOS desktop with the grant off or stale (off the gated platform
	// it is `active`), so the value already encodes the platform and there is no
	// separate os.isApple branch. The owner pushes the change when Rust regains
	// trust, so granting clears this with nothing to dismiss and nothing stored.
	const isLocked = $derived(dictationCapability.needsAccessibility);
</script>

{#if isLocked}
	<Alert.Root class="w-full text-left">
		<WandSparklesIcon class="size-4" aria-hidden="true" />
		<Alert.Title>Dictate into any app, hands-free</Alert.Title>
		<Alert.Description>
			Open macOS Accessibility settings, then turn on Whispering to start
			recording with your global shortcut and paste transcripts where you're
			typing. Until then, transcripts go to your clipboard.
			<Button
				variant="link"
				class="h-auto p-0 text-sm font-normal"
				onclick={() => accessibilityGuide.open()}
			>
				Already enabled but not working?
			</Button>
		</Alert.Description>
		<Alert.Action>
			<Button size="sm" onclick={openSystemSettings}>Open Settings</Button>
		</Alert.Action>
	</Alert.Root>
{/if}
