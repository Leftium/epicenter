import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { type Result, tryAsync } from 'wellcrafted/result';
import yaml from 'js-yaml';
import { commands } from './tauri/commands';
import { whispering } from './whispering/client';
import type { Recording } from './workspace';

export const RecordingMarkdownExportError = defineErrors({
	WriteFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to write recording markdown files: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type RecordingMarkdownExportError = InferErrors<
	typeof RecordingMarkdownExportError
>;

export type RecordingMarkdownExportResult = {
	dir: string;
	written: number;
};

/**
 * Serialize a recording row to a markdown file.
 *
 * Puts `transcript` in the body and all other metadata in YAML frontmatter.
 */
function toRecordingMarkdownFile(row: Recording) {
	const { transcript, ...frontmatter } = row;
	const yamlStr = yaml.dump(frontmatter, { lineWidth: -1 });
	return {
		filename: `${row.id}.md`,
		content: `---\n${yamlStr}---\n${transcript || ''}\n`,
	};
}

/**
 * Open a folder picker and write every current recording as a markdown file
 * to the chosen folder. Snapshot at click time: later edits in Whispering
 * do not update the exported files. Resolves to `null` when the user
 * cancels the dialog.
 */
export async function exportRecordingsMarkdown(): Promise<
	Result<RecordingMarkdownExportResult | null, RecordingMarkdownExportError>
> {
	return tryAsync({
		try: async () => {
			const { open } = await import('@tauri-apps/plugin-dialog');
			const selected = await open({
				directory: true,
				multiple: false,
				title: 'Choose folder for recording markdown export',
			});
			if (typeof selected !== 'string') return null;

			const files = whispering.tables.recordings
				.getAllValid()
				.map(toRecordingMarkdownFile);
			const { error } = await commands.writeMarkdownFiles(selected, files);
			if (error !== null) throw error;
			return { dir: selected, written: files.length };
		},
		catch: (error) => RecordingMarkdownExportError.WriteFailed({ cause: error }),
	});
}
