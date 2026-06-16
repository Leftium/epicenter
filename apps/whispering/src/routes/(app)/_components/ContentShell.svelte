<script lang="ts">
	import { commandCallbacks } from '$lib/commands';
	import {
		RECORDER_STATE_TO_ICON,
		VAD_STATE_TO_ICON,
	} from '$lib/constants/audio';
	import { manualRecorder } from '$lib/state/manual-recorder.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { vadRecorder } from '$lib/state/vad-recorder.svelte';

	let { children } = $props();
</script>

<!--
	The inner content region. On the tiny always-on-top window (below the `xxs`
	breakpoint) it collapses to a single tap-to-record button; at normal sizes it
	renders the page. This is pure view: it owns no app lifecycle, so the
	responsive nav branch is free to remount it on breakpoint changes.
-->
{#if settings.get('recording.mode') === 'vad'}
	<button
		class="xxs:hidden hover:bg-accent hover:text-accent-foreground h-screen w-screen transform duration-300 ease-in-out"
		onclick={() => commandCallbacks.toggleVadRecording()}
	>
		<span
			style="filter: drop-shadow(0px 2px 4px rgba(0, 0, 0, 0.5));"
			class="text-[48px] leading-none"
		>
			{VAD_STATE_TO_ICON[vadRecorder.state]}
		</span>
	</button>
{:else}
	<button
		class="xxs:hidden hover:bg-accent hover:text-accent-foreground h-screen w-screen transform duration-300 ease-in-out"
		onclick={() => commandCallbacks.toggleManualRecording()}
	>
		<span
			style="filter: drop-shadow(0px 2px 4px rgba(0, 0, 0, 0.5));"
			class="text-[48px] leading-none"
		>
			{RECORDER_STATE_TO_ICON[manualRecorder.state]}
		</span>
	</button>
{/if}

<div class="hidden flex-1 flex-col gap-2 xxs:flex min-w-0 w-full">
	{@render children()}
</div>
