/**
 * Tauri filesystem + YAML adapters for the markdown materializer.
 *
 * The workspace materializer is runtime-agnostic—it accepts IO and YAML
 * adapters instead of depending on Node/Bun APIs directly. This module
 * provides the Tauri implementations so the materializer can write `.md`
 * files from a browser WebView using `@tauri-apps/plugin-fs`.
 */
import {
	mkdir,
	remove,
	rename as tauriRename,
	writeTextFile,
} from '@tauri-apps/plugin-fs';
import yaml from 'js-yaml';
import type {
	MaterializerIO,
	MaterializerYaml,
} from '@epicenter/workspace/extensions/materializer/markdown';

/**
 * Tauri filesystem adapter.
 *
 * Uses `@tauri-apps/plugin-fs` for file operations and `@tauri-apps/api/path`
 * for path joining. Writes are atomic (tmp file + rename) to avoid partial
 * reads from the materializer's observer-driven write path.
 */
export const tauriIO: MaterializerIO = {
	async mkdir(dir) {
		await mkdir(dir, { recursive: true });
	},

	async writeFile(path, content) {
		const tmpPath = `${path}.tmp`;
		await writeTextFile(tmpPath, content);
		await tauriRename(tmpPath, path);
	},

	async removeFile(path) {
		await remove(path).catch(() => {});
	},

	async joinPath(...segments) {
		const { join } = await import('@tauri-apps/api/path');
		return join(...segments);
	},
};

/**
 * YAML serializer using js-yaml.
 *
 * `lineWidth: -1` prevents js-yaml from wrapping long strings, keeping
 * frontmatter on single lines for readability and grep-friendliness.
 */
export const tauriYaml: MaterializerYaml = {
	stringify: (obj) => yaml.dump(obj, { lineWidth: -1 }),
};
