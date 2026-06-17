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

	// One declarative view over the dictation capability Rust owns. It shows the
	// matching panel when the global tap cannot fire, and renders nothing while it
	// works (`active`) or is still seeding (`unknown`). Each state has its own
	// remediation, and only the capability owner can tell them apart, so the
	// frontend reads the value rather than inferring it.
	//
	//   unsupported  Linux Wayland: the tap can never run, so there is nothing to
	//                grant. Explain the limit, no settings button.
	//   broken       a macOS grant that went stale after an update, where toggling
	//                does nothing: the fix is remove-and-re-add, so the guide leads.
	//   untrusted    macOS never granted: a capability pitch. Open Settings, toggle on.
	const isUnsupported = $derived(dictationCapability.isUnsupported);
	const isStale = $derived(dictationCapability.isStale);
	const needsAccessibility = $derived(dictationCapability.needsAccessibility);
</script>

{#if isUnsupported}
	<Alert.Root class="w-full text-left">
		<TriangleAlertIcon class="size-4" aria-hidden="true" />
		<Alert.Title>Global shortcuts need an X11 session</Alert.Title>
		<Alert.Description>
			On Wayland, Whispering can't read your keyboard globally, so the recording
			shortcut and paste-back stay off. Click the microphone to record, or switch
			to an X11 session to use the shortcut. Either way, transcripts go to your
			clipboard.
		</Alert.Description>
	</Alert.Root>
{:else if isStale}
	<Alert.Root class="w-full text-left">
		<TriangleAlertIcon class="size-4" aria-hidden="true" />
		<Alert.Title>Your global shortcut stopped working</Alert.Title>
		<Alert.Description>
			Whispering's macOS Accessibility access went stale after an update, so your
			global shortcut and paste-back are off. Toggling it won't help: remove
			Whispering from Accessibility and add it back to restore them. Until then,
			transcripts go to your clipboard.
		</Alert.Description>
		<Alert.Action>
			<Button size="sm" onclick={() => accessibilityGuide.open()}>
				Show me how
			</Button>
		</Alert.Action>
	</Alert.Root>
{:else if needsAccessibility}
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
