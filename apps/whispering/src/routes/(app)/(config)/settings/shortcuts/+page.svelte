<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import { Separator } from '@epicenter/ui/separator';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import { report } from '$lib/report';
	import { systemShortcuts } from '#platform/system-shortcuts';
	import { tauri } from '#platform/tauri';
	import { focusedShortcuts } from '$lib/platform/focused-shortcuts';
	import { shortcuts } from '$lib/platform/shortcuts';
	import GlobalKeyboardShortcutRecorder from './keyboard-shortcut-recorder/GlobalKeyboardShortcutRecorder.svelte';
	import LocalKeyboardShortcutRecorder from './keyboard-shortcut-recorder/LocalKeyboardShortcutRecorder.svelte';
	import ShortcutFormatHelp from './keyboard-shortcut-recorder/ShortcutFormatHelp.svelte';
	import ShortcutTable from './keyboard-shortcut-recorder/ShortcutTable.svelte';

	// Desktop now runs both shortcut backends (the reach router syncs the focused
	// in-app matcher and the system rdev tier together), but this page still edits
	// one store per platform: the system (global) store on desktop, the focused
	// store on web. The flat list that shows both stores with a live reach badge is
	// a later phase; for now each recorder owns its own physical-key capture
	// (createChordRecorder), so the page hands in no capture state. Reset goes
	// through the router, so it restores both stores to their defaults.

	function reset() {
		shortcuts.reset();
		report.success({
			title: 'Shortcuts reset',
			description: 'All shortcuts have been reset to defaults.',
		});
	}
</script>

<svelte:head> <title>Keyboard Shortcuts - Whispering</title> </svelte:head>

<section class="mx-auto max-w-4xl py-6">
	<div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
		<SectionHeader.Root>
			<div class="flex items-center gap-2">
				<SectionHeader.Title level={1} class="text-3xl">
					Keyboard Shortcuts
				</SectionHeader.Title>
				<ShortcutFormatHelp type={tauri ? 'global' : 'local'} />
			</div>
			<SectionHeader.Description class="mt-2">
				{#if tauri}
					System-wide gestures that fire from anywhere, even when Whispering is
					not focused. Hold your recording key to talk, then release to stop.
					Each gesture needs its own keys, so the recording key cannot be part
					of another shortcut. These are set per computer, so they stay on this
					device.
				{:else}
					Shortcuts that trigger while the Whispering tab is focused. They sync
					across your devices.
				{/if}
			</SectionHeader.Description>
		</SectionHeader.Root>
		<Button variant="outline" size="sm" onclick={reset} class="shrink-0">
			<RotateCcw class="size-4" />
			Reset shortcuts
		</Button>
	</div>

	<Separator class="my-6" />

	{#if tauri && systemShortcuts}
		{@const t = tauri}
		{@const sys = systemShortcuts}
		<ShortcutTable>
			{#snippet row(command)}
				{@const def = sys.defaultLabel(command.id)}
				<GlobalKeyboardShortcutRecorder
					{command}
					shortcuts={sys}
					placeholder={def ? `Default: ${def}` : 'Set shortcut'}
					tauri={t}
				/>
			{/snippet}
		</ShortcutTable>
	{:else}
		<ShortcutTable>
			{#snippet row(command)}
				{@const def = focusedShortcuts.defaultLabel(command.id)}
				<LocalKeyboardShortcutRecorder
					{command}
					shortcuts={focusedShortcuts}
					placeholder={def ? `Default: ${def}` : 'Set shortcut'}
				/>
			{/snippet}
		</ShortcutTable>
	{/if}
</section>
