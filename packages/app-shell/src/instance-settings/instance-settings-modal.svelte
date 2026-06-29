<script lang="ts">
	import { type InstanceSetting, normalizeInstanceUrl } from '@epicenter/auth';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import * as Modal from '@epicenter/ui/modal';
	import { untrack } from 'svelte';

	let {
		open = $bindable(false),
		appName,
		setting,
	}: {
		open?: boolean;
		/** The app's display name, woven into the description. */
		appName: string;
		/** The shared instance setting handle this app injected. */
		setting: InstanceSetting;
	} = $props();

	// Seed the form from the snapshot once; saving reloads so auth construction
	// re-reads the new instance, so there is no live value to track. `hasOverride`
	// only gates the "Use hosted" button, so it stays a derived read of the stable
	// handle.
	let urlInput = $state(
		untrack(() => (setting.isDefault() ? '' : setting.read().baseURL)),
	);
	let tokenInput = $state(untrack(() => setting.read().token ?? ''));
	let error = $state<string | null>(null);
	const hasOverride = $derived(!setting.isDefault());

	// No pre-save connection test: the post-save reload's signed-out gate reports
	// connected-or-failed from the auth client's own boot check, so one surface
	// verifies the credential, not two.
	async function save() {
		const { data: baseURL, error: urlError } = normalizeInstanceUrl(urlInput);
		if (urlError) {
			error = urlError.message;
			return;
		}
		// ADR-0071: OAuth is hosted-only, so a self-hosted instance must carry the
		// token its box minted. There is no "leave blank to OAuth against this
		// origin" path.
		const token = tokenInput.trim();
		if (!token) {
			error = 'Paste the token your instance printed on first boot.';
			return;
		}
		await setting.write({ baseURL, token });
		location.reload();
	}

	async function useHosted() {
		await setting.clear();
		location.reload();
	}
</script>

<Modal.Root bind:open>
	<Modal.Content class="sm:max-w-md">
		<Modal.Header>
			<Modal.Title>Connect to a self-hosted instance</Modal.Title>
			<Modal.Description>
				Point {appName} at your own Epicenter star. Your data and token go only
				to this origin; the hosted cloud is never an endpoint.
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
					Your instance prints this token on first boot. Hosted Epicenter signs
					in with OAuth instead, with no token.
				</p>
			</div>
			{#if error}
				<p class="text-xs text-destructive">{error}</p>
			{/if}
		</div>
		<Modal.Footer class="flex-col gap-2 sm:flex-row sm:justify-between">
			{#if hasOverride}
				<Button variant="ghost" type="button" onclick={useHosted}>
					Use hosted Epicenter
				</Button>
			{/if}
			<Button class="sm:ml-auto" type="button" onclick={save}>
				Save and reload
			</Button>
		</Modal.Footer>
	</Modal.Content>
</Modal.Root>
