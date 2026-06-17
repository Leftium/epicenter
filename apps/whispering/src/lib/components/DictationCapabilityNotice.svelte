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
</script>

<!-- One declarative view over the dictation capability Rust owns: the matching
panel when the global tap cannot fire, nothing while it works (`active`) or is
still seeding (`unknown`). Each state has its own remediation and only the
capability owner can tell them apart, so we read the value, never infer it. The
branch order is load-bearing: `broken` is caught before the plain untrusted case
(`needsAccessibility` covers both), so the last branch is the never-granted pitch. -->
{#if dictationCapability.isUnsupported}
	<!-- Linux Wayland: the tap can never run, so there is nothing to grant.
	Explain the limit, no settings button. -->
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
{:else if dictationCapability.isStale}
	<!-- A macOS grant that went stale after an update, where toggling does
	nothing: the fix is remove-and-re-add, so the guide leads. -->
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
{:else if dictationCapability.needsAccessibility}
	<!-- macOS never granted (broken is handled above): a capability pitch.
	Open Settings, toggle on. -->
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
