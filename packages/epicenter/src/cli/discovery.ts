import { dirname, join, parse, resolve } from 'node:path';
import type { WorkspaceClient } from '../dynamic/workspace/types';
import type { ProjectDir } from '../shared/types';

// biome-ignore lint/suspicious/noExplicitAny: WorkspaceClient is generic over tables/kv/extensions
type AnyWorkspaceClient = WorkspaceClient<any, any, any>;

export async function findProjectDir(
	startDir: string = process.cwd(),
): Promise<ProjectDir | null> {
	let current = resolve(startDir);
	const root = parse(current).root;

	while (current !== root) {
		const configPath = join(current, 'epicenter.config.ts');

		if (await fileExists(configPath)) {
			return current as ProjectDir;
		}

		current = dirname(current);
	}

	return null;
}

async function fileExists(path: string): Promise<boolean> {
	return Bun.file(path).exists();
}

export async function loadClients(
	projectDir: ProjectDir,
): Promise<AnyWorkspaceClient[]> {
	const configPath = join(projectDir, 'epicenter.config.ts');

	if (!(await fileExists(configPath))) {
		throw new Error(
			`No epicenter.config.ts found at ${configPath}\n` +
				`Create a config file that exports an array of workspace clients.`,
		);
	}

	const module = await import(configPath);
	const clients = module.default;

	if (!Array.isArray(clients)) {
		throw new Error(
			`epicenter.config.ts must export an array of workspace clients as default export.`,
		);
	}

	if (clients.length === 0) {
		throw new Error(`epicenter.config.ts exported an empty array of clients.`);
	}

	for (const client of clients) {
		if (!isWorkspaceClient(client)) {
			throw new Error(
				`Invalid client in epicenter.config.ts. Expected WorkspaceClient with workspaceId and tables properties.`,
			);
		}
	}

	return clients;
}

function isWorkspaceClient(value: unknown): value is AnyWorkspaceClient {
	return (
		typeof value === 'object' &&
		value !== null &&
		'workspaceId' in value &&
		'tables' in value &&
		typeof (value as Record<string, unknown>).workspaceId === 'string'
	);
}
