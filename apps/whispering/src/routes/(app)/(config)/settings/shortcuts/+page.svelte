<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import { Separator } from '@epicenter/ui/separator';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import { report } from '$lib/report';
	import { tauri } from '#platform/tauri';
	import {
		resetGlobalShortcuts,
		resetLocalShortcuts,
	} from '$routes/(app)/_layout-utils/register-commands';
	import ShortcutFormatHelp from './keyboard-shortcut-recorder/ShortcutFormatHelp.svelte';
	import ShortcutTable from './keyboard-shortcut-recorder/ShortcutTable.svelte';

	// One shortcut system per platform: the desktop app uses global (system-wide,
	// rdev) shortcuts; the browser uses in-app (focused-tab) shortcuts. They never
	// coexist, so this page shows whichever one this platform has.
	function reset() {
		if (tauri) resetGlobalShortcuts();
		else resetLocalShortcuts();
		report.success({
			title: 'Shortcuts reset',
			description: 'All shortcuts have been reset to defaults.',
		});
	}
</script>

<svelte:head> <title>Keyboard Shortcuts - Whispering</title> </svelte:head>

<section>
	<div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
		<SectionHeader.Root>
			<div class="flex items-center gap-2">
				<SectionHeader.Title level={2} class="text-xl tracking-tight sm:text-2xl">
					{tauri ? 'Global Shortcuts' : 'In-App Shortcuts'}
				</SectionHeader.Title>
				<ShortcutFormatHelp type={tauri ? 'global' : 'local'} />
			</div>
			<SectionHeader.Description>
				{#if tauri}
					System-wide shortcuts that trigger from anywhere, even when Whispering
					is not focused. The Fn key, modifier-only holds, and single keys all
					work.
				{:else}
					Shortcuts that trigger while the Whispering tab is focused.
				{/if}
			</SectionHeader.Description>
		</SectionHeader.Root>
		<Button variant="outline" size="sm" onclick={reset} class="shrink-0">
			<RotateCcw class="size-4" />
			Reset to defaults
		</Button>
	</div>

	<Separator class="my-6" />

	{#if tauri}
		<ShortcutTable type="global" {tauri} />
	{:else}
		<ShortcutTable type="local" />
	{/if}
</section>
