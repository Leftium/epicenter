<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { exportRecordingsMarkdown } from '$lib/recording-markdown-export';
	import { report } from '$lib/report';

	let isExporting = $state(false);

	async function handleExport() {
		if (isExporting) return;
		isExporting = true;
		const { data, error } = await exportRecordingsMarkdown();
		isExporting = false;

		if (error !== null) {
			report.error({
				title: 'Recording markdown export failed',
				cause: error,
			});
			return;
		}
		if (data === null) return;

		report.success({
			title: 'Recording markdown exported',
			description: `Wrote ${data.written} ${data.written === 1 ? 'file' : 'files'} to ${data.dir}.`,
		});
	}
</script>

<Button variant="outline" onclick={handleExport} disabled={isExporting}>
	{isExporting ? 'Exporting…' : 'Export markdown…'}
</Button>
