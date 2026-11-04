import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import type {
	CanvasSize,
	MediaTime,
	ParamValues,
	Project,
	Scene,
} from "@opencut/project-schema";
import { decodeFramePng } from "./decode";
import type { ResolvedFrame } from "./scene";
import { resolveFrame } from "./scene";

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
}

export async function composeFrame({
	project,
	scene,
	time,
	mediaPaths,
}: ComposeFrameParams): Promise<Buffer> {
	const { width, height } = project.settings.canvasSize;
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext("2d");

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
		const sourcePath = mediaPaths[resolved.mainVideo.element.mediaId];
		if (!sourcePath) {
			throw new Error(
				`composeFrame: no media path for mediaId=${resolved.mainVideo.element.mediaId}`,
			);
		}
		const framePng = await decodeFramePng({
			sourcePath,
			atSeconds: resolved.mainVideo.localSeconds,
			width,
			height,
		});
		const image = await loadImage(framePng);
		ctx.drawImage(image, 0, 0, width, height);
	}

	drawTextOverlays({ ctx, canvasSize: { width, height }, resolved });

	return canvas.data();
}
