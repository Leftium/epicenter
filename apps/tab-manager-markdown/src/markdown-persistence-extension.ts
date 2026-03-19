/**
 * Markdown persistence extension.
 *
 * Observes Y.Doc changes and exports tab-manager state to markdown files,
 * one per device. Uses Bun's built-in `Bun.write()` with `createPath: true`
 * for file writes (auto-creates directories).
 *
 * Follows the Extension lifecycle contract:
 *
 * - `dispose`: Removes observer, clears timers, flushes pending writes
 * - `exports.flush`: Force-write any pending changes without disposing
 *
 * Chain before sync so the observer is in place before data arrives:
 *
 * ```typescript
 * createWorkspace(definition)
 *   .withExtension('persistence', createMarkdownPersistenceExtension({
 *     outputDir: './markdown/devices',
 *     debounceMs: 1000,
 *   }))
 *   .withExtension('sync', createSyncExtension({ url: '...' }))
 * ```
 */

import { join } from 'node:path';
import type * as Y from 'yjs';
import { generateMarkdown, type Tables } from './exporter';

type MarkdownPersistenceConfig = {
	outputDir: string;
	debounceMs: number;
};

/**
 * Creates an extension that persists Y.Doc state as markdown files.
 *
 * Observes all Y.Doc updates via `ydoc.on('update')` and debounces
 * writes to avoid disk thrashing during rapid changes. Each device
 * gets its own markdown file at `{outputDir}/{deviceId}.md`.
 *
 * Uses `Bun.write()` with `createPath: true` so the output directory
 * is created automatically on first write — no explicit `mkdir` needed.
 */
export function createMarkdownPersistenceExtension({
	outputDir,
	debounceMs,
}: MarkdownPersistenceConfig) {
	return ({ ydoc, tables }: { ydoc: Y.Doc; tables: Tables }) => {
		let timer: Timer | null = null;
		let pendingExport = false;

		async function exportAll() {
			console.log('Exporting markdown files...');

			const devices = tables.devices.getAllValid();
			const deviceMap = new Map<
				string,
				{
					device: (typeof devices)[number];
					windows: ReturnType<typeof tables.windows.filter>;
					tabs: ReturnType<typeof tables.tabs.filter>;
					tabGroups: ReturnType<typeof tables.tabGroups.filter>;
				}
			>();

			for (const device of devices) {
				deviceMap.set(device.id, {
					device,
					windows: tables.windows.filter((w) => w.deviceId === device.id),
					tabs: tables.tabs.filter((t) => t.deviceId === device.id),
					tabGroups: tables.tabGroups.filter((g) => g.deviceId === device.id),
				});
			}

			let exportCount = 0;
			for (const [deviceId, data] of deviceMap) {
				const markdown = generateMarkdown(data);
				const filePath = join(outputDir, `${deviceId}.md`);
				await Bun.write(filePath, markdown, { createPath: true });
				exportCount++;
			}

			console.log(
				`✓ Exported ${exportCount} device${exportCount === 1 ? '' : 's'}`,
			);
		}

		function scheduleExport() {
			pendingExport = true;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				if (pendingExport) {
					pendingExport = false;
					exportAll().catch((err) => {
						console.error('Export failed:', err);
					});
				}
			}, debounceMs);
		}

		async function flush() {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			if (pendingExport) {
				pendingExport = false;
				await exportAll();
			}
		}

		ydoc.on('update', scheduleExport);

		return {
			flush,
			async dispose() {
				ydoc.off('update', scheduleExport);
				await flush();
			},
		};
	};
}
