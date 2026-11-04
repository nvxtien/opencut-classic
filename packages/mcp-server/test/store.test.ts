import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectStore } from "../src/store";

/**
 * Regression test for the race found by /ponytail-audit: two concurrent
 * `getProject` calls for the same not-yet-cached project used to each read
 * and parse their own separate copy from disk; whichever caller's edit
 * saved last would silently overwrite the other's.
 */
async function main() {
	const dataDir = mkdtempSync(join(tmpdir(), "store-race-test-"));
	mkdirSync(dataDir, { recursive: true });

	const now = new Date().toISOString();
	const project = {
		metadata: { id: "proj_1", name: "Race test", duration: 0, createdAt: now, updatedAt: now },
		scenes: [
			{
				id: "scene_1",
				name: "Main",
				isMain: true,
				tracks: {
					main: { id: "track_1", name: "Video", type: "video", elements: [], muted: false, hidden: false },
					overlay: [],
					audio: [],
				},
				bookmarks: [],
				createdAt: now,
				updatedAt: now,
			},
		],
		currentSceneId: "scene_1",
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1920, height: 1080 },
			background: { type: "color", color: "#000000" },
		},
		version: 1,
	};
	writeFileSync(join(dataDir, "proj_1.json"), JSON.stringify(project));

	const store = new ProjectStore(dataDir);

	// Two concurrent loads of the same uncached project. Before the fix,
	// each independently read+parsed the file, returning two different
	// object instances.
	const [a, b] = await Promise.all([store.getProject("proj_1"), store.getProject("proj_1")]);
	assert.equal(a, b, "two concurrent getProject calls for the same project returned different object instances");

	console.log("\nAll store.test.ts checks PASSED");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
