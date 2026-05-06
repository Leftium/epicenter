<!--
	Full-viewport spinner shell. Rendered while a workspace (or any
	app-scoped async resource) is still hydrating and there is nothing
	else to show.

	Used standalone in pre-auth layouts (replaces the per-app Loading.svelte)
	and as the default loading state of <WorkspaceGate>.
-->
<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { Spinner } from '@epicenter/ui/spinner';
</script>

<Empty.Root class="h-dvh flex-none border-0" aria-live="polite">
	<Empty.Media>
		<Spinner class="size-5 text-muted-foreground" />
	</Empty.Media>
</Empty.Root>
