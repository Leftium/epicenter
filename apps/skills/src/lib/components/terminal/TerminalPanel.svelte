<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { ScrollArea } from '@epicenter/ui/scroll-area';
	import { Separator } from '@epicenter/ui/separator';
	import XIcon from '@lucide/svelte/icons/x';
	import { terminalState } from '$lib/state/terminal-state.svelte';
	import TerminalInput from './TerminalInput.svelte';
	import TerminalOutput from './TerminalOutput.svelte';

	let inputRef: ReturnType<typeof TerminalInput> | undefined = $state();
	let scrollEl: HTMLDivElement | undefined = $state();

	/**
	 * Focus the input element. Called from AppShell when the
	 * terminal opens via keyboard shortcut.
	 */
	export function focus() {
		inputRef?.focus();
	}

	// Auto-scroll to bottom when new entries appear.
	$effect(() => {
		void terminalState.history.length;
		if (scrollEl) {
			requestAnimationFrame(() => {
				scrollEl?.scrollTo({ top: scrollEl.scrollHeight });
			});
		}
	});
</script>

<div class="flex h-full flex-col border-t bg-background font-mono text-sm">
	<div class="flex items-center justify-between px-3 py-1">
		<span class="text-xs font-medium text-muted-foreground">Terminal</span>
		<Button
			variant="ghost"
			size="icon-xs"
			aria-label="Close terminal"
			onclick={() => terminalState.hide()}
		>
			<XIcon aria-hidden="true" class="size-3" />
		</Button>
	</div>
	<Separator />
	<ScrollArea class="flex-1">
		<div bind:this={scrollEl} class="space-y-1 p-3">
			{#each terminalState.history as entry}
				<TerminalOutput {entry} />
			{/each}
		</div>
	</ScrollArea>
	<TerminalInput bind:this={inputRef} />
</div>
