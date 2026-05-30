import { invoke } from '@tauri-apps/api/core';
import { appDataDir, join } from '@tauri-apps/api/path';
import type { MarkdownFile, Tauri } from './types';

const markdown = {
	async directory() {
		return await join(await appDataDir(), 'markdown');
	},

	async writeFiles(files: MarkdownFile[]) {
		const directory = await this.directory();
		await invoke('write_markdown_files', { directory, files });
	},

	async readFiles() {
		const directory = await this.directory();
		return await invoke<MarkdownFile[]>('read_markdown_files', { directory });
	},
};

export const tauri: Tauri | null = { markdown };
