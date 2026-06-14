<!-- Engine step: transcription runtime picker + readiness alert. -->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Link } from '@epicenter/ui/link';
	import CheckCircle2Icon from '@lucide/svelte/icons/check-circle-2';
	import AlertCircleIcon from '@lucide/svelte/icons/alert-circle';
	import TranscriptionRuntimeSetup from '$lib/components/settings/TranscriptionRuntimeSetup.svelte';
	import { getTranscriptionSetupReadiness } from '$lib/settings/transcription-validation';

	const runtime = $derived(getTranscriptionSetupReadiness());
</script>

<div class="space-y-4">
	<TranscriptionRuntimeSetup
		id="setup-transcription-service"
		label="Runtime"
		showAdvanced={false}
	/>

	{#if runtime.isReady}
		<Alert.Root>
			<CheckCircle2Icon class="size-4 text-green-500" />
			<Alert.Title>Transcription is configured</Alert.Title>
			<Alert.Description>
				{runtime.service?.label ?? 'Your runtime'} is ready on this device.
			</Alert.Description>
		</Alert.Root>
	{:else}
		<Alert.Root variant="warning">
			<AlertCircleIcon class="size-4" />
			<Alert.Title>Transcription needs setup</Alert.Title>
			<Alert.Description>
				{runtime.primaryIssue ??
					'Choose a runtime and fill in the required fields.'}
			</Alert.Description>
		</Alert.Root>
	{/if}

	<Link href="/settings/transcription" class="text-sm text-muted-foreground">
		Advanced transcription settings
	</Link>
</div>
