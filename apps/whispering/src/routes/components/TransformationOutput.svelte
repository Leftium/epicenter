<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { toast } from '@epicenter/ui/sonner';
	import type { Library, TextRunEntry, TransformationRunEntry } from '$lib/library.svelte.js';
	import { needsRepair } from '$lib/rows.js';
	import { copyText, formatTime, recordingTitle } from './file-actions.js';

	/**
	 * One saved transformation result. It is its own file: what it shows comes
	 * from that file, so it reads the same after the transformation, or the
	 * transcript or pasted text it was made from, has changed or gone.
	 */
	let { library, output, naming, onOpenFile }: {
		library: Library;
		/** A result on a transcript, from `transformation_runs/`, or on pasted text, from `text_runs/`. */
		output:
			| { readonly source: 'transcript'; readonly entry: TransformationRunEntry }
			| { readonly source: 'text'; readonly entry: TextRunEntry };
		/** Which side of the result to name: the transformation that made it, or what it was made from. */
		naming: 'transformation' | 'source';
		onOpenFile: (path: string) => void;
	} = $props();

	const entry = $derived(output.entry);
	/** What the file states, field by field. A field that did not validate reads as unknown. */
	const fields = $derived(entry.fields);
	const text = $derived(entry.body);
	const recording = $derived(
		output.source === 'transcript'
			? library.entries.find((item) => item.stem === output.entry.fields.recordingId)
			: undefined,
	);
	const heading = $derived.by(() => {
		if (naming === 'transformation') return fields.transformationTitle ?? 'Unknown transformation';
		if (output.source === 'text') return 'Pasted text';
		if (recording) return recordingTitle(recording);
		return `Recording ${output.entry.fields.recordingId ?? 'unknown'} (no longer in the folder)`;
	});

	function remove() {
		confirmationDialog.open({
			title: 'Delete this result?',
			description:
				output.source === 'text'
					? `This deletes ${entry.path} from the folder. Committed versions stay in Git history.`
					: `This deletes ${entry.path} from the folder. The transcript it was made from is not changed. Committed versions stay in Git history.`,
			confirm: { text: 'Delete', variant: 'destructive' },
			async onConfirm() {
				const problem =
					output.source === 'text'
						? await library.deleteTextResult(output.entry)
						: await library.deleteTransformationResult(output.entry);
				if (problem) toast.error('Could not delete the result', { description: problem });
			},
		});
	}
</script>

<article class="rounded border bg-muted/30 p-3 text-sm" data-testid="transformation-result" data-result-source={output.source}>
	<header class="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
		<span class="font-medium">{heading}</span>
		{#if output.source === 'text' && naming === 'source' && fields.input}
			<span class="min-w-0 flex-1 truncate text-muted-foreground" title={fields.input}>{fields.input.trim()}</span>
		{/if}
		{#if needsRepair(entry)}<Badge variant="destructive">Needs repair</Badge>{/if}
	</header>
	<p class="whitespace-pre-wrap">{text?.trim() || '(empty result)'}</p>
	<footer class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
		<span>{formatTime(fields.createdAt) || 'Unknown time'} · {fields.model ?? 'unknown model'}</span>
		<Button size="xs" variant="ghost" onclick={() => onOpenFile(entry.path)}>
			<code class="font-mono">{entry.path}</code>
		</Button>
		<span class="ml-auto flex items-center gap-1">
			<Button size="xs" variant="ghost" onclick={() => void copyText(text ?? '', 'the result')}>Copy</Button>
			<Button size="xs" variant="ghost-destructive" onclick={remove}>Delete</Button>
		</span>
	</footer>
</article>
