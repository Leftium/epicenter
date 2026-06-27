/**
 * `local-books mcp`: a stdio Model Context Protocol server that exposes the
 * read / refresh / write verbs over the local QuickBooks mirror to a foreign
 * host (Claude Code, Codex, Cursor, ...).
 *
 * Why MCP, and why local stdio: Local Books is standalone and off the mesh
 * (ADR-0072), and its financial data must never transit the plaintext relay
 * (ADR-0004, ADR-0073). MCP is the only vocabulary a foreign host speaks, and a
 * subprocess reading the local SQLite directly is the only exposure that keeps
 * the data on the machine. So "let Claude Code use Local Books" reduces to
 * exactly this file: it adds no mesh, no relay, no `@epicenter/workspace`.
 *
 * The shape: each tool is one entry in `TOOLS` whose `input` is a TypeBox
 * schema. TypeBox IS JSON Schema at runtime, so the same object is the MCP
 * `inputSchema` (serialized over the wire) AND the validator (`Value.Check`,
 * in-process), with zero duplication. Each `run` maps straight onto an existing
 * pure `Result` core (the cores are untouched); adding a tool later is one more
 * entry in the table.
 *
 * stdout is the JSON-RPC channel, so this subcommand prints NOTHING to stdout
 * except protocol frames: no banners, no `console.log`, no progress. The cores
 * are handed no `log` sink (their default is a no-op), so nothing leaks; a
 * single stray byte would corrupt framing.
 *
 * Error model (MCP's two channels):
 *  - unknown tool / invalid arguments -> `throw new McpError(...)`, a JSON-RPC
 *    protocol error (the call itself was malformed).
 *  - a tool that ran and failed (bad SQL, a QB error, the read-only refusal) ->
 *    a normal result with `isError: true` and a text message, so the model can
 *    read it and self-correct.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	type CallToolResult,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { type TObject, Type } from 'typebox';
import { Value } from 'typebox/value';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { createQbAccess } from '../books/qb-access.ts';
import { queryBooks } from '../books/query.ts';
import {
	RECATEGORIZE_ENTITIES,
	type RecategorizeInput,
	recategorizeExpense,
} from '../books/recategorize.ts';
import {
	fetchReport,
	REPORT_NAMES,
	type ReportInput,
} from '../books/report.ts';
import { readBooksStatus } from '../books/status.ts';
import { type ParsedArgs, VERSION } from '../cli.ts';
import { resolveRealm } from '../companies.ts';
import { type AppConfig, loadConfig } from '../config.ts';
import { openBooksDb } from '../db.ts';
import { dbPath } from '../paths.ts';
import { syncRealm } from '../sync.ts';
import { createFileTokenStore, type TokenStore } from '../token-store.ts';

/** The `_meta` key carrying a tool's read/write classification for a host. */
const TIER_META = 'epicenter/tier';

/** What every tool `run` is handed: the resolved company plus a clock. */
type ToolContext = {
	config: AppConfig;
	realmId: string;
	store: TokenStore;
	now: () => number;
};

/** A tool's outcome: any object on success, anything with a `message` on failure. */
type ToolOutcome = Result<unknown, { message: string }>;

type ToolDescriptor = {
	name: string;
	title: string;
	description: string;
	/** TypeBox object schema: serialized as the MCP `inputSchema` AND the validator. */
	input: TObject;
	/**
	 * The tool's effect class, and the whole read-only gate:
	 *  - `read`  pure read of the mirror or a live QB report;
	 *  - `write` side-effecting but safe (sync refreshes the local cache);
	 *  - `mutation` mutates QuickBooks itself, and is the one class read-only
	 *    mode withholds from the catalog.
	 * The host sees only `read`/`write` via `_meta["epicenter/tier"]` (a mutation
	 * publishes as `write`); `mutation` is our internal gate marker.
	 */
	tier: 'read' | 'write' | 'mutation';
	run: (
		ctx: ToolContext,
		args: Record<string, unknown>,
	) => Promise<ToolOutcome>;
};

