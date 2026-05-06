<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Toaster } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { ModeWatcher } from 'mode-watcher';
	import { auth, opensidian } from '$lib/opensidian/client';
	import '../app.css';

	let { children } = $props();
</script>

<ConfirmationDialog />
<Toaster />
<ModeWatcher />

{#await opensidian.idb.whenLoaded}
	<div class="flex h-dvh items-center justify-center">
		<Spinner class="size-5 text-muted-foreground" />
	</div>
{:then}
	{@render children()}
{:catch error}
	<Empty.Root class="h-dvh">
		<Empty.Media>
			<TriangleAlertIcon class="size-8 text-muted-foreground" />
		</Empty.Media>
		<Empty.Title>Failed to load workspace</Empty.Title>
		<Empty.Description>
			{error instanceof Error
				? error.message
				: 'The workspace could not be opened.'}
		</Empty.Description>
		<div class="flex items-center gap-2">
			<Button variant="outline" onclick={() => window.location.reload()}>
				Reload
			</Button>
			<Button onclick={() => auth.signOut()}>Sign out</Button>
		</div>
	</Empty.Root>
{/await}
