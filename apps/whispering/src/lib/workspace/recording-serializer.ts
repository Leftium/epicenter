/**
 * Markdown serializer for the recordings table.
 *
 * Produces `{id}.md` files with YAML frontmatter (metadata) and the
 * transcript as the markdown body. This matches the format the desktop
 * file-system service has always written, so existing files on disk
 * remain human-readable and compatible.
 *
 * @example
 * ```md
 * ---
 * id: xk2f7vCz3LDd1H4haqykq
 * title: Grocery list for dinner party
 * recordedAt: '2026-04-15T12:14:00.000Z'
 * updatedAt: '2026-04-15T12:14:05.000Z'
 * transcriptionStatus: DONE
 * ---
 * Hey can you pick up some pasta and wine for Saturday...
 * ```
 */
import type { SerializeResult } from '@epicenter/workspace/extensions/materializer/markdown';
import type { Recording } from '$lib/workspace';
import { tauriYaml } from './tauri-materializer-io';

/**
 * Serialize a recording row to a markdown file.
 *
 * Separates `transcript` into the body and puts remaining metadata in
 * YAML frontmatter. The `_v` version tag is stripped—it's a workspace
 * internal, not useful in the human-readable file.
 */
export function serializeRecording(row: Recording): SerializeResult {
	const { transcript, _v, ...frontmatter } = row;

	const yamlStr = tauriYaml.stringify(frontmatter);
	const yamlBlock = yamlStr.endsWith('\n') ? yamlStr : `${yamlStr}\n`;

	const body = transcript || '';

	return {
		filename: `${row.id}.md`,
		content: `---\n${yamlBlock}---\n${body}\n`,
	};
}
