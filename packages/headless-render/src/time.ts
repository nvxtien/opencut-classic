import type { MediaTime } from "@opencut/project-schema";

/**
 * Mirrors `rust/crates/time/src/media_time.rs::TICKS_PER_SECOND`. Duplicated
 * here rather than imported from `opencut-wasm` because this package runs
 * native (no wasm runtime) — see `@opencut/project-schema`'s `media-time.ts`
 * for the same reasoning. If the Rust constant ever changes, both copies
 * need updating; there is no single source of truth across the wasm/native
 * boundary yet.
 */
export const TICKS_PER_SECOND = 120_000;

export function secondsFromMediaTime(time: MediaTime): number {
	return time / TICKS_PER_SECOND;
}

export function mediaTimeFromSeconds(seconds: number): MediaTime {
	return Math.round(seconds * TICKS_PER_SECOND) as MediaTime;
}
