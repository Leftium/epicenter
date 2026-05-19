/**
 * Daemon route registry helpers.
 *
 * Project configs own route registration. This module turns the explicit
 * `routes` list from `epicenter.config.ts` into startup entries and validates
 * route names before any workspace opens.
 */

import { Ok, type Result } from 'wellcrafted/result';
import type { DaemonWorkspaceModule } from '../daemon/define-daemon-workspace.js';
import {
	validateDaemonRouteNames,
	WORKSPACES_DIRNAME,
} from '../daemon/route-validation.js';
import {
	WorkspaceAppError,
	type WorkspaceAppError as WorkspaceAppErrorType,
} from './errors.js';

export { WORKSPACES_DIRNAME };

export type WorkspaceAppEntry = {
	route: string;
	module: DaemonWorkspaceModule;
};

export function discoverWorkspaceApps(
	routes: readonly DaemonWorkspaceModule[] = [],
): Result<WorkspaceAppEntry[], WorkspaceAppErrorType> {
	const entries = routes.map((module) => ({
		route: module.route,
		module,
	}));
	const issue = validateDaemonRouteNames(entries.map((entry) => entry.route));
	if (issue !== null) return WorkspaceAppError.WorkspaceRouteRejected(issue);
	return Ok(entries);
}
