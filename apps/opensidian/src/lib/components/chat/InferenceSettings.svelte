<script lang="ts">
	import { buttonVariants } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import * as Popover from '@epicenter/ui/popover';
	import * as Select from '@epicenter/ui/select';
	import ServerIcon from '@lucide/svelte/icons/server';
	import { requireOpensidian } from '$lib/session';
	import { inferenceBackend } from '$lib/state/inference-backend.svelte';

	const opensidian = requireOpensidian();
	// Locked mid-turn so a backend switch never lands inside a running tool loop.
	const locked = $derived(opensidian.state.chat.isLoading);
	const config = $derived(inferenceBackend.current);

	function setMode(mode: string) {
		if (mode === 'hosted') {
			inferenceBackend.current = { mode: 'hosted' };
		} else if (mode === 'custom' && config.mode !== 'custom') {
			inferenceBackend.current = {
				mode: 'custom',
				baseUrl: 'http://localhost:11434/v1',
				model: '',
			};
		}
	}

	function patchCustom(
		patch: Partial<{ baseUrl: string; model: string; apiKey: string }>,
	) {
		if (config.mode !== 'custom') return;
		inferenceBackend.current = { ...config, ...patch };
	}
</script>

<Popover.Root>
	<Popover.Trigger
		class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
		title="Inference backend"
		disabled={locked}
	>
		<ServerIcon class="size-4" />
	</Popover.Trigger>
	<Popover.Content class="w-80" align="end">
		<div class="space-y-3">
			<p class="text-sm font-medium">Inference backend</p>
			<Select.Root
				type="single"
				value={config.mode}
				onValueChange={(v) => {
					if (v) setMode(v);
				}}
			>
				<Select.Trigger size="sm" class="w-full">
					<span class="truncate">
						{config.mode === 'custom' ? 'Custom' : 'Epicenter (metered)'}
					</span>
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="hosted" label="Epicenter (metered)">
						Epicenter (metered)
					</Select.Item>
					<Select.Item value="custom" label="Custom">
						Custom (Ollama, your own gateway)
					</Select.Item>
				</Select.Content>
			</Select.Root>

			{#if config.mode === 'custom'}
				<div class="space-y-1">
					<Label for="inf-url" class="text-xs">Base URL</Label>
					<Input
						id="inf-url"
						value={config.baseUrl}
						placeholder="http://localhost:11434/v1"
						oninput={(e) => patchCustom({ baseUrl: e.currentTarget.value })}
					/>
				</div>
				<div class="space-y-1">
					<Label for="inf-model" class="text-xs">Model</Label>
					<Input
						id="inf-model"
						value={config.model}
						placeholder="qwen2.5:3b"
						oninput={(e) => patchCustom({ model: e.currentTarget.value })}
					/>
				</div>
				<div class="space-y-1">
					<Label for="inf-key" class="text-xs">
						API key (leave blank for local)
					</Label>
					<Input
						id="inf-key"
						type="password"
						value={config.apiKey ?? ''}
						placeholder="sk-..."
						oninput={(e) => patchCustom({ apiKey: e.currentTarget.value })}
					/>
				</div>
				<p class="text-xs text-muted-foreground">
					Requests go straight to this URL. Your Epicenter sign-in is never sent
					there.
				</p>
			{/if}
		</div>
	</Popover.Content>
</Popover.Root>