const TOOLS: ToolDescriptor[] = [
	{
		name: 'query',
		title: 'Query the books',
		description:
			'Run a read-only SQL query against the local QuickBooks mirror (one table per record type: invoices, customers, bills, purchases, accounts, ...). Returns up to 1000 rows.',
		input: Type.Object({
			sql: Type.String({
				description: 'A read-only SQL SELECT over the local mirror.',
			}),
		}),
		tier: 'read',
		async run(ctx, args) {
			const { sql } = args as { sql: string };
			return queryBooks({
				dbPath: dbPath(ctx.config.dataDir, ctx.realmId),
				sql,
			});
		},
	},
	{
		name: 'status',
		title: 'Books status',
		description:
			'Report the connection state and how fresh the local mirror is (cursor, last sync, per-record-type row counts). Cheap; good for "are you connected and synced?".',
		input: Type.Object({}),
		tier: 'read',
		async run(ctx) {
			return Ok(
				await readBooksStatus({
					config: ctx.config,
					realmId: ctx.realmId,
					store: ctx.store,
				}),
			);
		},
	},
	{
		name: 'report',
		title: 'Run a QuickBooks report',
		description:
			'Run a computed financial statement live from QuickBooks (never mirrored). Choose ProfitAndLoss, BalanceSheet, CashFlow, AgedReceivables, AgedPayables, or TrialBalance.',
		input: Type.Object({
			report: Type.Union(
				REPORT_NAMES.map((name) => Type.Literal(name)),
				{ description: 'The statement to compute.' },
			),
			start_date: Type.Optional(
				Type.String({ description: 'Period start, YYYY-MM-DD.' }),
			),
			end_date: Type.Optional(
				Type.String({ description: 'Period end, YYYY-MM-DD.' }),
			),
			accounting_method: Type.Optional(
				Type.Union([Type.Literal('Cash'), Type.Literal('Accrual')], {
					description: 'Basis; defaults to the company setting.',
				}),
			),
		}),
		tier: 'read',
		async run(ctx, args) {
			// Cast to the core's own input type (Value.Check ran in the handler).
			const input = args as ReportInput;
			const openQb = createQbAccess({
				config: ctx.config,
				realmId: ctx.realmId,
				store: ctx.store,
				now: ctx.now,
			});
			return fetchReport({ openQb, input });
		},
	},
	{
		name: 'sync',
		title: 'Refresh the books',
		description:
			'Refresh the local mirror from QuickBooks. Incremental by default (changes since the last cursor); pass full to force a complete re-pull. Side-effecting but safe: it only updates the local copy.',
		input: Type.Object({
			full: Type.Optional(
				Type.Boolean({
					description: 'Force a full re-pull instead of incremental CDC.',
				}),
			),
		}),
		tier: 'write',
		async run(ctx, args) {
			const { full } = args as { full?: boolean };
			// Same opener as report/recategorize: it loads the token and returns a
			// ready QB client, or a "run auth" reason. No bespoke not-connected error.
			const openQb = createQbAccess({
				config: ctx.config,
				realmId: ctx.realmId,
				store: ctx.store,
				now: ctx.now,
			});
			const { data: client, error } = await openQb();
			if (error !== null) return Err({ message: error });
			const db = openBooksDb(dbPath(ctx.config.dataDir, ctx.realmId));
			try {
				const outcome = await syncRealm(
					{ db, client, config: ctx.config, now: ctx.now },
					{ forceFull: full ?? false },
				);
				return Ok(outcome);
			} finally {
				db.close();
			}
		},
	},
	{
		name: 'recategorize',
		title: 'Recategorize an expense',
		description:
			'Move an expense transaction (a Purchase or Bill) to a different account in QuickBooks, then fold the authoritative response back into the mirror. The one write-back. Unavailable when LOCAL_BOOKS_READ_ONLY is set.',
		input: Type.Object({
			entity: Type.Union(
				RECATEGORIZE_ENTITIES.map((name) => Type.Literal(name)),
				{
					description:
						'The expense kind: Purchase (card/cash/check) or Bill (vendor bill).',
				},
			),
			id: Type.String({
				description: 'The transaction id (the mirror row id).',
			}),
			account_id: Type.String({
				description: 'The target expense account id (an accounts row id).',
			}),
			account_name: Type.Optional(
				Type.String({
					description:
						'The target account display name (optional, readable books).',
				}),
			),
			line_id: Type.Optional(
				Type.String({
					description:
						'Recategorize only this expense line; omit for every expense line.',
				}),
			),
		}),
		tier: 'mutation',
		async run(ctx, args) {
			const input = args as RecategorizeInput;
			const openQb = createQbAccess({
				config: ctx.config,
				realmId: ctx.realmId,
				store: ctx.store,
				now: ctx.now,
			});
			return recategorizeExpense({
				openQb,
				dbPath: dbPath(ctx.config.dataDir, ctx.realmId),
				// The catalog filter is the live gate: under read-only this tool is
				// unlisted, so this run only executes when readOnly is false. Passing
				// the real flag keeps the core as the invariant's single owner, so
				// removing the filter later cannot silently enable the write.
				readOnly: ctx.config.readOnly,
				input,
			});
		},
	},
];

