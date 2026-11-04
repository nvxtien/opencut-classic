import { strict as assert } from "node:assert";
import { ProjectSchema } from "../src/index";

const results: { name: string; ok: boolean; detail?: string }[] = [];

function check(name: string, fn: () => void) {
	try {
		fn();
		results.push({ name, ok: true });
	} catch (err) {
		results.push({ name, ok: false, detail: String(err) });
	}
}

/**
 * A project an MVP agent tool-call sequence would produce: one video clip on
 * the main track, one text overlay. Mirrors the shape a real `create_project`
 * + `add_clip` + `add_text` call chain would build, not a synthetic edge case.
 */
function sampleProject() {
	const now = new Date("2026-11-04T08:00:00.000Z");
	return {
		metadata: {
			id: "proj_1",
			name: "Demo clip",
			duration: 150_000,
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
						type: "video" as const,
						muted: false,
						hidden: false,
						elements: [
							{
								id: "el_1",
								name: "clip.mp4",
								type: "video" as const,
								mediaId: "media_1",
								duration: 150_000,
								startTime: 0,
								trimStart: 0,
								trimEnd: 150_000,
								params: {},
							},
						],
					},
					overlay: [
						{
							id: "track_text",
							name: "Caption",
							type: "text" as const,
							hidden: false,
							elements: [
								{
									id: "el_2",
									name: "Hello",
									type: "text" as const,
									duration: 90_000,
									startTime: 10_000,
									trimStart: 0,
									trimEnd: 90_000,
									params: { content: "Hello OpenCut", fontSize: 48 },
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
			fps: { numerator: 30, denominator: 1 },
			canvasSize: { width: 1920, height: 1080 },
			background: { type: "color" as const, color: "#000000" },
		},
		version: 1,
	};
}

check("valid project parses", () => {
	const result = ProjectSchema.parse(sampleProject());
	assert.equal(result.metadata.id, "proj_1");
	assert.equal(result.scenes[0]?.tracks.main.elements.length, 1);
});

check("round-trips through JSON without data loss", () => {
	const parsed = ProjectSchema.parse(sampleProject());
	const roundTripped = ProjectSchema.parse(
		JSON.parse(JSON.stringify(parsed)),
	);
	assert.deepEqual(roundTripped, parsed);
});

check("rejects a fractional MediaTime (ticks must be integer)", () => {
	const bad = sampleProject();
	bad.metadata.duration = 150_000.5 as never;
	const result = ProjectSchema.safeParse(bad);
	assert.equal(result.success, false);
});

check("rejects a project with zero scenes", () => {
	const bad = sampleProject();
	bad.scenes = [];
	const result = ProjectSchema.safeParse(bad);
	assert.equal(result.success, false);
});

check("rejects an unknown track type", () => {
	const bad = sampleProject();
	// @ts-expect-error -- intentionally invalid for the negative test
	bad.scenes[0].tracks.overlay[0].type = "sticker-track";
	const result = ProjectSchema.safeParse(bad);
	assert.equal(result.success, false);
});

check("rejects frame rate with zero denominator", () => {
	const bad = sampleProject();
	bad.settings.fps = { numerator: 30, denominator: 0 };
	const result = ProjectSchema.safeParse(bad);
	assert.equal(result.success, false);
});

check("passes through unmodeled mask data on a video element (MVP escape hatch)", () => {
	const withMask = sampleProject();
	withMask.scenes[0]!.tracks.main.elements[0]! = {
		...withMask.scenes[0]!.tracks.main.elements[0]!,
		masks: [{ kind: "freeform", path: [[0, 0]], feather: 4 }],
	};
	const result = ProjectSchema.parse(withMask);
	assert.ok(Array.isArray((result.scenes[0]!.tracks.main.elements[0] as any).masks));
});

console.log(JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
	console.error(`\n${failed.length}/${results.length} check(s) FAILED`);
	process.exit(1);
} else {
	console.log(`\nAll ${results.length} checks PASSED`);
}
