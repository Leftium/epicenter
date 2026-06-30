<script lang="ts">
	import * as Tooltip from '@epicenter/ui/tooltip';
	import MonitorSmartphoneIcon from '@lucide/svelte/icons/monitor-smartphone';
	import { requireOpensidian } from '$lib/session';

	const opensidian = requireOpensidian();
	const crossDevice = opensidian.state.crossDevice;

	const short = (nodeId: string) => nodeId.slice(0, 8);
</script>

<Tooltip.Provider>
	<Tooltip.Root>
		<Tooltip.Trigger
			class="flex items-center gap-1 rounded px-1.5 text-muted-foreground"
		>
			<MonitorSmartphoneIcon class="size-3.5" />
			{#if crossDevice.sourceCount > 0}
				<span class="text-xs tabular-nums">{crossDevice.sourceCount}</span>
			{/if}
		</Tooltip.Trigger>
		<Tooltip.Content side="bottom" align="end" class="max-w-64">
			{#if crossDevice.sourceCount === 0}
				<p class="text-xs">
					No cross-device tools. Expose a route on another of your devices
					(<code>--relay-expose books</code>) and it appears here automatically.
				</p>
			{:else}
				<p class="mb-1 text-xs font-medium">Cross-device tools</p>
				<ul class="space-y-0.5">
					{#each crossDevice.sources as source (source.nodeId + source.route)}
						<li class="font-mono text-xs">
							{source.route} on {short(source.nodeId)}
						</li>
					{/each}
				</ul>
			{/if}
		</Tooltip.Content>
	</Tooltip.Root>
</Tooltip.Provider>
