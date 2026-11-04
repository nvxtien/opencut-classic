import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addClip, addMedia, addText, createProject, exportVideo, getRenderStatus } from "../src/tools";
import { ProjectStore } from "../src/store";

/**
 * Regression test for the bug found by /ponytail-audit: export length used
 * to be "end of the main video track" only, silently dropping any text
 * overlay that starts after the last video clip ends.
 */
async function main() {
	const workDir = mkdtempSync(join(tmpdir(), "overlay-duration-test-"));
	const sourcePath = join(workDir, "source.mp4");
	const outputPath = join(workDir, "output.mp4");

	// A 1-second clip...
	execFileSync("ffmpeg", [
		"-y",
		"-f",
		"lavfi",
		"-i",
		"testsrc2=size=320x180:rate=10:duration=1",
		sourcePath,
	]);

	const store = new ProjectStore(mkdtempSync(join(tmpdir(), "overlay-duration-store-")));
	const project = await createProject(store, {
		name: "Overlay duration test",
		width: 320,
		height: 180,
		fpsNumerator: 10,
		fpsDenominator: 1,
	});
	const media = await addMedia(store, { projectId: project.metadata.id, filePath: sourcePath });
	await addClip(store, { projectId: project.metadata.id, mediaId: media.mediaId });
	// ...with text that only starts after the clip has already ended.
	await addText(store, {
		projectId: project.metadata.id,
		content: "late overlay",
		startTime: 2,
		durationSeconds: 1,
	});

	const { jobId } = await exportVideo(store, { projectId: project.metadata.id, outputPath });
	let status = getRenderStatus(store, jobId);
	const deadline = Date.now() + 30_000;
	while (status.status !== "done" && status.status !== "error") {
		if (Date.now() > deadline) throw new Error("render job did not finish within 30s");
		await new Promise((r) => setTimeout(r, 100));
		status = getRenderStatus(store, jobId);
	}
	if (status.status === "error") throw new Error(`render job failed: ${status.error}`);

	const probe = JSON.parse(
		execFileSync("ffprobe", [
			"-v",
			"error",
			"-show_entries",
			"format=duration",
			"-of",
			"json",
			outputPath,
		]).toString("utf8"),
	);
	const durationSeconds = Number(probe.format.duration);
	assert.ok(
		durationSeconds >= 2.9,
		`export should cover the text overlay ending at 3s, got only ${durationSeconds}s`,
	);

	console.log(JSON.stringify({ durationSeconds }, null, 2));
	console.log("\nAll overlay-duration.test.ts checks PASSED");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
