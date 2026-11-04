import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addClip,
	addMedia,
	addText,
	createProject,
	deleteProject,
	exportVideo,
	getProjectState,
	getRenderStatus,
	listProjects,
	removeElement,
	splitClip,
	trimClip,
} from "../src/tools";
import { ProjectStore } from "../src/store";
import { mediaTimeFromSeconds } from "@opencut/headless-render";

/**
 * Exercises the full MVP core-editing flow through the tool functions
 * directly (no MCP transport — see `protocol.test.ts` for that), including
 * disk persistence: edits happen on one `ProjectStore`, then a second,
 * freshly-constructed `ProjectStore` pointed at the same data directory
 * (standing in for a server restart) reads the project back, lists it, and
 * exports from it — proving the project really round-trips through disk,
 * not just through the first store's in-memory cache.
 */
async function main() {
	const workDir = mkdtempSync(join(tmpdir(), "mcp-tools-test-"));
	const dataDir = join(workDir, "projects");
	const sourcePath = join(workDir, "source.mp4");
	const outputPath = join(workDir, "output.mp4");

	execFileSync("ffmpeg", [
		"-y",
		"-f",
		"lavfi",
		"-i",
		"testsrc=size=320x180:rate=10:duration=3",
		sourcePath,
	]);

	const store = new ProjectStore(dataDir);

	const project = await createProject(store, {
		name: "MCP tools smoke test",
		width: 320,
		height: 180,
		fpsNumerator: 10,
		fpsDenominator: 1,
	});
	assert.equal(project.scenes[0]?.tracks.main.elements.length, 0);

	const media = await addMedia(store, { projectId: project.metadata.id, filePath: sourcePath });
	assert.equal(media.width, 320);
	assert.equal(media.height, 180);
	assert.ok(media.durationSeconds > 2.9 && media.durationSeconds < 3.1);

	const clip = await addClip(store, { projectId: project.metadata.id, mediaId: media.mediaId });
	assert.equal(clip.startTime, 0);

	const { left, right } = await splitClip(store, {
		projectId: project.metadata.id,
		elementId: clip.id,
		atSeconds: 1.5,
	});
	assert.equal(left.id, clip.id);
	assert.notEqual(right.id, clip.id);

	const trimmed = await trimClip(store, {
		projectId: project.metadata.id,
		elementId: right.id,
		trimEndSeconds: 2.5,
	});
	assert.equal(trimmed.trimEnd, mediaTimeFromSeconds(2.5));
	assert.equal(trimmed.duration, mediaTimeFromSeconds(2.5) - trimmed.trimStart);

	const text = await addText(store, {
		projectId: project.metadata.id,
		content: "Phase 3 tools test",
		startTime: 0.2,
		durationSeconds: 1,
		fontSize: 24,
	});
	assert.equal(text.params.content, "Phase 3 tools test");

	const stateBeforeRemove = await getProjectState(store, project.metadata.id);
	assert.equal(stateBeforeRemove.scenes[0]?.tracks.main.elements.length, 2);
	assert.equal(stateBeforeRemove.scenes[0]?.tracks.overlay[0]?.elements.length, 1);

	const removedNonexistent = await removeElement(store, {
		projectId: project.metadata.id,
		elementId: "not-a-real-id",
	});
	assert.equal(removedNonexistent, false);

	// --- Persistence: a brand-new ProjectStore, same dataDir, empty cache ---
	// stands in for restarting the MCP server process.
	const restartedStore = new ProjectStore(dataDir);

	const summaries = await listProjects(restartedStore);
	const ourSummary = summaries.find((s) => s.id === project.metadata.id);
	assert.ok(ourSummary, "project missing from listProjects after a simulated restart");
	assert.equal(ourSummary.name, "MCP tools smoke test");

	const reloaded = await getProjectState(restartedStore, project.metadata.id);
	assert.equal(reloaded.scenes[0]?.tracks.main.elements.length, 2);
	assert.equal(reloaded.scenes[0]?.tracks.overlay[0]?.elements.length, 1);
	assert.equal(reloaded.metadata.name, "MCP tools smoke test");

	// Media is intentionally NOT persisted (see store.ts) — the reloaded
	// project's video element still references `media.mediaId`, so the
	// restarted store needs that id re-registered (same id, so export_video
	// can resolve it) before it can render. A real deployment would require
	// the agent to call add_media again after a restart for the same reason.
	restartedStore.media.set(media.mediaId, {
		id: media.mediaId,
		path: sourcePath,
		durationSeconds: media.durationSeconds,
		width: media.width,
		height: media.height,
		fps: media.fps,
	});

	const { jobId } = await exportVideo(restartedStore, {
		projectId: project.metadata.id,
		outputPath,
	});

	let status = getRenderStatus(restartedStore, jobId);
	const deadline = Date.now() + 30_000;
	while (status.status !== "done" && status.status !== "error") {
		if (Date.now() > deadline) {
			throw new Error("render job did not finish within 30s");
		}
		await new Promise((r) => setTimeout(r, 100));
		status = getRenderStatus(restartedStore, jobId);
	}

	if (status.status === "error") {
		throw new Error(`render job failed: ${status.error}`);
	}
	assert.equal(status.status, "done");
	assert.ok(existsSync(outputPath), "export_video did not produce an output file");

	const probe = JSON.parse(
		execFileSync("ffprobe", [
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_entries",
			"stream=width,height,codec_name",
			"-of",
			"json",
			outputPath,
		]).toString("utf8"),
	);
	assert.equal(probe.streams[0].codec_name, "h264");
	assert.equal(probe.streams[0].width, 320);
	assert.equal(probe.streams[0].height, 180);

	await deleteProject(restartedStore, project.metadata.id);
	await assert.rejects(
		getProjectState(restartedStore, project.metadata.id),
		/No project with id/,
	);
	await assert.rejects(
		deleteProject(restartedStore, project.metadata.id),
		/No project with id/,
		"deleting an already-deleted project should throw",
	);
	const summariesAfterDelete = await listProjects(restartedStore);
	assert.ok(
		!summariesAfterDelete.some((s) => s.id === project.metadata.id),
		"deleted project still appears in listProjects",
	);

	console.log(
		JSON.stringify(
			{
				projectId: project.metadata.id,
				mediaId: media.mediaId,
				splitInto: [left.id, right.id],
				textId: text.id,
				jobId,
				outputPath,
				finalProbe: probe.streams[0],
			},
			null,
			2,
		),
	);
	console.log("\nAll tools.test.ts checks PASSED");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
