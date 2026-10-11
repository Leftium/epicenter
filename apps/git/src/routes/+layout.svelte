<script lang="ts">
 import '@epicenter/ui/app.css';
 import * as Tooltip from '@epicenter/ui/tooltip';
 import { ModeWatcher } from 'mode-watcher';
 let props = $props();
</script>
<Tooltip.Provider>{@render props.children?.()}</Tooltip.Provider>
<ModeWatcher defaultMode="dark" track={false} />
