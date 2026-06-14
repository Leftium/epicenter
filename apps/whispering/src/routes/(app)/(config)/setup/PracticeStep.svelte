<!-- First-dictation step: live practice recording. -->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import MicIcon from '@lucide/svelte/icons/mic';
	import type { RecordingMode } from '$lib/constants/audio';
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

	const selectedRecordingMode = $derived(settings.get('recording.mode'));
	const canFinish = $derived(readiness.canFinish);
	const canPractice = $derived(canFinish && selectedRecordingMode === 'manual');

	const disabledReason = $derived(
		readiness.primaryIssue ??
			(
				{
					manual: 'Finish setup before practicing.',
					upload:
						'Practice uses live recording. Switch recording mode to practice.',
					vad: 'Practice uses one-tap recording. Switch recording mode to Manual to practice here.',
				} satisfies Record<RecordingMode, string>
			)[selectedRecordingMode],
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
	{:else if canFinish && selectedRecordingMode === 'upload'}
		<Alert.Root>
			<MicIcon class="size-4" />
			<Alert.Title>Upload mode selected</Alert.Title>
			<Alert.Description>
				Practice uses the live microphone. You can finish setup now, or switch to
				Manual or Voice Activated to test live dictation.
			</Alert.Description>
		</Alert.Root>
	{:else if canFinish && selectedRecordingMode === 'vad'}
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
