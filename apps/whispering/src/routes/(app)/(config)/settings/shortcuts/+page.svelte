<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import { Separator } from '@epicenter/ui/separator';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import { tauri } from '#platform/tauri';
	import { report } from '$lib/report';
	import { shortcuts } from '$lib/platform/shortcuts';
	import KeyboardShortcutRecorder from './keyboard-shortcut-recorder/KeyboardShortcutRecorder.svelte';
	import ShortcutFormatHelp from './keyboard-shortcut-recorder/ShortcutFormatHelp.svelte';
	import ShortcutTable from './keyboard-shortcut-recorder/ShortcutTable.svelte';

	// One flat list, no platform branch (ADR-0041): every command gets one
	// router-driven recorder. The reach of the key the user presses, not a scope
	// tab, decides whether a binding lands in the synced focused store or the
	// per-device global store. Reset restores both stores to their defaults.
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
				Pick a key for any command and Whispering shows how far it reaches. A
				bare key works while Whispering is focused, a chord works everywhere, and
				a hold works everywhere once you grant Accessibility. Reach is computed
				from the key you press, never a setting you toggle. Focused shortcuts sync
				across your devices; global ones stay on this computer.
			</SectionHeader.Description>
		</SectionHeader.Root>
		<Button variant="outline" size="sm" onclick={reset} class="shrink-0">
			<RotateCcw class="size-4" />
			Reset shortcuts
		</Button>
	</div>

	<Separator class="my-6" />

	<ShortcutTable>
		{#snippet row(command)}
			<KeyboardShortcutRecorder {command} {shortcuts} {tauri} />
		{/snippet}
	</ShortcutTable>
</section>
