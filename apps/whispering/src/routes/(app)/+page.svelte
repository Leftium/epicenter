<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import {
		ACCEPT_AUDIO,
		ACCEPT_VIDEO,
		FileDropZone,
		MEGABYTE,
	} from '@epicenter/ui/file-drop-zone';
	import * as Kbd from '@epicenter/ui/kbd';
	import { Link } from '@epicenter/ui/link';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import * as ToggleGroup from '@epicenter/ui/toggle-group';
	import XIcon from '@lucide/svelte/icons/x';
	import { createQuery } from '@tanstack/svelte-query';
	import type { UnlistenFn } from '@tauri-apps/api/event';
	import { onDestroy, onMount } from 'svelte';
	import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
	import { tryAsync } from 'wellcrafted/result';
	import { commandCallbacks } from '$lib/commands';
	import TranscriptDialog from '$lib/components/copyable/TranscriptDialog.svelte';
	import {
		TranscriptionSelector,
		TransformationSelector,
	} from '$lib/components/settings';
	import ManualDeviceSelector from '$lib/components/settings/selectors/ManualDeviceSelector.svelte';
	import VadDeviceSelector from '$lib/components/settings/selectors/VadDeviceSelector.svelte';
	import {
		RECORDING_TRIGGER_META,
		RECORDING_TRIGGER_OPTIONS,
		type RecordingTrigger,
	} from '$lib/constants/audio';
	import {
		IMPORTABLE_AUDIO_EXTENSIONS,
		IMPORTABLE_VIDEO_EXTENSIONS,
	} from '$lib/constants/import-formats';
	import { getShortcutDisplayLabel } from '$lib/utils/keyboard';
	import { keyBindingToLabel } from '$lib/utils/key-binding';
	import { os } from '#platform/os';
	import {
		stopManualRecording,
		stopVadRecording,
	} from '$lib/operations/recording';
	import { importFiles } from '$lib/operations/import';
	import { report } from '$lib/report';
	import { rpc } from '$lib/rpc';
	import { services } from '$lib/services';
	import { tauri } from '#platform/tauri';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { manualRecorder } from '$lib/state/manual-recorder.svelte';
	import { recordings } from '$lib/state/recordings.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { vadRecorder } from '$lib/state/vad-recorder.svelte';
	import { viewTransition } from '$lib/utils/viewTransitions';
	import CapturePipeline from './_components/CapturePipeline.svelte';
	import ManualRecordingAction from './_components/ManualRecordingAction.svelte';
	import VadRecordingAction from './_components/VadRecordingAction.svelte';

	const latestRecording = $derived(recordings.sorted[0]);

	// The global toggle-recording shortcut, formatted for the hint text. Stored
	// as a structured KeyBinding (desktop rdev backend), so format it directly.
	const globalToggleBinding = $derived(
		deviceConfig.get('shortcuts.global.toggleManualRecording'),
	);
	const globalToggleLabel = $derived(
		globalToggleBinding ? keyBindingToLabel(globalToggleBinding, os.isApple) : '',
	);
	const PageError = defineErrors({
		SetupDragDropFailed: ({ cause }: { cause: unknown }) => ({
			message: `Failed to set up drag drop listener: ${extractErrorMessage(cause)}`,
			cause,
		}),
		FileRejected: ({
			fileName,
			reason,
		}: {
			fileName: string;
			reason: string;
		}) => ({
			message: `${fileName}: ${reason}`,
			fileName,
			reason,
		}),
	});

	const audioPlaybackUrlQuery = createQuery(() => ({
		...rpc.audio.getPlaybackUrl(() => latestRecording?.id ?? '').options,
		enabled: !!latestRecording?.id,
	}));

	// Store unlisten function for drag drop events
	let unlistenDragDrop: UnlistenFn | undefined;

	// Set up desktop drag and drop listener
	onMount(async () => {
		if (!tauri) return;
		const { error } = await tryAsync({
			try: async () => {
				const { getCurrentWebview } = await import('@tauri-apps/api/webview');
				const { extname } = await import('@tauri-apps/api/path');

				const isAudio = async (path: string) =>
					IMPORTABLE_AUDIO_EXTENSIONS.includes(
						(await extname(path)) as (typeof IMPORTABLE_AUDIO_EXTENSIONS)[number],
					);
				const isVideo = async (path: string) =>
					IMPORTABLE_VIDEO_EXTENSIONS.includes(
						(await extname(path)) as (typeof IMPORTABLE_VIDEO_EXTENSIONS)[number],
					);

				unlistenDragDrop = await getCurrentWebview().onDragDropEvent(
					async (event) => {
						if (
							event.payload.type !== 'drop' ||
							event.payload.paths.length === 0
						)
							return;

						// Filter for audio/video files based on extension
						const pathResults = await Promise.all(
							event.payload.paths.map(async (path) => ({
								path,
								isValid: (await isAudio(path)) || (await isVideo(path)),
							})),
						);
						const validPaths = pathResults
							.filter(({ isValid }) => isValid)
							.map(({ path }) => path);

						if (validPaths.length === 0) {
							report.info({
								title: 'No valid files',
								description: 'Please drop audio or video files',
							});
							return;
						}

						// Convert file paths to File objects. The file-drop event only
						// fires on Tauri, so `tauri` is non-null in this branch.
						if (!tauri) return;
						const { data: files, error } =
							await tauri.fs.pathsToFiles(validPaths);

						if (error) {
							report.error({ cause: error, title: 'Failed to read files' });
							return;
						}

						if (files.length > 0) {
							await importFiles({ files });
						}
					},
				);
			},
			catch: (error) =>
				PageError.SetupDragDropFailed({
					cause: error,
				}),
		});
		if (error) report.error({ cause: error });
	});

	onDestroy(() => {
		unlistenDragDrop?.();
		// Clean up audio URL when component unmounts to prevent memory leaks
		if (latestRecording?.id) {
			services.blobs.audio.revokeUrl(latestRecording.id);
		}
	});

	async function stopActiveRecordingExcept(triggerToKeep: RecordingTrigger) {
		const triggers = [
			{
				trigger: 'manual' as const,
				isActive: () => manualRecorder.state === 'RECORDING',
				stop: () => stopManualRecording(),
			},
			{
				trigger: 'vad' as const,
				isActive: () => vadRecorder.state !== 'IDLE',
				stop: () => stopVadRecording(),
			},
		] satisfies {
			trigger: RecordingTrigger;
			isActive: () => boolean;
			stop: () => Promise<unknown>;
		}[];

		const toStop = triggers.filter(
			(t) => t.trigger !== triggerToKeep && t.isActive(),
		);

		await Promise.all(toStop.map((t) => t.stop()));
	}

	async function switchRecordingTrigger(newTrigger: RecordingTrigger) {
		await stopActiveRecordingExcept(newTrigger);

		if (settings.get('recording.trigger') !== newTrigger) {
			settings.set('recording.trigger', newTrigger);
			const label = RECORDING_TRIGGER_OPTIONS.find(
				(option) => option.value === newTrigger,
			)?.label;
			report.success({
				title: 'Recording trigger switched',
				description: `Now using ${label ?? newTrigger}.`,
			});
		}
	}
