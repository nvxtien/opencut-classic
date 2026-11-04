import { z } from "zod";

/**
 * Mirrors `apps/web/src/wasm/media-time.ts`: `MediaTime` is an integer tick
 * count (see `rust/crates/time/src/media_time.rs`), not a float-seconds value.
 * This package validates the shape only — it does not depend on `opencut-wasm`,
 * so no tick<->seconds conversion lives here. Callers that need conversion
 * import `mediaTimeFromSeconds`/`mediaTimeToSeconds` from `@/wasm` (web app)
 * or implement the native equivalent in the headless render orchestrator.
 */
export const MediaTimeSchema = z.number().int();
export type MediaTime = z.infer<typeof MediaTimeSchema>;

/**
 * Mirrors `rust/crates/time/src/frame_rate.rs::FrameRate` (`{ numerator,
 * denominator }` of `u32`). `denominator` of 0 is rejected here even though
 * the Rust struct allows constructing it — `ticks_per_frame()` treats it as
 * an invalid rate (returns `None`), so it's invalid data at the schema level.
 */
export const FrameRateSchema = z.object({
	numerator: z.number().int().positive(),
	denominator: z.number().int().positive(),
});
export type FrameRate = z.infer<typeof FrameRateSchema>;

export const CanvasSizeSchema = z.object({
	width: z.number().int().positive(),
	height: z.number().int().positive(),
});
export type CanvasSize = z.infer<typeof CanvasSizeSchema>;

export const BackgroundSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("color"), color: z.string() }),
	z.object({ type: z.literal("blur"), blurIntensity: z.number() }),
]);
export type Background = z.infer<typeof BackgroundSchema>;
