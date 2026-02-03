// biome-ignore assist/source/organizeImports: <explanation>
import { dirname, join, parse, resolve } from 'node:path';
import type { WorkspaceClient } from '../static/types';
import type { ProjectDir } from '../shared/types';

// biome-ignore lint/suspicious/noExplicitAny: WorkspaceClient is generic over tables/kv/capabilities
export type AnyWorkspaceClient = WorkspaceClient<any, any, any, any>;

/** Single client mode - commands are top-level (e.g., `posts list`) */
export type SingleClientConfig = {
	mode: 'single';
	clients: [AnyWorkspaceClient];
};

/** Multi client mode - commands nested under workspace (e.g., `blog posts list`) */
export type MultiClientConfig = {
	mode: 'multi';
	clients: AnyWorkspaceClient[];
};

/** Discriminated union for CLI command configuration */
export type CommandConfig = SingleClientConfig | MultiClientConfig;

/** Create a CommandConfig from an array of clients */
export function createCommandConfig(clients: AnyWorkspaceClient[]): CommandConfig {
	if (clients.length === 0) {
		throw new Error('At least one client required');
	}
	if (clients.length === 1) {
		return { mode: 'single', clients: [clients[0]!] as const };
	}
	return { mode: 'multi', clients };
}

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
		throw new Error(`No epicenter.config.ts found at ${configPath}`);
	}

	const module = await import(configPath);
	const clients = Object.values(module).filter(isWorkspaceClient);

	if (clients.length === 0) {
		throw new Error(
			`No WorkspaceClient exports found in epicenter.config.ts.\n` +
				`Export clients as named exports: export const myClient = createWorkspaceClient({...})`,
		);
	}

	return clients;
}

function isWorkspaceClient(value: unknown): value is AnyWorkspaceClient {
	return (
		typeof value === 'object' &&
		value !== null &&
		'id' in value &&
		'tables' in value &&
		typeof (value as Record<string, unknown>).id === 'string'
	);
}
