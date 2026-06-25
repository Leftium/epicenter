<script lang="ts">
	import { cn } from '@epicenter/ui/utils';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';

	// A VAD session's capture state, shown beside the live meter as one small mark:
	// a dot that is dim while merely listening (armed, hearing sound but not yet
	// latched) and lights up the instant capture latches onto speech, then becomes
	// a spinner while a previous phrase is still transcribing. The bars next to it
	// track raw loudness; this mark tracks VAD's decision, which lags loudness by a
	// detection delay, so the two are deliberately separate signals. Shared by the
	// floating pill and the home capture card so the three states read identically
	// on both; each surface passes its own palette.
	//
	// `speaking` and `transcribing` are orthogonal at the source; this mark shows
	// one of three states, so transcribing wins (the spinner replaces the dot).
	// That precedence lives here, the one place this mark is rendered.
	let {
		speaking,
		transcribing,
		dimClass,
		litClass,
		spinnerClass,
	}: {
		/** VAD has latched onto speech: the dot lights from `dimClass` to `litClass`. */
		speaking: boolean;
		/** A previous phrase still transcribing: the dot is replaced by a spinner. */
		transcribing: boolean;
		/** Dot color while listening (armed, not yet latched onto speech). */
		dimClass: string;
		/** Dot color once speech is latched. */
		litClass: string;
		/** Spinner color while a previous phrase transcribes. */
		spinnerClass: string;
	} = $props();

	// One title for whichever state shows, identical on every surface.
	const title = $derived(
		transcribing
			? 'Transcribing previous phrase'
			: speaking
				? 'Capturing speech'
				: 'Listening',
	);
</script>

<span class="inline-flex items-center justify-center" {title} aria-hidden="true">
	{#if transcribing}
		<LoaderCircleIcon class={cn('size-3.5 animate-spin', spinnerClass)} />
	{:else}
		<span
			class={cn(
				'size-2 rounded-full transition-colors duration-150',
				speaking ? litClass : dimClass,
			)}
		></span>
	{/if}
</span>
