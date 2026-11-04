import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaTime, Project, Scene } from "@opencut/project-schema";
import { renderProject } from "../src/index";

const workDir = mkdtempSync(join(tmpdir(), "headless-render-test-"));
const sourceVideoPath = join(workDir, "source.mp4");
const outputPath = join(workDir, "output.mp4");

/**
 * A short synthetic source clip (ffmpeg `testsrc`) standing in for a real
 * upload. Media ingestion (`add_media`) is Phase 3 — this test only needs a
 * real, decodable file on disk.
 */
execFileSync("ffmpeg", [
	"-y",
	"-f",
	"lavfi",
	"-i",
	"testsrc=size=320x180:rate=10:duration=2",
	sourceVideoPath,
]);

/** Mirrors the shape `create_project` + `add_clip` + `add_text` (Phase 3 MCP tools) will build. */
function sampleProject(): Project {
	const now = new Date();
	return {
		metadata: {
			id: "proj_1",
			name: "Phase 2 smoke test",
			duration: 180_000 as MediaTime,
			createdAt: now,
			updatedAt: now,
		},
		scenes: [
			{
				id: "scene_1",
				name: "Main",
				isMain: true,
				tracks: {
					main: {
						id: "track_main",
						name: "Video",
						type: "video",
						muted: false,
						hidden: false,
						elements: [
							{
								id: "el_1",
								name: "source.mp4",
								type: "video",
								mediaId: "media_1",
								duration: 180_000 as MediaTime,
								startTime: 0 as MediaTime,
								trimStart: 0 as MediaTime,
								trimEnd: 180_000 as MediaTime,
								params: {},
							},
						],
					},
					overlay: [
						{
							id: "track_text",
							name: "Caption",
							type: "text",
							hidden: false,
							elements: [
								{
									id: "el_2",
									name: "Caption",
									type: "text",
									duration: 180_000 as MediaTime,
									startTime: 0 as MediaTime,
									trimStart: 0 as MediaTime,
									trimEnd: 180_000 as MediaTime,
									params: {
										content: "OpenCut headless Phase 2",
										fontSize: 28,
										color: "#f4e3d6",
									},
								},
							],
						},
					],
					audio: [],
				},
				bookmarks: [],
				createdAt: now,
				updatedAt: now,
			},
		],
		currentSceneId: "scene_1",
		settings: {
			fps: { numerator: 10, denominator: 1 },
			canvasSize: { width: 320, height: 180 },
			background: { type: "color", color: "#1c1b19" },
		},
		version: 1,
	};
}

async function main() {
	const project = sampleProject();
	const scene = project.scenes[0] as Scene;

	const result = await renderProject({
		project,
		scene,
		mediaPaths: { media_1: sourceVideoPath },
		outputPath,
		fps: 10,
		durationSeconds: 1.5,
	});

	assert.equal(result.outputPath, outputPath);
	assert.equal(result.frameCount, 15);
	assert.ok(existsSync(outputPath), "output.mp4 was not written");

	const probe = execFileSync("ffprobe", [
		"-v",
		"error",
		"-select_streams",
		"v:0",
		"-show_entries",
		"stream=width,height,nb_frames,codec_name",
		"-of",
		"json",
		outputPath,
	]).toString("utf8");
	const probeData = JSON.parse(probe);
	const stream = probeData.streams[0];

	assert.equal(stream.codec_name, "h264");
	assert.equal(stream.width, 320);
	assert.equal(stream.height, 180);
	assert.equal(Number(stream.nb_frames), 15);

	console.log(
		JSON.stringify(
			{ outputPath, frameCount: result.frameCount, probe: stream },
			null,
			2,
		),
	);
	console.log("\nAll checks PASSED");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
