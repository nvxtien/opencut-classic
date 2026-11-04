import { createCanvas } from "@napi-rs/canvas";
import type { Project, Scene } from "@opencut/project-schema";
import { composeFrame } from "./compositor";
import type { FrameSource } from "./decode";
import { openFrameEncoder } from "./encode";
import { mediaTimeFromSeconds } from "./time";

export interface RenderProjectParams {
	project: Project;
	scene: Scene;
	mediaPaths: Record<string, string>;
	outputPath: string;
	/** Render FPS. MVP simplification: taken as a plain number, not
	 * `project.settings.fps` (a numerator/denominator pair) — see
	 * `docs/mcp-headless.md` §5 for non-integer frame rates (23.976 etc). */
	fps: number;
	/** Total render duration in seconds. A real orchestrator would derive
	 * this from the scene's elements (last element's end time); the MVP
	 * takes it explicitly so a test can render a short window without
	 * needing a full scene-duration calculator yet. */
	durationSeconds: number;
}

export interface RenderProjectResult {
	outputPath: string;
	frameCount: number;
}

export async function renderProject({
	project,
	scene,
	mediaPaths,
	outputPath,
	fps,
	durationSeconds,
}: RenderProjectParams): Promise<RenderProjectResult> {
	const { width, height } = project.settings.canvasSize;
	const encoder = openFrameEncoder({ outputPath, width, height, fps });
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext("2d");
	// One decode process per element (opened lazily, the first frame that
	// needs it), reused across every frame that element is active for —
	// see the doc comment on `ComposeFrameParams.decoders`.
	const decoders = new Map<string, FrameSource>();

	const frameCount = Math.max(1, Math.round(durationSeconds * fps));
	try {
		for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
			const timeSeconds = frameIndex / fps;
			const time = mediaTimeFromSeconds(timeSeconds);
			await composeFrame({ project, scene, time, mediaPaths, fps, decoders, ctx });
			await encoder.writeFrame(canvas.data());
		}
		await encoder.finish();
	} finally {
		for (const source of decoders.values()) source.close();
	}

	return { outputPath, frameCount };
}