</script>

<svelte:head> <title>Whispering</title> </svelte:head>

<div
	class="flex flex-1 flex-col items-center justify-start gap-4 w-full max-w-lg mx-auto px-4 pt-6 pb-24 sm:justify-center sm:py-0"
>
	<SectionHeader.Root class="flex flex-col items-center gap-4">
		<SectionHeader.Title
			level={1}
			class="scroll-m-20 text-4xl tracking-tight lg:text-5xl"
		>
			Whispering
		</SectionHeader.Title>
		<SectionHeader.Description class="text-center">
			Press shortcut → speak → get text. Free and open source ❤️
		</SectionHeader.Description>
	</SectionHeader.Root>

	<ToggleGroup.Root
		type="single"
		bind:value={() => settings.get('recording.trigger'),
			(trigger) => {
				if (!trigger) return;
				void switchRecordingTrigger(trigger as RecordingTrigger);
			}}
		class="w-full"
	>
		{#each RECORDING_TRIGGER_OPTIONS as option}
			{@const TriggerIcon = RECORDING_TRIGGER_META[option.value].Icon}
			<ToggleGroup.Item
				value={option.value}
				aria-label="Switch to {option.label.toLowerCase()} recording"
			>
				<TriggerIcon class="size-4" />
				<span class="hidden truncate sm:inline">{option.label}</span>
			</ToggleGroup.Item>
		{/each}
	</ToggleGroup.Root>

	{#snippet manualPipeline()}
		<CapturePipeline>
			<ManualDeviceSelector />
			<TranscriptionSelector variant="pipeline" />
			<TransformationSelector />
		</CapturePipeline>
	{/snippet}

	{#snippet vadPipeline()}
		<CapturePipeline>
			<VadDeviceSelector />
			<TranscriptionSelector variant="pipeline" />
			<TransformationSelector />
		</CapturePipeline>
	{/snippet}

	{#if settings.get('recording.trigger') === 'manual'}
		<div class="flex w-full flex-col items-center gap-3">
			<ManualRecordingAction
				pipeline={manualPipeline}
			/>
			{#if manualRecorder.state === 'RECORDING'}
				<Button
					tooltip="Cancel recording and discard audio"
					onclick={() => commandCallbacks.cancelRecording()}
					variant="ghost-destructive"
					size="sm"
					style="view-transition-name: {viewTransition.global.cancel};"
				>
					<XIcon class="size-4" />
					Cancel
				</Button>
			{/if}
		</div>
	{:else if settings.get('recording.trigger') === 'vad'}
		<div class="flex w-full flex-col items-center gap-3">
			<VadRecordingAction
				pipeline={vadPipeline}
			/>
		</div>
	{/if}

	<!--
		File import is its own surface, not a recording trigger: it stays visible
		under the recorder regardless of trigger, and works on web (the picker)
		and desktop (picker plus drag-and-drop). Transcription and transformation
		are shared with the active recorder's pipeline above.
	-->
	<div class="flex w-full flex-col items-center gap-2">
		<span class="text-muted-foreground text-xs">or import a file</span>
		<FileDropZone
			accept="{ACCEPT_AUDIO}, {ACCEPT_VIDEO}"
			maxFiles={10}
			maxFileSize={25 * MEGABYTE}
			onUpload={async (files) => {
				if (files.length > 0) {
					await importFiles({ files });
				}
			}}
			onFileRejected={({ file, reason }) => {
				report.error({
					cause: PageError.FileRejected({
						fileName: file.name,
						reason,
					}).error,
					title: 'File rejected',
				});
			}}
			class="h-28 sm:h-32 w-full"
		/>
	</div>

	{#if latestRecording}
		<div class="flex w-full flex-col gap-2">
			<TranscriptDialog
				recordingId={latestRecording.id}
				transcript={latestRecording.transcript}
				rows={1}
				disabled={!latestRecording.transcript.trim()}
				onDelete={() => {
					confirmationDialog.open({
						title: 'Delete recording',
						description: 'Are you sure you want to delete this recording?',
						confirm: { text: 'Delete', variant: 'destructive' },
						onConfirm: () => {
							services.blobs.audio.revokeUrl(latestRecording.id);
							recordings.delete(latestRecording.id);
							report.success({
								title: 'Deleted recording!',
								description: 'Your recording has been deleted.',
							});
						},
					});
				}}
			/>

			{#if audioPlaybackUrlQuery.data}
				<audio
					style="view-transition-name: {viewTransition.recording(
						latestRecording.id,
					).audio}"
					src={audioPlaybackUrlQuery.data}
					controls
					class="h-8 w-full"
				></audio>
			{/if}
		</div>
	{/if}

	<div class="flex flex-col items-center gap-3">
		{#if settings.get('recording.trigger') === 'manual'}
			<p class="text-foreground/75 text-center text-sm">
				Click the microphone or press
				<Link
					tooltip="Go to local shortcut in settings"
					href="/settings/shortcuts"
				>
					<Kbd.Root
						>{getShortcutDisplayLabel(
							settings.get('shortcut.toggleManualRecording'),
						)}</Kbd.Root
					>
				</Link>
				to start recording here.
			</p>
			{#if tauri}
				<p class="text-foreground/75 text-sm">
					Press
					<Link
						tooltip="Go to global shortcut in settings"
						href="/settings/shortcuts"
					>
						<Kbd.Root>{globalToggleLabel}</Kbd.Root>
					</Link>
					to start recording anywhere.
				</p>
			{/if}
		{:else if settings.get('recording.trigger') === 'vad'}
			<p class="text-foreground/75 text-center text-sm">
				Click the microphone or press
				<Link
					tooltip="Go to local shortcut in settings"
					href="/settings/shortcuts"
				>
					<Kbd.Root
						>{getShortcutDisplayLabel(
							settings.get('shortcut.toggleVadRecording'),
						)}</Kbd.Root
					>
				</Link>
				to start a voice activated session.
			</p>
		{/if}
		<p class="text-muted-foreground text-center text-sm font-light">
			{#if !tauri}
				Tired of switching tabs?
				<Link
					tooltip="Get Whispering for desktop"
					href="https://epicenter.so/whispering"
					target="_blank"
					rel="noopener noreferrer"
				>
					Get the native desktop app
				</Link>
			{/if}
		</p>
	</div>
</div>
