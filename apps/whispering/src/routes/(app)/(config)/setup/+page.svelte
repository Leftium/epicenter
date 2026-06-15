<!--
	First-run setup. The one hard precondition with no fallback is a transcription
	runtime: without a model or API key, audio cannot become text, so the AppLayout
	gate routes here until one is configured and stops the moment it is. macOS
	Accessibility is presented here too (the notice below), because the global
	shortcut is the headline way to dictate, but it never blocks finishing: it is a
	revocable OS grant with a clipboard fallback, surfaced as a reactive notice
	rather than a wall. The microphone prompts at first record. So setup is one
	screen, not a wizard.
-->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { Link } from '@epicenter/ui/link';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import AlertCircleIcon from '@lucide/svelte/icons/alert-circle';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import CheckCircle2Icon from '@lucide/svelte/icons/check-circle-2';
	import { goto } from '$app/navigation';
	import MacosAccessibilityNotice from '$lib/components/MacosAccessibilityNotice.svelte';
	import TranscriptionRuntimeSetup from '$lib/components/settings/TranscriptionRuntimeSetup.svelte';
	import { getTranscriptionSetupReadiness } from '$lib/settings/transcription-validation';
	import { os } from '#platform/os';
	import { tauri } from '#platform/tauri';
	import { report } from '$lib/report';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { keyBindingToLabel } from '$lib/utils/key-binding';

	const runtime = $derived(getTranscriptionSetupReadiness());

	// Desktop dictation is triggered by the global toggle shortcut, bound by
	// default. Surface it on the way out so the first thing a finished user
	// learns is how to start dictating without coming back to the window.
	const globalToggleBinding = $derived(
		deviceConfig.get('shortcuts.global.toggleManualRecording'),
	);
	const globalToggleLabel = $derived(
		globalToggleBinding ? keyBindingToLabel(globalToggleBinding, os.isApple) : '',
	);

	function finish() {
		report.success({
			title: "You're all set",
			description:
				tauri && globalToggleLabel
					? `Press ${globalToggleLabel} anywhere to dictate.`
					: 'Whispering is ready on this device.',
		});
		void goto('/');
	}
</script>

<svelte:head> <title>Setup - Whispering</title> </svelte:head>

<main class="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-8 sm:px-8">
	<SectionHeader.Root class="space-y-1">
		<SectionHeader.Title level={1} class="text-3xl tracking-tight">
			Set up Whispering
		</SectionHeader.Title>
		<SectionHeader.Description>
			Choose how Whispering turns your voice into text. It is the only thing you
			need before your first dictation.
		</SectionHeader.Description>
	</SectionHeader.Root>

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

	<!-- Presented, never required: only renders on macOS with the grant off, and
	does not gate the finish button. The runtime above is the one hard wall. -->
	<MacosAccessibilityNotice />

	<div class="flex justify-end">
		<Button disabled={!runtime.isReady} onclick={finish}>
			Start using Whispering
			<ArrowRightIcon class="size-4" />
		</Button>
	</div>
</main>
