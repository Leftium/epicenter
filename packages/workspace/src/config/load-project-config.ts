import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { type } from 'arktype';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

import type { ProjectDir } from '../shared/types.js';
import {
	type EpicenterConfig,
	PROJECT_CONFIG_FILENAME,
} from './define-config.js';

const EpicenterConfigSchema = type({
	'routes?': type({ open: 'Function' }).array(),
});

export const ProjectConfigError = defineErrors({
	ProjectConfigNotFound: ({
		projectConfigPath,
	}: {
		projectConfigPath: string;
	}) => ({
		message: `Project config not found at ${projectConfigPath}`,
		projectConfigPath,
	}),
});
export type ProjectConfigError = InferErrors<typeof ProjectConfigError>;

export async function loadProjectConfig(
	projectDir: ProjectDir | string,
): Promise<Result<EpicenterConfig, ProjectConfigError>> {
	const projectConfigPath = join(resolve(projectDir), PROJECT_CONFIG_FILENAME);
	if (!existsSync(projectConfigPath)) {
		return ProjectConfigError.ProjectConfigNotFound({ projectConfigPath });
	}

	const module = await importProjectConfig(projectConfigPath);
	if (!('default' in module)) {
		throw new Error(
			`loadProjectConfig: ${projectConfigPath} must default-export defineConfig(...).`,
		);
	}

	const loaded = EpicenterConfigSchema(module.default);
	if (loaded instanceof type.errors) {
		throw new Error(
			`loadProjectConfig: ${projectConfigPath} is invalid: ${loaded.toString()}`,
		);
	}

	return Ok(loaded as EpicenterConfig);
}

async function importProjectConfig(
	projectConfigPath: string,
): Promise<{ default?: unknown }> {
	try {
		return (await import(pathToFileURL(projectConfigPath).href)) as {
			default?: unknown;
		};
	} catch (cause) {
		throw new Error(
			`loadProjectConfig: failed to load ${projectConfigPath}: ${extractErrorMessage(cause)}`,
			{ cause },
		);
	}
}
