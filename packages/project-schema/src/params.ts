import { z } from "zod";

/** Mirrors `apps/web/src/params/index.ts::ParamValue` / `ParamValues`. */
export const ParamValueSchema = z.union([z.number(), z.string(), z.boolean()]);
export type ParamValue = z.infer<typeof ParamValueSchema>;

export const ParamValuesSchema = z.record(ParamValueSchema);
export type ParamValues = z.infer<typeof ParamValuesSchema>;

/** Mirrors `apps/web/src/effects/types.ts::Effect`. */
export const EffectSchema = z.object({
	id: z.string(),
	type: z.string(),
	params: ParamValuesSchema,
	enabled: z.boolean(),
});
export type Effect = z.infer<typeof EffectSchema>;

/**
 * `apps/web/src/masks/types.ts` defines ~350 lines of mask geometry
 * (freeform paths, built-in shapes, feather, per-mask params) that no MVP
 * tool constructs or reads yet. Validated structurally once a mask-authoring
 * tool exists; until then this is an intentional escape hatch so a full
 * project (e.g. round-tripped through `get_project_state`) isn't rejected
 * for carrying mask data the MVP doesn't touch.
 */
export const MaskSchema = z.unknown();
export type Mask = z.infer<typeof MaskSchema>;

/**
 * Same reasoning as `MaskSchema`: `apps/web/src/animation/types.ts` models a
 * full keyframe/bezier animation system not in the MVP's write path.
 */
export const ElementAnimationsSchema = z.unknown();
export type ElementAnimations = z.infer<typeof ElementAnimationsSchema>;
