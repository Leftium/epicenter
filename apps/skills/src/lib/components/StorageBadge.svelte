<script lang="ts">
	import { Database } from '@lucide/svelte';
	import { skillsState } from '$lib/state/skills-state.svelte';

	let storageBytes = $state<number | null>(null);

	const skillCount = $derived(skillsState.skills.length);

	$effect(() => {
		// Re-estimate whenever skill count changes (triggers IndexedDB writes)
		void skillCount;
		estimateStorage();
	});

	async function estimateStorage() {
		if (!navigator.storage?.estimate) return;
		const { usage } = await navigator.storage.estimate();
		storageBytes = usage ?? null;
	}

	function formatBytes(bytes: number): string {
		if (bytes === 0) return '0 B';
		const k = 1024;
		const units = ['B', 'KB', 'MB', 'GB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return `${parseFloat((bytes / k ** i).toFixed(1))} ${units[i]}`;
	}
</script>

<div class="flex items-center gap-1.5 border-t px-3 py-1.5 text-xs text-muted-foreground">
	<Database class="size-3 shrink-0" />
	<span>
		{skillCount}
		{skillCount === 1 ? 'skill' : 'skills'}
		{#if storageBytes !== null}
			<span class="text-muted-foreground/60">·</span>
			{formatBytes(storageBytes)}
		{/if}
	</span>
</div>
