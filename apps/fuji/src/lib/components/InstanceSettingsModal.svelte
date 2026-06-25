<script lang="ts">
	import { normalizeInstanceUrl, probeInstance } from '@epicenter/auth';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import * as Modal from '@epicenter/ui/modal';
	import { Spinner } from '@epicenter/ui/spinner';
	import {
		clearInstance,
		isDefaultInstance,
		readInstance,
		writeInstance,
	} from '$lib/instance';

	let { open = $bindable(false) }: { open?: boolean } = $props();

	// Read once when the component mounts; saving reloads the app, so there is no
	// live value to track.
	const instance = readInstance();
	const hasOverride = !isDefaultInstance(instance);

	let urlInput = $state(hasOverride ? instance.baseURL : '');
	let tokenInput = $state(instance.token ?? '');

	type ProbeState =
		| { status: 'idle' }
		| { status: 'testing' }
		| { status: 'connected'; email: string }
		| { status: 'failed'; message: string };
	let probe = $state<ProbeState>({ status: 'idle' });

	async function testConnection() {
		const { data: baseURL, error } = normalizeInstanceUrl(urlInput);
		if (error) {
			probe = { status: 'failed', message: error.message };
			return;
		}
		probe = { status: 'testing' };
		const token = tokenInput.trim() || undefined;
		const { data, error: probeError } = await probeInstance({ baseURL, token });
		probe = probeError
			? { status: 'failed', message: probeError.message }
			: { status: 'connected', email: data.email };
	}

	function save() {
		const { data: baseURL, error } = normalizeInstanceUrl(urlInput);
		if (error) {
			probe = { status: 'failed', message: error.message };
			return;
		}
		writeInstance({ baseURL, token: tokenInput.trim() || undefined });
		location.reload();
	}

	function useHosted() {
		clearInstance();
		location.reload();
	}
</script>

<Modal.Root bind:open>
	<Modal.Content class="sm:max-w-md">
		<Modal.Header>
			<Modal.Title>Connect to a self-hosted instance</Modal.Title>
			<Modal.Description>
				Point Fuji at your own Epicenter star. Your data and token go only to
				this origin; the hosted cloud is never an endpoint.
			</Modal.Description>
		</Modal.Header>
		<div class="flex flex-col gap-4">
			<div class="space-y-1.5">
				<Label for="instance-url">Instance URL</Label>
				<Input
					id="instance-url"
					bind:value={urlInput}
					placeholder="http://localhost:8788"
					autocomplete="off"
					autocapitalize="off"
					spellcheck={false}
				/>
			</div>
			<div class="space-y-1.5">
				<Label for="instance-token">Instance token</Label>
				<Input
					id="instance-token"
					type="password"
					bind:value={tokenInput}
					placeholder="Paste the token your instance printed"
					autocomplete="off"
				/>
				<p class="text-xs text-muted-foreground">
					Leave blank to sign in with Epicenter OAuth against this origin
					instead.
				</p>
			</div>
			{#if probe.status === 'connected'}
				<p class="text-xs text-green-600 dark:text-green-500">
					Connected as {probe.email}.
				</p>
			{:else if probe.status === 'failed'}
				<p class="text-xs text-destructive">{probe.message}</p>
			{/if}
		</div>
		<Modal.Footer class="flex-col gap-2 sm:flex-row sm:justify-between">
			{#if hasOverride}
				<Button variant="ghost" type="button" onclick={useHosted}>
					Use hosted Epicenter
				</Button>
			{/if}
			<div class="flex gap-2 sm:ml-auto">
				<Button
					variant="outline"
					type="button"
					disabled={probe.status === 'testing'}
					onclick={testConnection}
				>
					{#if probe.status === 'testing'}
						<Spinner class="size-3.5" />
						<span>Testing</span>
					{:else}
						Test connection
					{/if}
				</Button>
				<Button type="button" onclick={save}>Save and reload</Button>
			</div>
		</Modal.Footer>
	</Modal.Content>
</Modal.Root>
