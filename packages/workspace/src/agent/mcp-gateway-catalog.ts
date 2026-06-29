/**
 * The cross-device {@link ToolCatalog}: tools are a remote peer's MCP tools,
 * reached over the {@link PeerTransport} seam (ADR-0073: over iroh the device
 * speaks MCP, and Epicenter owns only the transport). This is the SECOND catalog
 * impl beside {@link createDispatchToolCatalog}; the agent loop consumes the
 * `ToolCatalog` interface and never learns whether a tool is a local action, a
 * relayed peer action, or a remote MCP tool over iroh.
 *
 * One catalog binds to ONE route on ONE target device (the spec's
 * target-device-first picker): open the channel, drive an MCP `Client` over
 * {@link createStreamTransport}, list the tools once and cache them, and map each
 * `tools/call` onto {@link ToolCatalog.resolve}. The held channel keeps one warm
 * MCP session for the catalog's lifetime; `[Symbol.asyncDispose]` closes it.
 *
 * NODE-ONLY: it reaches a gateway through the node-only transport and the
 * node-only {@link createStreamTransport}. It is exported from
 * `@epicenter/workspace/gateway`, never the browser-reachable agent barrel.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type {
	CallToolResult,
	Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { JsonValue } from 'wellcrafted/json';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { createStreamTransport } from '../gateway/mcp-stream-transport.js';
import type {
	PeerId,
	PeerTransport,
	RouteName,
} from '../peer-transport.js';
import type {
	AgentToolCall,
	AgentToolDefinition,
	AgentToolOutcome,
	ToolCatalog,
} from './tools.js';

export type McpGatewayCatalogOptions = {
	/** The transport-blind seam to the remote peer's gateway. */
	transport: PeerTransport;
	/** The device whose MCP tools this catalog exposes. */
	target: PeerId;
	/** The named route on the target's gateway (e.g. `books`). */
	route: RouteName;
	/**
	 * Direct dial hints (`ip:port`), optional and forwarded to the transport. A
	 * discovery transport (`n0`) ignores them and resolves the peer by peerId;
	 * only a direct-only (`minimal`) transport needs them.
	 */
	hintAddrs?: string[];
	/**
	 * How long to wait for the open + MCP handshake + first `tools/list` before
	 * giving up (ms, default 15000). A peer the route refuses (Ring 0) closes the
	 * connection after the QUIC handshake, so the MCP `initialize` never answers;
	 * without this the caller would hang on the SDK's minute-long request timeout.
	 * A timeout here IS the refusal signal.
	 */
	connectTimeoutMs?: number;
	/** Diagnostics sink. Defaults to a `workspace/mcp-gateway` logger. */
	logger?: Logger;
};

/**
 * A {@link ToolCatalog} backed by a live MCP session, plus the disposer that
 * closes that session (and the underlying channel).
 */
export type McpGatewayCatalog = ToolCatalog & {
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Open a channel to `route` on `target`, run the MCP handshake, and return a
 * catalog whose `definitions()` is the cached `tools/list` and whose `resolve()`
 * is `tools/call`. Async because the MCP `initialize` + `tools/list` round-trip
 * happens up front, so the loop's synchronous `definitions()` can return the
 * cached list with no await.
 */
export async function createMcpGatewayCatalog(
	options: McpGatewayCatalogOptions,
): Promise<McpGatewayCatalog> {
	const {
		transport,
		target,
		route,
		hintAddrs,
		connectTimeoutMs = 15_000,
		logger = createLogger('workspace/mcp-gateway'),
	} = options;

	const client = new Client({ name: 'epicenter-gateway', version: '0.0.0' });
	const connectAbort = new AbortController();
	const definitions = await withTimeout(
		connectTimeoutMs,
		`open MCP catalog for ${route} on ${target.slice(0, 16)}`,
		async () => {
			const channel = await transport.openChannel({
				target,
				route,
				hintAddrs,
				signal: connectAbort.signal,
			});
			await client.connect(createStreamTransport(channel));
			const listed = await client.listTools();
			return listed.tools.map(toAgentToolDefinition);
		},
	).catch(async (error) => {
		// A refused route or a dead channel surfaces here. Abort the dial so the
		// transport closes its connection even if `openChannel` resolved after the
		// timeout fired (otherwise that connection leaks), release the half-open
		// client, then propagate the refusal.
		connectAbort.abort(error);
		await client.close().catch(() => {});
		throw error;
	});
	logger.info('opened MCP catalog', {
		target: target.slice(0, 16),
		route,
		tools: definitions.length,
	});

	return {
		definitions: () => definitions,
		async resolve(
			call: AgentToolCall,
			signal: AbortSignal,
		): Promise<AgentToolOutcome> {
			try {
				const result = (await client.callTool(
					{
						name: call.toolName,
						arguments: asArguments(call.input),
					},
					undefined,
					{ signal },
				)) as CallToolResult;
				return toToolOutcome(result);
			} catch (error) {
				return {
					output: error instanceof Error ? error.message : String(error),
					isError: true,
				};
			}
		},
		async [Symbol.asyncDispose]() {
			try {
				await client.close();
			} catch {
				// Already closed / channel gone: nothing to release.
			}
		},
	};
}

/** Run `work`, rejecting if it has not settled within `ms`. */
async function withTimeout<T>(
	ms: number,
	label: string,
	work: () => Promise<T>,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`timeout (${ms}ms): ${label}`)),
			ms,
		);
	});
	try {
		return await Promise.race([work(), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Project an MCP {@link Tool} to an {@link AgentToolDefinition}. `kind` is the
 * honest query-vs-mutation bit (ADR-0044): a tool counts as a `query` only when
 * it publishes `readOnlyHint: true`, so anything unannotated defaults to a gated
 * `mutation`. (ADR-0073's "never trust a foreign tool's hint to RELAX a gate"
 * holds: an absent or false hint tightens to mutation, never loosens.)
 */
function toAgentToolDefinition(tool: Tool): AgentToolDefinition {
	return {
		name: tool.name,
		kind: tool.annotations?.readOnlyHint === true ? 'query' : 'mutation',
		...(tool.title !== undefined && { title: tool.title }),
		...(tool.description !== undefined && { description: tool.description }),
		...(tool.inputSchema !== undefined && {
			inputSchema: tool.inputSchema as JsonValue,
		}),
	};
}

/** MCP `arguments` is an object; a non-object tool input is sent as `{}`. */
function asArguments(input: JsonValue): Record<string, unknown> {
	return input !== null && typeof input === 'object' && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: {};
}

/**
 * Flatten an MCP {@link CallToolResult} into an {@link AgentToolOutcome}. Text
 * parts join into one string (the common case for our tools); a result carrying
 * non-text content falls back to the raw content array as a JSON value. `isError`
 * rides the MCP flag.
 */
function toToolOutcome(result: CallToolResult): AgentToolOutcome {
	const isError = result.isError === true;
	const textParts = result.content.filter(
		(part): part is { type: 'text'; text: string } => part.type === 'text',
	);
	const allText = textParts.length === result.content.length;
	const output: JsonValue = allText
		? textParts.map((part) => part.text).join('\n')
		: (result.content as JsonValue);
	return { output, isError };
}
