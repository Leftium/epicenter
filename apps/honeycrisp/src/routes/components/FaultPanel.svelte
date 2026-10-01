<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import type { FaultState, Faults } from '$lib/bridge/contract.js';
	import type { NotesHost } from '$lib/platform/types.js';

	let { faults }: { faults: NonNullable<NotesHost['faults']> } = $props();

	let current = $state.raw<FaultState>();

	async function apply(work: Promise<FaultState>) {
		try {
			current = await work;
		} catch (cause) {
			toast.error('Fault injection failed', {
				description: cause instanceof Error ? cause.message : String(cause),
			});
		}
	}
	const set = (next: Partial<Faults>) => apply(faults.set(next));

	// Read once when shown, then keep the held-save count current.
	$effect(() => {
		void apply(faults.get());
		const timer = setInterval(() => void apply(faults.get()), 1000);
		return () => clearInterval(timer);
	});
</script>

<!-- Shown only when the folder host was started with fault injection for a disposable folder. -->
<div class="space-y-2 border-t bg-warning/10 px-3 py-2 text-xs" data-testid="fault-panel">
	<p class="font-medium">Test faults (disposable folder)</p>
	{#if current}
		<p class="text-muted-foreground" data-testid="fault-state">
			Hold saves: {current.holdSaves ? 'on' : 'off'} · waiting: {current.held} · delay: {current.saveDelayMs} ms · failing
			saves: {current.failSaves} · failing commits: {current.failCommits}
		</p>
		<div class="flex flex-wrap gap-1">
			<Button size="xs" variant="outline" onclick={() => set({ holdSaves: !current?.holdSaves })}>
				{current.holdSaves ? 'Release held saves' : 'Hold saves'}
			</Button>
			<Button size="xs" variant="outline" onclick={() => set({ saveDelayMs: current?.saveDelayMs ? 0 : 5000 })}>
				{current.saveDelayMs ? 'Remove save delay' : 'Delay saves 5 s'}
			</Button>
			<Button size="xs" variant="outline" onclick={() => set({ failSaves: 1 })}>Fail next save</Button>
			<Button size="xs" variant="outline" onclick={() => set({ failCommits: 1 })}>Fail next commit</Button>
			<Button
				size="xs"
				variant="ghost"
				onclick={() => set({ holdSaves: false, saveDelayMs: 0, failSaves: 0, failCommits: 0 })}
			>
				Clear
			</Button>
		</div>
	{/if}
</div>
