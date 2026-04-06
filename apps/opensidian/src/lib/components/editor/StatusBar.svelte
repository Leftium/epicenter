<script lang="ts">
	import { buttonVariants } from '@epicenter/ui/button';
	import { Label } from '@epicenter/ui/label';
	import { LightSwitch } from '@epicenter/ui/light-switch';
	import * as Popover from '@epicenter/ui/popover';
	import { Switch } from '@epicenter/ui/switch';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import { editorState } from '$lib/state/editor-state.svelte';

	let popoverOpen = $state(false);
</script>

<div
	class="flex h-6 shrink-0 items-center gap-3 border-t bg-background px-3 text-xs text-muted-foreground"
>
	<span>Ln {editorState.cursorLine}, Col {editorState.cursorCol}</span>

	{#if editorState.selectionLength > 0}
		<span>{editorState.selectionLength} selected</span>
	{/if}

	<span>{editorState.wordCount} words</span>
	<span>{editorState.lineCount} lines</span>

	<div class="ml-auto flex items-center gap-1.5">
		{#if editorState.vimEnabled}
			<span class="font-mono text-[10px] font-medium uppercase tracking-wider"
				>vim</span
			>
		{/if}

		<Popover.Root bind:open={popoverOpen}>
			<Popover.Trigger
				class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
			>
				<SettingsIcon class="size-3.5" />
			</Popover.Trigger>
			<Popover.Content class="w-56 space-y-3" align="end" side="top">
				<div class="flex items-center justify-between">
					<Label for="vim-mode" class="text-sm">Vim mode</Label>
					<Switch
						id="vim-mode"
						checked={editorState.vimEnabled}
						onCheckedChange={() => editorState.toggleVim()}
					/>
				</div>
				<div class="flex items-center justify-between">
					<span class="text-sm">Theme</span>
					<LightSwitch variant="ghost" />
				</div>
			</Popover.Content>
		</Popover.Root>
	</div>
</div>
