import { z } from "zod";
import {
	BackgroundSchema,
	CanvasSizeSchema,
	FrameRateSchema,
	MediaTimeSchema,
} from "./media-time";
import { SceneSchema } from "./timeline";

/**
 * Mirrors `apps/web/src/project/types.ts::TProjectMetadata`, minus the
 * UI-only fields dropped per `docs/mcp-headless.md` §2.1: no
 * `timelineViewState` (zoom/scroll/playhead are editor view state, not
 * project data). `thumbnail`, if present, must be a durable reference (a
 * file path or `data:` URI) — the web app stores a `blob:` object URL here,
 * which is only valid for the tab that created it and never serializes
 * meaningfully outside the browser.
 */
export const ProjectMetadataSchema = z.object({
	id: z.string(),
	name: z.string(),
	thumbnail: z.string().optional(),
	duration: MediaTimeSchema,
	createdAt: z.coerce.date(),
	updatedAt: z.coerce.date(),
});
export type ProjectMetadata = z.infer<typeof ProjectMetadataSchema>;

/**
 * Mirrors `TProjectSettings`, minus `canvasSizeMode` / `lastCustomCanvasSize`
 * / `originalCanvasSize`: all three exist to drive the canvas-size picker UI
 * (remembering the last custom value, detecting "has the user diverged from
 * the source's native size") and have no render-path meaning.
 */
export const ProjectSettingsSchema = z.object({
	fps: FrameRateSchema,
	canvasSize: CanvasSizeSchema,
	background: BackgroundSchema,
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

/**
 * Mirrors `TProject`, minus `timelineViewState` (see `ProjectMetadataSchema`
 * doc comment — same reasoning, it's editor view state).
 */
export const ProjectSchema = z.object({
	metadata: ProjectMetadataSchema,
	scenes: z.array(SceneSchema).min(1),
	currentSceneId: z.string(),
	settings: ProjectSettingsSchema,
	version: z.number().int(),
});
export type Project = z.infer<typeof ProjectSchema>;
