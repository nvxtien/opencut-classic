#!/usr/bin/env node
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./register-tools";
import { ProjectStore } from "./store";

/**
 * HTTP entry point, for clients that only take an HTTP(S) MCP server URL
 * (e.g. the Claude desktop app's "Add custom connector" dialog — see
 * `docs/mcp-headless.md` §3). `server.ts` (stdio) is the primary, tested
 * entry point; this wraps the same tools in a stateless
 * `StreamableHTTPServerTransport` since this is meant for one local client
 * at a time, not a multi-tenant deployment.
 *
 * In stateless mode (`sessionIdGenerator: undefined`) the SDK requires a
 * fresh `StreamableHTTPServerTransport` — and therefore a fresh `McpServer`
 * connected to it — per HTTP request; reusing one across requests throws
 * "Stateless transport cannot be reused across requests" on the second call
 * (`webStandardStreamableHttp.js`, line ~177). The `ProjectStore`, not the
 * transport, is what's shared across requests, so project state still
 * persists across the agent's separate tool calls.
 */

const PORT = Number(process.env.PORT ?? 8765);

// OPENCUT_HEADLESS_DATA_DIR lets tests (and anyone else) point the project
// store at a throwaway directory instead of the real ~/.opencut-headless.
const store = new ProjectStore(process.env.OPENCUT_HEADLESS_DATA_DIR);

async function main() {
	const httpServer = createServer((req, res) => {
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id, mcp-protocol-version");

		if (req.method === "OPTIONS") {
			res.writeHead(204).end();
			return;
		}
		if (req.url !== "/mcp") {
			res.writeHead(404, { "Content-Type": "application/json" }).end(
				JSON.stringify({ error: "not found; the MCP endpoint is /mcp" }),
			);
			return;
		}

		const server = new McpServer({ name: "opencut-headless", version: "0.1.0" });
		registerTools(server, store);
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

		server
			.connect(transport)
			.then(() => transport.handleRequest(req, res))
			.catch((err) => {
				console.error("[http-server] request failed:", err);
				if (!res.headersSent) {
					res.writeHead(500, { "Content-Type": "application/json" }).end(
						JSON.stringify({ error: "internal error" }),
					);
				}
			});
	});

	httpServer.listen(PORT, () => {
		console.error(`opencut-headless MCP server listening on http://localhost:${PORT}/mcp`);
	});
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
