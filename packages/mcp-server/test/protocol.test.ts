import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Proves the actual MCP wire protocol works — not just the tool functions
 * (`tools.test.ts` covers those). Spawns `src/server.ts` as a real child
 * process over stdio, the way Claude Desktop/Cursor/an agent would, and
 * talks to it only through the SDK's `Client`.
 */
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const EXPECTED_TOOLS = [
	"create_project",
	"list_projects",
	"add_media",
	"add_clip",
	"split_clip",
	"trim_clip",
	"add_text",
	"remove_element",
	"get_project_state",
	"delete_project",
	"export_video",
	"get_render_status",
];

async function main() {
	// A throwaway data dir — this test never touches the real ~/.opencut-headless.
	const dataDir = mkdtempSync(join(tmpdir(), "mcp-protocol-test-"));
	const transport = new StdioClientTransport({
		command: join(packageRoot, "node_modules", ".bin", "tsx"),
		args: [join(packageRoot, "src", "server.ts")],
		cwd: packageRoot,
		env: { ...process.env, OPENCUT_HEADLESS_DATA_DIR: dataDir },
	});

	const client = new Client({ name: "protocol-test-client", version: "0.1.0" });
	await client.connect(transport);

	try {
		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name).sort();
		assert.deepEqual(names, [...EXPECTED_TOOLS].sort());

		const createProjectTool = tools.find((t) => t.name === "create_project");
		assert.ok(createProjectTool, "create_project not found in tools/list");
		assert.ok(
			createProjectTool.inputSchema?.properties &&
				"name" in createProjectTool.inputSchema.properties,
			"create_project input schema missing 'name' property",
		);

		const result = await client.callTool({
			name: "create_project",
			arguments: { name: "Protocol smoke test", width: 640, height: 360 },
		});
		assert.equal(result.isError, undefined);
		const content = (result.content as Array<{ type: string; text: string }>)[0];
		assert.ok(content, "callTool returned no content");
		const project = JSON.parse(content.text);
		assert.equal(project.metadata.name, "Protocol smoke test");
		assert.equal(project.settings.canvasSize.width, 640);

		const badCall = await client.callTool({
			name: "get_project_state",
			arguments: { projectId: "does-not-exist" },
		});
		assert.equal(badCall.isError, true);

		console.log(
			JSON.stringify(
				{
					toolCount: tools.length,
					toolNames: names,
					createdProjectId: project.metadata.id,
				},
				null,
				2,
			),
		);
		console.log("\nAll protocol.test.ts checks PASSED");
	} finally {
		await client.close();
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
