<script lang="ts">
	import * as AlertDialog from '@epicenter/ui/alert-dialog';
	import type { LeaveGuard } from '$lib/leave.svelte.js';

	/**
	 * Shown when the desktop shell asks to close while something is held only
	 * in this window, or when Whispering's host has stopped and the shell can no
	 * longer ask through it. Dismissing it any way other than the quit button
	 * keeps the window open and everything in it.
	 *
	 * A stopped host does not stop saving: the folder is the shell's and stays
	 * open. The copy says what is actually unavailable, and promises nothing
	 * about a save, which can still fail for its own reasons.
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
				{guard.hostGone ? 'Part of Whispering has stopped. Quit?' : 'Quit and lose unsaved work?'}
			</AlertDialog.Title>
			<AlertDialog.Description>
				{#if guard.hostGone}
					The part of Whispering that runs the terminal and sends transcription and transformation
					requests has stopped, so those are unavailable until you restart, and Whispering could not
					check what is unsaved before closing. Your folder is still open: changes to recordings and
					transcripts can still be saved to it.
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
				Keep working lets you save what can still be saved, play a pending recording, or copy unsaved
				text out before you quit.
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
