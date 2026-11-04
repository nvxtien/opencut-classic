import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addClip, addMedia, createProject, trimClip } from "../src/tools";
import { ProjectStore } from "../src/store";

/**
 * Regression tests for two bugs found by a correctness review:
 *
 * 1. `trimClip` didn't check `trimEnd` against the source media's actual
 *    duration — a trim past the real file length only failed later, at
 *    render time, with a confusing "frame source exhausted" error instead
 *    of a clear one here.
 * 2. `addClip` with an explicit `startTime` could overlap an existing
 *    clip on the main track; `resolveFrame` silently picks whichever
 *    element comes first, so the new clip was added successfully and then
 *    never actually rendered, with nothing telling the caller why.
 */
async function main() {
	const workDir = mkdtempSync(join(tmpdir(), "correctness-test-"));
	const sourcePath = join(workDir, "source.mp4");
	execFileSync("ffmpeg", [
		"-y",
		"-f",
		"lavfi",
		"-i",
		"testsrc2=size=320x180:rate=10:duration=3",
		sourcePath,
	]);

	const store = new ProjectStore(mkdtempSync(join(tmpdir(), "correctness-store-")));
	const project = await createProject(store, { name: "Correctness test", width: 320, height: 180 });
	const media = await addMedia(store, { projectId: project.metadata.id, filePath: sourcePath });

	// --- Bug 1: trim past the source's real duration ---
	const firstClip = await addClip(store, { projectId: project.metadata.id, mediaId: media.mediaId });
	await assert.rejects(
		trimClip(store, {
			projectId: project.metadata.id,
			elementId: firstClip.id,
			trimEndSeconds: 10, // source is only 3s
		}),
		/past the source media's duration/,
		"trimClip should reject a trimEnd past the real media duration",
	);

	// --- Bug 2: addClip overlapping an existing clip ---
	await assert.rejects(
		addClip(store, {
			projectId: project.metadata.id,
			mediaId: media.mediaId,
			startTime: 1, // overlaps firstClip, which spans 0s..3s
		}),
		/would overlap element/,
		"addClip should reject a startTime that overlaps an existing clip",
	);

	// A non-overlapping explicit startTime (right after the first clip) is
	// still fine — the fix shouldn't reject legitimate placements.
	const secondClip = await addClip(store, {
		projectId: project.metadata.id,
		mediaId: media.mediaId,
		startTime: 3,
	});
	assert.equal(secondClip.startTime, firstClip.duration);

	console.log("\nAll correctness.test.ts checks PASSED");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
