import type {
	MediaTime,
	Scene,
	TextElement,
	VideoElement,
} from "@opencut/project-schema";
import { secondsFromMediaTime } from "./time";

export interface ResolvedTextOverlay {
	element: TextElement;
	/** Seconds since the element's own start, for animated params (unused in MVP). */
	localSeconds: number;
}

export interface ResolvedFrame {
	mainVideo: { element: VideoElement; localSeconds: number } | null;
	textOverlays: ResolvedTextOverlay[];
}

function isActiveAt({
	startTime,
	duration,
	time,
}: {
	startTime: MediaTime;
	duration: MediaTime;
	time: MediaTime;
}): boolean {
	return time >= startTime && time < startTime + duration;
}

/**
 * Resolves what's visible at a single point in time. MVP scope only: the
 * main track's video element (one video track, no stacked overlay video
 * clips) and `text`-type overlay tracks. Audio, image/sticker/graphic/effect
 * elements, retime, and animated params are out of scope — see
 * `docs/mcp-headless.md` §5.
 *
 * Paint order for overlays is the order of `scene.tracks.overlay` as given
 * (later entries drawn on top), matching how `SceneTracks.overlay` orders
 * tracks bottom-to-top. Not verified against the web app's actual paint
 * order — flag if a real project's overlay stacking looks wrong.
 */
export function resolveFrame({
	scene,
	time,
}: {
	scene: Scene;
	time: MediaTime;
}): ResolvedFrame {
	const mainElement = scene.tracks.main.elements.find(
		(element): element is VideoElement =>
			element.type === "video" &&
			isActiveAt({
				startTime: element.startTime,
				duration: element.duration,
				time,
			}),
	);

	const mainVideo = mainElement
		? {
				element: mainElement,
				localSeconds: secondsFromMediaTime(
					(mainElement.trimStart +
						(time - mainElement.startTime)) as MediaTime,
				),
			}
		: null;

	const textOverlays: ResolvedTextOverlay[] = [];
	for (const track of scene.tracks.overlay) {
		if (track.type !== "text") continue;
		for (const element of track.elements) {
			if (
				isActiveAt({
					startTime: element.startTime,
					duration: element.duration,
					time,
				})
			) {
				textOverlays.push({
					element,
					localSeconds: secondsFromMediaTime(
						(time - element.startTime) as MediaTime,
					),
				});
			}
		}
	}

	return { mainVideo, textOverlays };
}
