<script lang="ts">
	import { Toggle } from '@epicenter/ui/toggle';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { editorState } from '$lib/state/editor-state.svelte';
</script>

<Tooltip.Provider>
	<div
		class="flex h-6 shrink-0 items-center gap-3 border-t bg-background px-3 text-xs text-muted-foreground"
	>
		<span> Ln {editorState.cursorLine}, Col {editorState.cursorCol} </span>

		{#if editorState.selectionLength > 0}
			<span>{editorState.selectionLength} selected</span>
		{/if}

		<span>{editorState.wordCount} words</span>
		<span>{editorState.lineCount} lines</span>

		<div class="ml-auto">
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Toggle
							{...props}
							size="sm"
							class="h-5 px-1.5 text-xs"
							pressed={editorState.vimEnabled}
							onPressedChange={() => editorState.toggleVim()}
						>
							VIM
						</Toggle>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content>Toggle Vim keybindings</Tooltip.Content>
			</Tooltip.Root>
		</div>
	</div>
</Tooltip.Provider>