/** Map a core's `Result` onto MCP's `CallToolResult` (the `isError` channel). */
function toCallResult({ data, error }: ToolOutcome): CallToolResult {
	if (error) {
		return { content: [{ type: 'text', text: error.message }], isError: true };
	}
	// Every core here returns an object; `structuredContent` must be one. Guard so
	// a future scalar/array-returning tool degrades to text-only rather than crash.
	const isObject =
		typeof data === 'object' && data !== null && !Array.isArray(data);
	return {
		content: [{ type: 'text', text: JSON.stringify(data) }],
		...(isObject ? { structuredContent: data as Record<string, unknown> } : {}),
	};
}

export async function runMcpServer(args: ParsedArgs): Promise<number> {
	// Same precedence the other verbs use (CLI > env > config.json > defaults);
	// the host typically passes LOCAL_BOOKS_DIR / _TOKEN_FILE / _READ_ONLY / the
	// realm via the MCP client config's `env`.
	const config = loadConfig({
		dataDir: args.dataDir,
		environment: args.environment,
		realm: args.realm,
	});

	// Read-only mode drops the QuickBooks mutation from the catalog entirely, so a
	// foreign host never even sees it. This filter is the live gate (the cores stay
	// the invariant's owner for the CLI path).
	const tools = TOOLS.filter((t) => t.tier !== 'mutation' || !config.readOnly);

	// The low-level `Server` is deliberate (its `@deprecated` tag nudges casual
	// users to the high-level `McpServer`, but explicitly keeps `Server` for
	// advanced use): only this path lets each tool's `inputSchema` be the TypeBox
	// object passed straight through, with our own `Value.Check` and error model.
	const server = new Server(
		{ name: 'local-books', version: VERSION },
		{ capabilities: { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.map((t) => ({
			name: t.name,
			title: t.title,
			description: t.description,
			inputSchema: t.input,
			// Emit the standard hints a host reads for its approval UX. (ADR-0073's
			// "never read readOnlyHint" is about not TRUSTING a foreign tool's
			// inbound hint, not about publishing our own honest one.) `mutation` is
			// the destructive QuickBooks write; `write` (sync) is a safe refresh.
			annotations: {
				readOnlyHint: t.tier === 'read',
				destructiveHint: t.tier === 'mutation',
				idempotentHint: t.tier !== 'mutation',
			},
			// Our own richer marker, for the Super Chat catalog (read/write).
			_meta: { [TIER_META]: t.tier === 'read' ? 'read' : 'write' },
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const tool = tools.find((t) => t.name === req.params.name);
		if (!tool) {
			throw new McpError(
				ErrorCode.MethodNotFound,
				`Unknown tool: ${req.params.name}`,
			);
		}
		const callArgs = req.params.arguments ?? {};
		if (!Value.Check(tool.input, callArgs)) {
			const detail = Value.Errors(tool.input, callArgs)
				.map((e) => `${e.instancePath || '/'}: ${e.message}`)
				.join('; ');
			throw new McpError(
				ErrorCode.InvalidParams,
				`Invalid arguments for "${tool.name}": ${detail}`,
			);
		}

		// Resolve the company per call so a freshly-authenticated realm is picked
		// up, and a missing one is a self-correctable result, not a startup crash.
		const { data: realmId, error: realmError } = resolveRealm(config);
		if (realmError !== null) {
			return { content: [{ type: 'text', text: realmError }], isError: true };
		}
		const ctx: ToolContext = {
			config,
			realmId,
			store: createFileTokenStore(config.credentialsPath),
			now: () => Date.now(),
		};
		return toCallResult(
			await tool.run(ctx, callArgs as Record<string, unknown>),
		);
	});

	// stdout carries JSON-RPC frames from here on. Block until the host
	// disconnects, then let bin.ts exit cleanly. A stdio server should exit on
	// stdin EOF, not only on SIGTERM, so an orphaned server (parent died without
	// signaling) does not hang; the transport watches only 'data', so wire EOF
	// here in addition to the protocol's own close.
	const transport = new StdioServerTransport();
	const closed = new Promise<void>((resolve) => {
		server.onclose = () => resolve();
		process.stdin.once('end', resolve);
		process.stdin.once('close', resolve);
	});
	await server.connect(transport);
	await closed;
	return 0;
}
