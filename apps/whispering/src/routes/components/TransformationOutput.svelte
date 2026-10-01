<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { toast } from '@epicenter/ui/sonner';
	import type { Library, TransformationRunEntry } from '$lib/library.svelte.js';
	import { copyText, formatTime, recordingTitle } from './file-actions.js';

	/**
	 * One saved transformation result. It is its own file: what it shows comes
	 * from that file, so it reads the same after the transformation or the
	 * transcript it was made from has changed or gone.
	 */
	let { library, output, naming, onOpenFile }: {
		library: Library;
		output: TransformationRunEntry;
		/** Which side of the result to name: the transformation that made it, or the recording it came from. */
		naming: 'transformation' | 'recording';
		onOpenFile: (path: string) => void;
	} = $props();

	const recording = $derived(
		library.entries.find((entry) => entry.stem === output.fields.recordingId),
	);
	const heading = $derived(
		naming === 'transformation'
			? (output.fields.transformationTitle ?? 'Unknown transformation')
			: recording
				? recordingTitle(recording)
				: `Recording ${output.fields.recordingId ?? 'unknown'} (no longer in the folder)`,
	);

	function remove() {
		confirmationDialog.open({
			title: 'Delete this result?',
			description: `This deletes ${output.path} from the folder. The transcript it was made from is not changed. Committed versions stay in Git history.`,
			confirm: { text: 'Delete', variant: 'destructive' },
			async onConfirm() {
				const problem = await library.deleteTransformationResult(output);
				if (problem) toast.error('Could not delete the result', { description: problem });
			},
		});
	}
</script>

<article class="rounded border bg-muted/30 p-3 text-sm" data-testid="transformation-result">
	<header class="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
		<span class="font-medium">{heading}</span>
		{#if output.issues}<Badge variant="destructive">Needs repair</Badge>{/if}
	</header>
	<p class="whitespace-pre-wrap">{output.body?.trim() || '(empty result)'}</p>
	<footer class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
		<span>{formatTime(output.fields.createdAt) || 'Unknown time'} · {output.fields.model ?? 'unknown model'}</span>
		<Button size="xs" variant="ghost" onclick={() => onOpenFile(output.path)}>
			<code class="font-mono">{output.path}</code>
		</Button>
		<span class="ml-auto flex items-center gap-1">
			<Button size="xs" variant="ghost" onclick={() => void copyText(output.body ?? '', 'the result')}>Copy</Button>
			<Button size="xs" variant="ghost-destructive" onclick={remove}>Delete</Button>
		</span>
	</footer>
</article>
