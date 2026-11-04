import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Same proof as `protocol.test.ts` (real wire protocol, not just the tool
 * functions) but over the HTTP transport added for the desktop app's "Add
 * custom connector" dialog, which only accepts an HTTP(S) MCP URL — see
 * `docs/mcp-headless.md` §3.
 */
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 8766; // distinct from the default, to not collide with a manually-run instance

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

function waitForListening(proc: ReturnType<typeof spawn>): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("http-server.ts did not report listening within 10s")),
			10_000,
		);
		proc.stderr?.on("data", (chunk: Buffer) => {
			if (chunk.toString("utf8").includes("listening on")) {
				clearTimeout(timeout);
				resolve();
			}
		});
		proc.on("error", reject);
		proc.on("exit", (code) => {
			clearTimeout(timeout);
			reject(new Error(`http-server.ts exited early with code ${code}`));
		});
	});
}

async function main() {
	// A throwaway data dir — this test never touches the real ~/.opencut-headless.
	const dataDir = mkdtempSync(join(tmpdir(), "mcp-http-protocol-test-"));
	const serverProcess = spawn(
		join(packageRoot, "node_modules", ".bin", "tsx"),
		[join(packageRoot, "src", "http-server.ts")],
		{
			cwd: packageRoot,
			env: { ...process.env, PORT: String(PORT), OPENCUT_HEADLESS_DATA_DIR: dataDir },
		},
	);

	serverProcess.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[server] ${chunk}`));

	try {
		await waitForListening(serverProcess);
		await new Promise((r) => setTimeout(r, 500));

		const transport = new StreamableHTTPClientTransport(
			new URL(`http://localhost:${PORT}/mcp`),
		);
		const client = new Client({ name: "http-protocol-test-client", version: "0.1.0" });
		await client.connect(transport);

		try {
			const { tools } = await client.listTools();
			const names = tools.map((t) => t.name).sort();
			assert.deepEqual(names, [...EXPECTED_TOOLS].sort());

			const result = await client.callTool({
				name: "create_project",
				arguments: { name: "HTTP transport smoke test", width: 640, height: 360 },
			});
			assert.equal(result.isError, undefined);
			const content = (result.content as Array<{ type: string; text: string }>)[0];
			assert.ok(content, "callTool returned no content");
			const project = JSON.parse(content.text);
			assert.equal(project.metadata.name, "HTTP transport smoke test");

			console.log(
				JSON.stringify({ toolCount: tools.length, toolNames: names, projectId: project.metadata.id }, null, 2),
			);
			console.log("\nAll http-protocol.test.ts checks PASSED");
		} finally {
			await client.close();
		}
	} finally {
		serverProcess.kill();
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
