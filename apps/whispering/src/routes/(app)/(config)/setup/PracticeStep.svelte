<!-- First-dictation step: live practice recording. -->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import MicIcon from '@lucide/svelte/icons/mic';
	import type { RecordingTrigger } from '$lib/constants/audio';
	import type { SetupReadiness } from '$lib/setup/setup-readiness';
	import { settings } from '$lib/state/settings.svelte';
	import PracticeDictation from './PracticeDictation.svelte';

	let {
		readiness,
		practiceSucceeded,
		onSuccess,
	}: {
		readiness: SetupReadiness;
		practiceSucceeded: boolean;
		onSuccess: () => void;
	} = $props();

	const selectedRecordingTrigger = $derived(settings.get('recording.trigger'));
	const canFinish = $derived(readiness.canFinish);
	const canPractice = $derived(
		canFinish && selectedRecordingTrigger === 'manual',
	);

	const disabledReason = $derived(
		readiness.primaryIssue ??
			(
				{
					manual: 'Finish setup before practicing.',
					vad: 'Practice uses one-tap recording. Switch the recording trigger to Manual to practice here.',
				} satisfies Record<RecordingTrigger, string>
			)[selectedRecordingTrigger],
	);
</script>

<div class="space-y-4">
	{#if canPractice && !practiceSucceeded}
		<Alert.Root>
			<MicIcon class="size-4" />
			<Alert.Title>Try one sentence</Alert.Title>
			<Alert.Description>
				This is the safest check before your first real dictation. The
				transcript stays here.
			</Alert.Description>
		</Alert.Root>
	{:else if canFinish && selectedRecordingTrigger === 'vad'}
		<Alert.Root>
			<MicIcon class="size-4" />
			<Alert.Title>Voice Activated mode selected</Alert.Title>
			<Alert.Description>
				Finish setup now, then test Voice Activated dictation from the main app.
				Switch to Manual if you want a one-tap practice recording here.
			</Alert.Description>
		</Alert.Root>
	{/if}

	<PracticeDictation
		disabled={!canPractice}
		{disabledReason}
		{onSuccess}
	/>
</div>
