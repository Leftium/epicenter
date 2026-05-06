<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { auth } from '$lib/auth';

	let { error }: { error: unknown } = $props();

	const message = $derived(
		error instanceof Error
			? error.message
			: 'The workspace could not be opened.',
	);
</script>

<Empty.Root class="h-dvh">
	<Empty.Media>
		<TriangleAlertIcon class="size-8 text-muted-foreground" />
	</Empty.Media>
	<Empty.Title>Failed to load workspace</Empty.Title>
	<Empty.Description>{message}</Empty.Description>
	<div class="flex items-center gap-2">
		<Button variant="outline" onclick={() => window.location.reload()}>
			Reload
		</Button>
		<Button onclick={() => auth.signOut()}>Sign out</Button>
	</div>
</Empty.Root>
