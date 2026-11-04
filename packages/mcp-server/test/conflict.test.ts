import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addText, createProject, getProjectState } from "../src/tools";
import { ProjectStore } from "../src/store";

/**
 * Regression test for the architecture review's cross-process race: two
 * `ProjectStore` instances (standing in for two server processes — the
 * stdio and HTTP entry points, say) pointed at the same `dataDir`, each
 * caching its own copy of the same project. Without the revision check in
 * `saveProject`, the second store's save would silently overwrite the
 * first store's edit with no error.
 */
async function main() {
	const dataDir = mkdtempSync(join(tmpdir(), "conflict-test-"));

	const storeA = new ProjectStore(dataDir);
	const project = await createProject(storeA, { name: "Conflict test" });

	// storeB independently loads the same project — its own cached copy.
	const storeB = new ProjectStore(dataDir);
	await getProjectState(storeB, project.metadata.id);

	// storeA edits and saves first — this is the "other process" that
	// changes the file out from under storeB.
	await addText(storeA, {
		projectId: project.metadata.id,
		content: "from store A",
		startTime: 0,
		durationSeconds: 1,
	});

	// storeB, still holding its now-stale cached copy, tries to edit and
	// save — this must be rejected, not silently clobber storeA's edit.
	await assert.rejects(
		addText(storeB, {
			projectId: project.metadata.id,
			content: "from store B",
			startTime: 1,
			durationSeconds: 1,
		}),
		/modified elsewhere/,
		"a stale save from a second store should be rejected, not silently overwrite",
	);

	// storeA's edit survived on disk, untouched by storeB's rejected save.
	const onDisk = await getProjectState(storeA, project.metadata.id);
	assert.equal(onDisk.scenes[0]?.tracks.overlay[0]?.elements.length, 1);
	assert.equal(
		(onDisk.scenes[0]?.tracks.overlay[0]?.elements[0] as { params: { content: string } }).params
			.content,
		"from store A",
	);

	console.log("\nAll conflict.test.ts checks PASSED");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
