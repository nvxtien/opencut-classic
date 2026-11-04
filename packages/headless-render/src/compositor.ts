import { ImageData, type SKRSContext2D } from "@napi-rs/canvas";
import type {
	CanvasSize,
	MediaTime,
	ParamValues,
	Project,
	Scene,
} from "@opencut/project-schema";
import { openFrameSource, type FrameSource } from "./decode";
import type { ResolvedFrame } from "./scene";
import { resolveFrame } from "./scene";
import { secondsFromMediaTime } from "./time";

/**
 * Minimal subset of `TextElement.params` this MVP reads. The real app's
 * text system (`apps/web/src/text/`) supports far more (font family/weight/
 * style, background box, alignment, animated transform) — see
 * `docs/mcp-headless.md` §5. Unsupported params are silently ignored rather
 * than erroring, so a project with richer text still renders, just without
 * the extra styling.
 */
function readTextParams(params: ParamValues) {
	return {
		content: typeof params.content === "string" ? params.content : "",
		fontSize: typeof params.fontSize === "number" ? params.fontSize : 48,
		color: typeof params.color === "string" ? params.color : "#ffffff",
	};
}

function drawTextOverlays({
	ctx,
	canvasSize,
	resolved,
}: {
	ctx: SKRSContext2D;
	canvasSize: CanvasSize;
	resolved: ResolvedFrame;
}): void {
	for (const overlay of resolved.textOverlays) {
		const { content, fontSize, color } = readTextParams(
			overlay.element.params,
		);
		if (!content) continue;
		ctx.save();
		ctx.font = `600 ${fontSize}px "Arial", sans-serif`;
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillStyle = color;
		ctx.fillText(content, canvasSize.width / 2, canvasSize.height / 2);
		ctx.restore();
	}
}

export interface ComposeFrameParams {
	project: Project;
	scene: Scene;
	time: MediaTime;
	/** Maps a timeline element's `mediaId` to a decodable local file path. Media ingestion (ffprobe, copying uploads into a content-addressed store) is Phase 3 (MCP `add_media`) work, not this package's job. */
	mediaPaths: Record<string, string>;
	/** Render frame rate — also the rate `FrameSource`s are asked to resample to, so consecutive frames of the same element line up exactly with consecutive calls here. */
	fps: number;
	/**
	 * One `FrameSource` per active element, opened (and its clip fully
	 * decoded) the first time that element is needed, then read frame by
	 * frame for the rest of the render — see `decode.ts` for why decoding
	 * happens fully up front rather than streamed alongside the encoder.
	 * Owned and closed by the caller (`render.ts`).
	 */
	decoders: Map<string, FrameSource>;
	/** Reused across frames rather than recreated each call — `ctx.fillRect` below already repaints the whole frame first, so there's no stale-pixel risk from reuse. */
	ctx: SKRSContext2D;
}

export async function composeFrame({
	project,
	scene,
	time,
	mediaPaths,
	fps,
	decoders,
	ctx,
}: ComposeFrameParams): Promise<void> {
	const { width, height } = project.settings.canvasSize;

	if (project.settings.background.type === "color") {
		ctx.fillStyle = project.settings.background.color;
	} else {
		// `blur` background needs a source frame to blur — not implemented in
		// the MVP orchestrator (see docs/mcp-headless.md §5). Falls back to
		// black rather than silently ignoring the setting.
		ctx.fillStyle = "#000000";
	}
	ctx.fillRect(0, 0, width, height);

	const resolved = resolveFrame({ scene, time });

	if (resolved.mainVideo) {
		const { element, localSeconds } = resolved.mainVideo;
		const sourcePath = mediaPaths[element.mediaId];
		if (!sourcePath) {
			throw new Error(`composeFrame: no media path for mediaId=${element.mediaId}`);
		}
		let source = decoders.get(element.id);
		if (!source) {
			const frameCount = Math.max(1, Math.round(secondsFromMediaTime(element.duration) * fps));
			source = openFrameSource({ sourcePath, startSeconds: localSeconds, frameCount, width, height, fps });
			decoders.set(element.id, source);
		}
		const rgba = await source.nextFrame();
		const imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
		ctx.putImageData(imageData, 0, 0);
	}

	drawTextOverlays({ ctx, canvasSize: { width, height }, resolved });
}
