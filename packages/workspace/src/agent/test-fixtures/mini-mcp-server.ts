/**
 * A tiny stdio MCP server used only as a route target in the gateway catalog
 * loopback test. It stands in for `local-books mcp` so the workspace package can
 * exercise the MCP-over-gateway path WITHOUT depending on the `@epicenter/local-books`
 * app (a lower-level lib must not pull in an app). The real-`local-books`
 * acceptance lives in `packages/cli`, the integration layer that legitimately
 * consumes both.
 *
 * It exposes one read-only `customers` tool whose result mirrors the proto's
 * "who owes me money?" answer, so the test asserts the exact same shape the real
 * end-to-end proof does.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const CUSTOMERS = [
	'Acme | 4200.00',
	'Globex | 1500.00',
	'Initech | 300.00',
];

const server = new Server(
	{ name: 'mini-books', version: '0.0.0' },
	{ capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: 'customers',
			title: 'List customers',
			description: 'Who owes money, by balance.',
			inputSchema: { type: 'object', properties: {} },
			annotations: { readOnlyHint: true },
		},
	],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
	if (req.params.name !== 'customers') {
		return {
			content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
			isError: true,
		};
	}
	return { content: [{ type: 'text', text: CUSTOMERS.join('\n') }] };
});

const transport = new StdioServerTransport();
const closed = new Promise<void>((resolve) => {
	server.onclose = () => resolve();
	process.stdin.once('end', resolve);
	process.stdin.once('close', resolve);
});
await server.connect(transport);
await closed;
