import { z } from "zod";
import { MediaTimeSchema } from "./media-time";
import {
	EffectSchema,
	ElementAnimationsSchema,
	MaskSchema,
	ParamValuesSchema,
} from "./params";

/** Mirrors `apps/web/src/timeline/types.ts::RetimeConfig`. */
export const RetimeConfigSchema = z.object({
	rate: z.number(),
	maintainPitch: z.boolean().optional(),
});
export type RetimeConfig = z.infer<typeof RetimeConfigSchema>;

/**
 * Shared base fields across every timeline element kind. Mirrors
 * `BaseTimelineElement` in `apps/web/src/timeline/types.ts`.
 *
 * `animations` is left as the passthrough `ElementAnimationsSchema` — see
 * `params.ts` for why.
 */
const BaseElementFields = {
	id: z.string(),
	name: z.string(),
	duration: MediaTimeSchema,
	startTime: MediaTimeSchema,
	trimStart: MediaTimeSchema,
	trimEnd: MediaTimeSchema,
	sourceDuration: MediaTimeSchema.optional(),
	animations: ElementAnimationsSchema.optional(),
	params: ParamValuesSchema,
};

export const UploadAudioElementSchema = z.object({
	...BaseElementFields,
	type: z.literal("audio"),
	sourceType: z.literal("upload"),
	mediaId: z.string(),
	retime: RetimeConfigSchema.optional(),
});

export const LibraryAudioElementSchema = z.object({
	...BaseElementFields,
	type: z.literal("audio"),
	sourceType: z.literal("library"),
	sourceUrl: z.string(),
	retime: RetimeConfigSchema.optional(),
});

export const AudioElementSchema = z.discriminatedUnion("sourceType", [
	UploadAudioElementSchema,
	LibraryAudioElementSchema,
]);
export type AudioElement = z.infer<typeof AudioElementSchema>;

export const VideoElementSchema = z.object({
	...BaseElementFields,
	type: z.literal("video"),
	mediaId: z.string(),
	isSourceAudioEnabled: z.boolean().optional(),
	hidden: z.boolean().optional(),
	retime: RetimeConfigSchema.optional(),
	effects: z.array(EffectSchema).optional(),
	masks: z.array(MaskSchema).optional(),
});
export type VideoElement = z.infer<typeof VideoElementSchema>;

export const ImageElementSchema = z.object({
	...BaseElementFields,
	type: z.literal("image"),
	mediaId: z.string(),
	hidden: z.boolean().optional(),
	effects: z.array(EffectSchema).optional(),
	masks: z.array(MaskSchema).optional(),
});
export type ImageElement = z.infer<typeof ImageElementSchema>;

export const TextElementSchema = z.object({
	...BaseElementFields,
	type: z.literal("text"),
	hidden: z.boolean().optional(),
	effects: z.array(EffectSchema).optional(),
	// `BaseTimelineElement.params` already carries text content/styling as
	// ParamValues (per `apps/web/src/text/`), so no separate `text` field here.
});
export type TextElement = z.infer<typeof TextElementSchema>;

export const StickerElementSchema = z.object({
	...BaseElementFields,
	type: z.literal("sticker"),
	stickerId: z.string(),
	intrinsicWidth: z.number().optional(),
	intrinsicHeight: z.number().optional(),
	hidden: z.boolean().optional(),
	effects: z.array(EffectSchema).optional(),
});
export type StickerElement = z.infer<typeof StickerElementSchema>;

export const GraphicElementSchema = z.object({
	...BaseElementFields,
	type: z.literal("graphic"),
	definitionId: z.string(),
	hidden: z.boolean().optional(),
	effects: z.array(EffectSchema).optional(),
	masks: z.array(MaskSchema).optional(),
});
export type GraphicElement = z.infer<typeof GraphicElementSchema>;

export const EffectElementSchema = z.object({
	...BaseElementFields,
	type: z.literal("effect"),
	effectType: z.string(),
});
export type EffectElement = z.infer<typeof EffectElementSchema>;

export const TimelineElementSchema = z.discriminatedUnion("type", [
	VideoElementSchema,
	ImageElementSchema,
	TextElementSchema,
	StickerElementSchema,
	GraphicElementSchema,
	EffectElementSchema,
	// AudioElement is excluded from this top-level discriminated union: it
	// discriminates on `sourceType`, not `type`, at the same tag value
	// ("audio"), which `z.discriminatedUnion` can't flatten. Track schemas
	// below validate audio elements via `AudioElementSchema` directly.
]);
export type VisualOrEffectTimelineElement = z.infer<
	typeof TimelineElementSchema
>;

const BaseTrackFields = {
	id: z.string(),
	name: z.string(),
};

export const VideoTrackSchema = z.object({
	...BaseTrackFields,
	type: z.literal("video"),
	elements: z.array(z.union([VideoElementSchema, ImageElementSchema])),
	muted: z.boolean(),
	hidden: z.boolean(),
});
export type VideoTrack = z.infer<typeof VideoTrackSchema>;

export const TextTrackSchema = z.object({
	...BaseTrackFields,
	type: z.literal("text"),
	elements: z.array(TextElementSchema),
	hidden: z.boolean(),
});
export type TextTrack = z.infer<typeof TextTrackSchema>;

export const AudioTrackSchema = z.object({
	...BaseTrackFields,
	type: z.literal("audio"),
	elements: z.array(AudioElementSchema),
	muted: z.boolean(),
});
export type AudioTrack = z.infer<typeof AudioTrackSchema>;

export const GraphicTrackSchema = z.object({
	...BaseTrackFields,
	type: z.literal("graphic"),
	elements: z.array(z.union([StickerElementSchema, GraphicElementSchema])),
	hidden: z.boolean(),
});
export type GraphicTrack = z.infer<typeof GraphicTrackSchema>;

export const EffectTrackSchema = z.object({
	...BaseTrackFields,
	type: z.literal("effect"),
	elements: z.array(EffectElementSchema),
	hidden: z.boolean(),
});
export type EffectTrack = z.infer<typeof EffectTrackSchema>;

export const OverlayTrackSchema = z.discriminatedUnion("type", [
	VideoTrackSchema,
	TextTrackSchema,
	GraphicTrackSchema,
	EffectTrackSchema,
]);
export type OverlayTrack = z.infer<typeof OverlayTrackSchema>;

/** Mirrors `apps/web/src/timeline/types.ts::SceneTracks`. */
export const SceneTracksSchema = z.object({
	overlay: z.array(OverlayTrackSchema),
	main: VideoTrackSchema,
	audio: z.array(AudioTrackSchema),
});
export type SceneTracks = z.infer<typeof SceneTracksSchema>;

/**
 * `Bookmark` is UI-only (timeline scrub markers, never read by the render
 * path) but is cheap to validate exactly, so it's modeled in full rather
 * than passed through.
 */
export const BookmarkSchema = z.object({
	time: MediaTimeSchema,
	note: z.string().optional(),
	color: z.string().optional(),
	duration: MediaTimeSchema.optional(),
});
export type Bookmark = z.infer<typeof BookmarkSchema>;

export const SceneSchema = z.object({
	id: z.string(),
	name: z.string(),
	isMain: z.boolean(),
	tracks: SceneTracksSchema,
	bookmarks: z.array(BookmarkSchema),
	createdAt: z.coerce.date(),
	updatedAt: z.coerce.date(),
});
export type Scene = z.infer<typeof SceneSchema>;
