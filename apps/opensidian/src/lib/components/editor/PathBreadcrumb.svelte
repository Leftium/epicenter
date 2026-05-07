<script lang="ts">
	import * as Breadcrumb from '@epicenter/ui/breadcrumb';

	import { getSignedInSession } from '$lib/session.svelte';

	const signedIn = getSignedInSession();
	const pathSegments = $derived.by(() => {
		const path = signedIn.state.files.selectedPath;
		if (!path) return [];
		return path.split('/').filter(Boolean);
	});
</script>

{#if pathSegments.length > 0}
	<Breadcrumb.Root>
		<Breadcrumb.List>
			<Breadcrumb.Item> <Breadcrumb.Link>/</Breadcrumb.Link> </Breadcrumb.Item>
			{#each pathSegments as segment, i (i)}
				<Breadcrumb.Separator />
				<Breadcrumb.Item>
					{#if i === pathSegments.length - 1}
						<Breadcrumb.Page>{segment}</Breadcrumb.Page>
					{:else}
						<Breadcrumb.Link>{segment}</Breadcrumb.Link>
					{/if}
				</Breadcrumb.Item>
			{/each}
		</Breadcrumb.List>
	</Breadcrumb.Root>
{/if}
