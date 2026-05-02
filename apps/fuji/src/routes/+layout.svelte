<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import {
		CommandPalette,
		type CommandPaletteItem,
	} from '@epicenter/ui/command-palette';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Kbd } from '@epicenter/ui/kbd';
	import * as Resizable from '@epicenter/ui/resizable';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import { ModeWatcher } from 'mode-watcher';
	import { WorkspaceGate } from '@epicenter/svelte/workspace-gate';
	import { fuji } from '$lib/fuji/client';
	import AppHeader from '$lib/components/AppHeader.svelte';
	import EntriesSidebar from '$lib/components/EntriesSidebar.svelte';
	import { entriesState } from '$lib/entries-state.svelte';
	import '@epicenter/ui/app.css';

	let { children } = $props();

	// ─── Tab-close safety net ────────────────────────────────────────────────────

	/**
	 * Force-fire onblur on the currently-focused element when the page is
	 * being hidden. This catches the "user typed in a field, hits Cmd+W"
	 * case. `.blur()` synchronously dispatches the blur event, so any
	 * commit-on-blur handler runs and updates the Y.Doc before the page is
	 * destroyed. See docs/articles/commit-on-blur-survives-tab-close.md.
	 */
	function flushPendingEdits() {
		if (
			document.visibilityState === 'hidden' &&
			document.activeElement instanceof HTMLElement
		) {
			document.activeElement.blur();
		}
	}

	// ─── Command Palette ─────────────────────────────────────────────────────────

	let paletteOpen = $state(false);
	let paletteQuery = $state('');

	const paletteItems = $derived.by((): CommandPaletteItem[] => {
		if (!paletteOpen) return [];
		return entriesState.active.map((entry) => ({
			id: entry.id,
			label: entry.title || 'Untitled',
			description: entry.subtitle || undefined,
			icon: FileTextIcon,
			keywords: [...entry.tags, ...entry.type],
			group: entry.type.length > 0 ? entry.type[0] : 'Uncategorized',
			onSelect: () => goto(`/entries/${entry.id}`),
		}));
	});
</script>

<svelte:head><title>Fuji</title></svelte:head>

<!--
	Tab-close safety net: when the page is being hidden (Cmd+W, tab switch,
	window minimize, mobile app-switch, bfcache), force-blur the focused
	element. Any input wired to commit on `onblur` (e.g., the title /
	subtitle inputs in EntryEditor) gets its handler fired synchronously,
	updating the Y.Doc before the page is torn down. y-indexeddb +
	BroadcastChannel observers fire after; their async work usually
	completes within the browser's grace period.

	visibilitychange is a document event, pagehide is a window event
	(per Svelte's elements.d.ts). Listening to both gives cross-browser
	coverage. visibilitychange is more reliable on iOS Safari, pagehide
	catches bfcache navigations.
-->
<svelte:document onvisibilitychange={flushPendingEdits} />

<svelte:window
	onpagehide={flushPendingEdits}
	onkeydown={(event) => {
		const isInputFocused =
			event.target instanceof HTMLInputElement ||
			event.target instanceof HTMLTextAreaElement ||
			(event.target instanceof HTMLElement && event.target.isContentEditable);

		if (event.key === 'k' && event.metaKey) {
			event.preventDefault();
			paletteOpen = !paletteOpen;
			return;
		}

		if (event.key === 'n' && event.metaKey) {
			event.preventDefault();
			entriesState.createEntry();
			return;
		}

		if (event.key === 'Escape' && !isInputFocused && page.url.pathname !== '/') {
			event.preventDefault();
			goto('/');
		}
	}}
/>

<WorkspaceGate whenReady={fuji.whenLoaded}>
	<Tooltip.Provider>
		<div class="flex h-screen flex-col">
			<AppHeader onOpenSearch={() => (paletteOpen = true)} />
			<Resizable.PaneGroup direction="horizontal" class="flex-1">
				<Resizable.Pane defaultSize={20} minSize={15} maxSize={40}>
					<EntriesSidebar />
				</Resizable.Pane>
				<Resizable.Handle withHandle />
				<Resizable.Pane defaultSize={80}> {@render children()} </Resizable.Pane>
			</Resizable.PaneGroup>
			<div
				class="flex h-7 shrink-0 items-center gap-3 border-t bg-background px-3 text-xs text-muted-foreground"
			>
				<span
					>{entriesState.active.length}
					{entriesState.active.length === 1 ? 'entry' : 'entries'}</span
				>
				<div class="ml-auto flex items-center gap-1.5">
					<span class="flex items-center gap-1"> Search <Kbd>⌘K</Kbd> </span>
				</div>
			</div>
		</div>
	</Tooltip.Provider>
</WorkspaceGate>

<CommandPalette
	items={paletteItems}
	bind:open={paletteOpen}
	bind:value={paletteQuery}
	placeholder="Search entries…"
	emptyMessage="No entries found."
	title="Search Entries"
	description="Search entries by title, subtitle, tags, or type"
/>

<Toaster offset={16} closeButton />
<ConfirmationDialog />
<ModeWatcher defaultMode="dark" track={false} />
