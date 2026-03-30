<script lang="ts">
	import { terminalState } from '$lib/state/terminal-state.svelte';

	let value = $state('');
	let inputEl: HTMLInputElement | undefined = $state();

	async function handleSubmit() {
		const cmd = value;
		value = '';
		await terminalState.exec(cmd);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			handleSubmit();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			const prev = terminalState.previousCommand();
			if (prev !== undefined) value = prev;
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			const next = terminalState.nextCommand();
			value = next ?? '';
		}
	}

	/**
	 * Focus the input element. Called by TerminalPanel when the
	 * terminal opens via keyboard shortcut.
	 */
	export function focus() {
		inputEl?.focus();
	}
</script>

<div class="flex items-center border-t px-3 py-2">
	<span class="mr-2 text-green-500">$</span>
	<input
		bind:this={inputEl}
		bind:value
		onkeydown={handleKeydown}
		disabled={terminalState.running}
		placeholder={terminalState.running ? 'Running...' : 'Type a command...'}
		aria-label="Terminal command input"
		class="flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
		spellcheck="false"
		autocomplete="off"
	>
</div>
