<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import WandSparklesIcon from '@lucide/svelte/icons/wand-sparkles';
	import {
		accessibilityGuide,
		openSystemSettings,
	} from '$lib/components/MacosAccessibilityGuideDialog.svelte';
	import { dictationCapability } from '$lib/state/dictation-capability.svelte';

	// Show the notice whenever macOS needs an Accessibility action, and pick the
	// remediation by which one. The two differ, and only the capability owner can
	// tell them apart: the OS reports a stale grant as trusted, so the frontend
	// cannot infer this.
	//
	//   untrusted  never granted: a capability pitch. Open Settings, toggle on.
	//   broken     a grant that went stale after an update, where toggling does
	//              nothing: the fix is remove-and-re-add, so the guide leads.
	const isLocked = $derived(dictationCapability.needsAccessibility);
	const isStale = $derived(dictationCapability.isStale);
</script>

{#if isLocked}
	{#if isStale}
		<Alert.Root class="w-full text-left">
			<TriangleAlertIcon class="size-4" aria-hidden="true" />
			<Alert.Title>Your global shortcut stopped working</Alert.Title>
			<Alert.Description>
				Whispering's macOS Accessibility access went stale after an update, so
				your global shortcut and paste-back are off. Toggling it won't help:
				remove Whispering from Accessibility and add it back to restore them.
				Until then, transcripts go to your clipboard.
			</Alert.Description>
			<Alert.Action>
				<Button size="sm" onclick={() => accessibilityGuide.open()}>
					Show me how
				</Button>
			</Alert.Action>
		</Alert.Root>
	{:else}
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
{/if}
