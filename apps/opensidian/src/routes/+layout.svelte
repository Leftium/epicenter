<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import '../app.css';

	let { children } = $props();
</script>

<ConfirmationDialog />
<Toaster />
<ModeWatcher defaultMode="dark" track={false} />

<Tooltip.Provider>
	{@render children()}
</Tooltip.Provider>
