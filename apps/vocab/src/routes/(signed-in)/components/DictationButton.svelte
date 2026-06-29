<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import CircleStopIcon from '@lucide/svelte/icons/circle-stop';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import MicIcon from '@lucide/svelte/icons/mic';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { dictation } from '$lib/state/dictation.svelte';

	let {
		onTranscript,
		disabled = false,
	}: {
		/** Called with the recognized text once a recording transcribes. */
		onTranscript: (text: string) => void;
		/** Lock the mic, e.g. while a turn is generating. */
		disabled?: boolean;
	} = $props();

	// Thin state-machine router: the record/transcribe work lives in the dictation
	// state; here we only pick the next step and route the result to a toast or the
	// transcript callback.
	async function toggle() {
		if (dictation.status === 'recording') {
			const { data: transcript, error } = await dictation.stopAndTranscribe();
			if (error) {
				toast.error('Could not transcribe that', {
					description: extractErrorMessage(error),
				});
				return;
			}
			if (transcript) onTranscript(transcript);
			return;
		}

		const { error } = await dictation.start();
		if (error) {
			toast.error('Could not start recording', {
				description: extractErrorMessage(error),
			});
		}
	}
</script>

<Button
	variant={dictation.status === 'recording' ? 'destructive' : 'outline'}
	size="icon-lg"
	type="button"
	onclick={toggle}
	disabled={disabled || dictation.status === 'transcribing'}
	aria-label={dictation.status === 'recording'
		? 'Stop dictation'
		: 'Dictate a message'}
>
	{#if dictation.status === 'transcribing'}
		<LoaderCircleIcon class="animate-spin" />
	{:else if dictation.status === 'recording'}
		<CircleStopIcon />
	{:else}
		<MicIcon />
	{/if}
</Button>
