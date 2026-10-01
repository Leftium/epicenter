<script lang="ts">
	import * as AlertDialog from '@epicenter/ui/alert-dialog';
	import type { LeaveGuard } from '$lib/leave.svelte.js';

	/**
	 * Shown when the desktop shell asks to close while something is held only
	 * in this window, or when the folder host has stopped and closing can no
	 * longer be checked. Dismissing it any way other than the quit button keeps
	 * the window open and everything in it.
	 */
	let { guard }: { guard: LeaveGuard } = $props();
</script>

<AlertDialog.Root
	open={guard.asking}
	onOpenChange={(open) => {
		if (!open) void guard.stay();
	}}
>
	<AlertDialog.Content data-testid="leave-prompt" data-host-gone={guard.hostGone}>
		<AlertDialog.Header>
			<AlertDialog.Title>
				{guard.hostGone ? 'Whispering can no longer save. Quit anyway?' : 'Quit and lose unsaved work?'}
			</AlertDialog.Title>
			<AlertDialog.Description>
				{#if guard.hostGone}
					The part of Whispering that reads and writes your folder has stopped, so nothing more can be
					saved in this session. Files already in the folder are safe.
					{#if guard.held.length > 0}
						This is only in this window and will be lost when you quit:
					{:else}
						Nothing unsaved is held in this window.
					{/if}
				{:else if guard.held.length > 0}
					This is only in this window. Quitting now discards it:
				{:else}
					Everything is saved now. You can quit.
				{/if}
			</AlertDialog.Description>
		</AlertDialog.Header>
		{#if guard.held.length > 0}
			<ul class="list-disc space-y-1 ps-5 text-sm" data-testid="leave-held">
				{#each guard.held as item (item)}
					<li>{item}</li>
				{/each}
			</ul>
		{/if}
		{#if guard.hostGone && guard.held.length > 0}
			<p class="text-sm text-muted-foreground">
				Keep working lets you play a pending recording or copy unsaved text out before you quit.
			</p>
		{/if}
		<AlertDialog.Footer>
			<AlertDialog.Cancel data-testid="leave-stay">Keep working</AlertDialog.Cancel>
			<AlertDialog.Action
				class={guard.held.length > 0 ? 'bg-destructive text-white hover:bg-destructive/90' : ''}
				onclick={() => void guard.discardAndQuit()}
				data-testid="leave-quit"
			>
				{guard.held.length > 0 ? 'Discard and quit' : 'Quit'}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
