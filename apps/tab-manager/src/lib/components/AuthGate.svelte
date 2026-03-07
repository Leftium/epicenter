<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { Spinner } from '@epicenter/ui/spinner';
	import { onMount, type Snippet } from 'svelte';
	import { authState } from '$lib/state/auth.svelte';
	import { reconnectSync } from '$lib/workspace';

	let { children }: { children: Snippet } = $props();

	onMount(() => {
		authState.checkSession();

		const onVisibilityChange = () => {
			if (document.visibilityState === 'visible' && authState.status === 'signed-in') {
				authState.checkSession();
			}
		};
		document.addEventListener('visibilitychange', onVisibilityChange);
		return () => document.removeEventListener('visibilitychange', onVisibilityChange);
	});

	$effect(() => {
		authState.reactToTokenCleared();
	});
</script>

{#if authState.status === 'checking'}
	<div class="flex h-full items-center justify-center gap-2">
		<Spinner class="size-4" />
		<p class="text-sm text-muted-foreground">Checking session…</p>
	</div>
{:else if authState.status === 'signed-out' || authState.status === 'signing-in'}
	<div class="flex h-full items-center justify-center p-6">
		<form
			onsubmit={async (e) => {
				e.preventDefault();
				const { error } = await authState.signIn();
				if (!error) reconnectSync();
			}}
			class="w-full max-w-xs"
		>
			<Field.Set>
				<Field.Legend>Sign in</Field.Legend>
				<Field.Description>Sign in to sync your tabs across devices.</Field.Description>
				<Field.Separator />

				{#if authState.signInError}
					<Alert.Root variant="destructive">
						<Alert.Description>{authState.signInError}</Alert.Description>
					</Alert.Root>
				{/if}

				<Field.Group>
					<Field.Field>
						<Field.Label for="email">Email</Field.Label>
						<Input id="email" type="email" placeholder="Email" bind:value={authState.email} required autocomplete="email" />
					</Field.Field>
					<Field.Field>
						<Field.Label for="password">Password</Field.Label>
						<Input id="password" type="password" placeholder="Password" bind:value={authState.password} required autocomplete="current-password" />
					</Field.Field>
				</Field.Group>

				<Button type="submit" class="w-full" disabled={authState.status === 'signing-in'}>
					{#if authState.status === 'signing-in'}
						<Spinner class="size-4" />
						Signing in…
					{:else}
						Sign in
					{/if}
				</Button>
			</Field.Set>
		</form>
	</div>
{:else}
	{@render children()}
	<div class="border-t px-3 py-2 flex items-center justify-end">
		<Button
			variant="ghost"
			size="sm"
			onclick={async () => {
				await authState.signOut();
				reconnectSync();
			}}
		>
			Sign out
		</Button>
	</div>
{/if}
