/**
 * `epicenter apply --mount <name>`: reconcile a mount's on-disk markdown INTO
 * its workspace through the local daemon. Disk is the desired state: the daemon
 * diffs the `.md` files against the live rows (by id) and applies creates,
 * updates, and deletes via the mount's `markdown_apply` action.
 *
 * `--dry-run` prints the plan without writing. `--allow-deletes <n>` raises the
 * delete guard (default 10; the run refuses rather than delete more). The plan
 * is written to stdout as JSON (scripting-first); a refused plan prints its
 * reason to stderr and exits non-zero, so a guard trip is observable in scripts.
 *
 * Requires a running daemon for the discovered project (see `epicenter daemon
 * up`). A mount whose table customizes `toMarkdown` without a `fromMarkdown`
 * (e.g. fuji entry bodies) is refused by the action as `RoundTripUnproven`.
 *
 * Exit codes:
 *   1: usage error (unknown mount/action) or no daemon
 *   2: runtime error invoking the action
 *   4: the plan was refused (a guard tripped; nothing applied)
 */

import {
	type DaemonError,
	getDaemon,
	type InvokeError,
} from '@epicenter/workspace/node';
import { extractErrorMessage } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

import { cmd } from '../util/cmd.js';
import { projectOption } from '../util/common-options.js';
import {
	fail,
	formatOptions,
	type OutputFormat,
	output,
} from '../util/format-output.js';

/** Wire shape of the `markdown_apply` result (untyped JSON over the socket). */
type ApplyPlan = {
	refused: boolean;
	reason?: string;
	creates: { tableName: string; id: string }[];
	updates: { tableName: string; id: string }[];
	deletes: { tableName: string; id: string }[];
	skipped: { path: string }[];
	errors: { path: string; tableName: string; error: unknown }[];
};

export const applyCommand = cmd({
	command: 'apply',
	describe:
		"Reconcile a mount's markdown files into its workspace (disk is the desired state)",
	builder: (yargs) =>
		yargs
			.option('mount', {
				type: 'string',
				demandOption: true,
				describe: 'Mount name to reconcile, e.g. fuji',
			})
			.option('dryRun', {
				type: 'boolean',
				default: false,
				describe: 'Compute and print the plan without writing',
			})
			.option('maxDeletes', {
				type: 'number',
				describe:
					'Maximum rows the run may delete before it refuses (default 10)',
			})
			.option('C', projectOption)
			.options(formatOptions)
			.strict(),
	handler: async (argv) => {
		const { data: daemon, error: daemonErr } = await getDaemon(argv.C);
		if (daemonErr) {
			fail(daemonErr.message);
			return;
		}

		const input: { dryRun: boolean; maxDeletes?: number } = {
			dryRun: argv.dryRun,
		};
		if (argv.maxDeletes !== undefined) input.maxDeletes = argv.maxDeletes;

		const result = await daemon.invoke({
			actionPath: `${argv.mount}.markdown_apply`,
			input,
		});
		renderApply(result, argv.format);
	},
});

function renderApply(
	result: Result<unknown, InvokeError | DaemonError>,
	format: OutputFormat | undefined,
): void {
	if (result.error !== null) {
		switch (result.error.name) {
			case 'UsageError': {
				const details = result.error.suggestions?.length
					? ['', 'Exposed actions at this mount:', ...result.error.suggestions]
					: [];
				fail(result.error.message, { details });
				return;
			}
			case 'RuntimeError':
				fail(result.error.message, { code: 2 });
				return;
			default:
				fail(result.error.message);
				return;
		}
	}

	const plan = result.data as ApplyPlan;
	// Guard the wire shape: a version-mismatched daemon could return anything.
	if (typeof plan?.refused !== 'boolean' || !Array.isArray(plan?.deletes)) {
		fail('unexpected markdown_apply response (daemon version mismatch?)', {
			code: 2,
		});
		return;
	}

	// Plan to stdout (machine-readable), regardless of outcome.
	output(plan, { format });

	// A refused plan applied nothing. Surface the reason plus the offending file
	// paths, and exit with a code distinct from runtime error so scripts can tell
	// "ran cleanly but declined" from "failed to run".
	if (plan.refused) {
		const details = plan.errors.map(
			(e) => `  ${e.path} (${e.tableName}): ${extractErrorMessage(e.error)}`,
		);
		fail(plan.reason ?? 'apply refused; nothing was applied', {
			code: 4,
			details,
		});
	}
}
