import { z } from "zod";
import {
	BackgroundSchema,
	CanvasSizeSchema,
	FrameRateSchema,
	MediaTimeSchema,
	type CanvasSize,
	type FrameRate,
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
	// shortcut: `version` is written (always 1) but never read — there's no
	// migration path, so a future required-field change to this schema will
	// hard-fail ProjectSchema.parse() on every project saved under an older
	// shape instead of upgrading it. upgrade: once a real schema change is
	// needed, branch on `version` in ProjectStore.getProject (store.ts)
	// before calling ProjectSchema.parse, and migrate older shapes forward.
	version: z.number().int(),
});
export type Project = z.infer<typeof ProjectSchema>;

/**
 * Builds a valid, empty `Project`: one scene, one empty main video track, no
 * overlays. This is the canonical shape of "a brand-new project" — the data
 * layer's own concern, not the MCP tool layer's (`@opencut/mcp-server`'s
 * `create_project` tool is its only caller today, but any future consumer
 * that needs to create a project should import this rather than re-build
 * the shape by hand). Id generation stays the caller's choice (how ids are
 * minted is an infra decision, not a data-shape one).
 */
export function createEmptyProject({
	id,
	sceneId,
	mainTrackId,
	name,
	canvasSize,
	fps,
	backgroundColor,
	now,
}: {
	id: string;
	sceneId: string;
	mainTrackId: string;
	name: string;
	canvasSize: CanvasSize;
	fps: FrameRate;
	backgroundColor: string;
	now: Date;
}): Project {
	return ProjectSchema.parse({
		metadata: {
			id,
			name,
			duration: 0,
			createdAt: now,
			updatedAt: now,
		},
		scenes: [
			{
				id: sceneId,
				name: "Main",
				isMain: true,
				tracks: {
					main: {
						id: mainTrackId,
						name: "Video",
						type: "video",
						muted: false,
						hidden: false,
						elements: [],
					},
					overlay: [],
					audio: [],
				},
				bookmarks: [],
				createdAt: now,
				updatedAt: now,
			},
		],
		currentSceneId: sceneId,
		settings: {
			fps,
			canvasSize,
			background: { type: "color", color: backgroundColor },
		},
		version: 1,
	});
}
