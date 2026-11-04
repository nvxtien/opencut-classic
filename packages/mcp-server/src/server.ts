#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./register-tools";
import { ProjectStore } from "./store";

async function main() {
	const server = new McpServer({ name: "opencut-headless", version: "0.1.0" });
	// OPENCUT_HEADLESS_DATA_DIR lets tests (and anyone else) point the project
	// store at a throwaway directory instead of the real ~/.opencut-headless.
	registerTools(server, new ProjectStore(process.env.OPENCUT_HEADLESS_DATA_DIR));

	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
