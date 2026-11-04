import type {
	ImageElement,
	MediaTime,
	Project,
	Scene,
	TextElement,
	VideoElement,
} from "@opencut/project-schema";
import { createEmptyProject } from "@opencut/project-schema";
import {
	mediaTimeFromSeconds,
	renderProject,
	secondsFromMediaTime,
} from "@opencut/headless-render";
import { probeMedia } from "./media";
import { nextId, type ProjectStore, type ProjectSummary } from "./store";

/**
 * Tool logic as plain functions over `ProjectStore`, separate from MCP wire
 * format. `server.ts` wires these to `@modelcontextprotocol/sdk`; tests call
 * them directly (`test/tools.test.ts`) without spinning up a transport,
 * and `test/protocol.test.ts` separately proves the SDK wiring itself works.
 *
 * Every public tool here takes/returns time in **seconds** (plain numbers)
 * — not `MediaTime` ticks — because that's what an agent reasons about
 * naturally. Conversion to the canonical integer-tick `Project` schema
 * happens at this boundary.
 *
 * All functions are async: `ProjectStore` lazy-loads a project from disk on
 * first use and write-throughs on every mutation (see `store.ts`).
 */

export interface CreateProjectInput {
	name: string;
	width?: number;
	height?: number;
	fpsNumerator?: number;
	fpsDenominator?: number;
	backgroundColor?: string;
}

export async function createProject(
	store: ProjectStore,
	input: CreateProjectInput,
): Promise<Project> {
	const project = createEmptyProject({
		id: nextId("proj"),
		sceneId: nextId("scene"),
		mainTrackId: nextId("track"),
		name: input.name,
		canvasSize: { width: input.width ?? 1920, height: input.height ?? 1080 },
		fps: { numerator: input.fpsNumerator ?? 30, denominator: input.fpsDenominator ?? 1 },
		backgroundColor: input.backgroundColor ?? "#000000",
		now: new Date(),
	});
	await store.saveProject(project);
	return project;
}

export interface AddMediaInput {
	projectId: string;
	filePath: string;
}

export interface AddMediaResult {
	mediaId: string;
	durationSeconds: number;
	width: number;
	height: number;
	fps: number;
}

export async function addMedia(
	store: ProjectStore,
	input: AddMediaInput,
): Promise<AddMediaResult> {
	await store.getProject(input.projectId); // validates the project exists
	const probed = await probeMedia(input.filePath);
	const mediaId = nextId("media");
	store.media.set(mediaId, { id: mediaId, path: input.filePath, ...probed });
	return { mediaId, ...probed };
}

function mainScene(project: Project): Scene {
	const scene = project.scenes.find((s) => s.id === project.currentSceneId);
	if (!scene) {
		throw new Error(
			`Project "${project.metadata.id}" has no scene matching currentSceneId`,
		);
	}
	return scene;
}

function endOfMainTrack(scene: Scene): MediaTime {
	let end = 0 as MediaTime;
	for (const element of scene.tracks.main.elements) {
		const elementEnd = (element.startTime + element.duration) as MediaTime;
		if (elementEnd > end) end = elementEnd;
	}
	return end;
}

/** Like `endOfMainTrack`, but also considers overlay tracks (text etc.) — used wherever the real end of the scene matters (export length, displayed duration), as opposed to `endOfMainTrack`, which `addClip` uses on purpose to place new video clips after the last video clip specifically. */
function endOfScene(scene: Scene): MediaTime {
	let end = endOfMainTrack(scene);
	for (const track of scene.tracks.overlay) {
		for (const element of track.elements) {
			const elementEnd = (element.startTime + element.duration) as MediaTime;
			if (elementEnd > end) end = elementEnd;
		}
	}
	return end;
}

/** Updates derived metadata and write-throughs the project to disk. The one place every mutating tool funnels through before returning. */
async function touchAndSave(store: ProjectStore, project: Project): Promise<void> {
	project.metadata.updatedAt = new Date();
	project.metadata.duration = endOfScene(mainScene(project));
	await store.saveProject(project);
}

export interface AddClipInput {
	projectId: string;
	mediaId: string;
	/** Seconds. Defaults to the end of the main track (sequential placement). */
	startTime?: number;
}

export async function addClip(
	store: ProjectStore,
	input: AddClipInput,
): Promise<VideoElement> {
	const project = await store.getProject(input.projectId);
	const media = store.getMediaOrThrow(input.mediaId);
	const scene = mainScene(project);

	const startTime =
		input.startTime !== undefined
			? mediaTimeFromSeconds(input.startTime)
			: endOfMainTrack(scene);
	const duration = mediaTimeFromSeconds(media.durationSeconds);
	const endTime = (startTime + duration) as MediaTime;

	// Only reachable with an explicit `startTime` — the default (end of the
	// main track) can't overlap anything by construction. Without this,
	// `resolveFrame` (headless-render/src/scene.ts) silently picks whichever
	// overlapping element comes first in the array; the new clip would be
	// added successfully and then never actually render, with nothing
	// telling the caller why.
	const overlapping = scene.tracks.main.elements.find(
		(el) => startTime < el.startTime + el.duration && endTime > el.startTime,
	);
	if (overlapping) {
		throw new Error(
			`addClip: startTime=${input.startTime}s would overlap element "${overlapping.id}" ` +
				`(${secondsFromMediaTime(overlapping.startTime)}s .. ${secondsFromMediaTime((overlapping.startTime + overlapping.duration) as MediaTime)}s) ` +
				"on the main track",
		);
	}

	const element: VideoElement = {
		id: nextId("el"),
		name: media.path.split("/").pop() ?? media.path,
		type: "video",
		mediaId: media.id,
		duration,
		startTime,
		trimStart: 0 as MediaTime,
		trimEnd: duration,
		params: {},
	};
	scene.tracks.main.elements.push(element);
	scene.tracks.main.elements.sort((a, b) => a.startTime - b.startTime);
	await touchAndSave(store, project);
	return element;
}

export interface SplitClipInput {
	projectId: string;
	elementId: string;
	/** Seconds, absolute timeline position. Must fall strictly inside the element. */
	atSeconds: number;
}

export interface SplitClipResult {
	left: VideoElement | ImageElement;
	right: VideoElement | ImageElement;
}

export async function splitClip(
	store: ProjectStore,
	input: SplitClipInput,
): Promise<SplitClipResult> {
	const project = await store.getProject(input.projectId);
	const scene = mainScene(project);
	const elements = scene.tracks.main.elements;
	const index = elements.findIndex((el) => el.id === input.elementId);
	if (index === -1) {
		throw new Error(`No element "${input.elementId}" on the main track`);
	}
	// Main-track elements are always video or image (see `VideoTrackSchema`),
	// never a bare cast to one specific type — splitting an image clip is
	// just as valid as splitting a video clip.
	const original = elements[index] as VideoElement | ImageElement;
	const at = mediaTimeFromSeconds(input.atSeconds);
	if (at <= original.startTime || at >= original.startTime + original.duration) {
		throw new Error(
			`splitClip: atSeconds=${input.atSeconds} is not strictly inside element "${original.id}" ` +
				`(${secondsFromMediaTime(original.startTime)}s .. ${secondsFromMediaTime((original.startTime + original.duration) as MediaTime)}s)`,
		);
	}

	const leftDuration = (at - original.startTime) as MediaTime;
	const rightDuration = (original.duration - leftDuration) as MediaTime;

	const left: VideoElement | ImageElement = {
		...original,
		duration: leftDuration,
		trimEnd: (original.trimStart + leftDuration) as MediaTime,
	};
	const right: VideoElement | ImageElement = {
		...original,
		id: nextId("el"),
		startTime: at,
		duration: rightDuration,
		trimStart: (original.trimStart + leftDuration) as MediaTime,
	};

	elements.splice(index, 1, left, right);
	await touchAndSave(store, project);
	return { left, right };
}

export interface TrimClipInput {
	projectId: string;
	elementId: string;
	/** Seconds, both optional — only the given side moves. */
	trimStartSeconds?: number;
	trimEndSeconds?: number;
}

export async function trimClip(
	store: ProjectStore,
	input: TrimClipInput,
): Promise<VideoElement> {
	const project = await store.getProject(input.projectId);
	const scene = mainScene(project);
	const element = scene.tracks.main.elements.find(
		(el): el is VideoElement =>
			el.type === "video" && el.id === input.elementId,
	);
	if (!element) {
		throw new Error(`No video element "${input.elementId}" on the main track`);
	}

	const trimStart =
		input.trimStartSeconds !== undefined
			? mediaTimeFromSeconds(input.trimStartSeconds)
			: element.trimStart;
	const trimEnd =
		input.trimEndSeconds !== undefined
			? mediaTimeFromSeconds(input.trimEndSeconds)
			: element.trimEnd;
	if (trimEnd <= trimStart) {
		throw new Error("trimClip: trimEnd must be greater than trimStart");
	}
	// Without this, a trimEnd past the real file length is only caught at
	// render time: the decoder asks ffmpeg for more frames than the source
	// has, and the render job fails with a confusing "frame source
	// exhausted" error instead of a clear one here, at the call that
	// actually caused it.
	const sourceDuration = mediaTimeFromSeconds(
		store.getMediaOrThrow(element.mediaId).durationSeconds,
	);
	if (trimEnd > sourceDuration) {
		throw new Error(
			`trimClip: trimEndSeconds=${secondsFromMediaTime(trimEnd)} is past the source media's ` +
				`duration (${secondsFromMediaTime(sourceDuration)}s)`,
		);
	}

	element.trimStart = trimStart as MediaTime;
	element.trimEnd = trimEnd as MediaTime;
	element.duration = (trimEnd - trimStart) as MediaTime;
	await touchAndSave(store, project);
	return element;
}

export interface AddTextInput {
	projectId: string;
	content: string;
	/** Seconds. */
	startTime: number;
	durationSeconds: number;
	fontSize?: number;
	color?: string;
}

export async function addText(
	store: ProjectStore,
	input: AddTextInput,
): Promise<TextElement> {
	const project = await store.getProject(input.projectId);
	const scene = mainScene(project);

	let textTrack = scene.tracks.overlay.find((t) => t.type === "text");
	if (!textTrack) {
		textTrack = {
			id: nextId("track"),
			name: "Text",
			type: "text",
			hidden: false,
			elements: [],
		};
		scene.tracks.overlay.push(textTrack);
	}

	const element: TextElement = {
		id: nextId("el"),
		name: input.content.slice(0, 40),
		type: "text",
		duration: mediaTimeFromSeconds(input.durationSeconds),
		startTime: mediaTimeFromSeconds(input.startTime),
		trimStart: 0 as MediaTime,
		trimEnd: mediaTimeFromSeconds(input.durationSeconds),
		params: {
			content: input.content,
			fontSize: input.fontSize ?? 48,
			color: input.color ?? "#ffffff",
		},
	};
	textTrack.elements.push(element);
	await touchAndSave(store, project);
	return element;
}

export interface RemoveElementInput {
	projectId: string;
	elementId: string;
}

export async function removeElement(
	store: ProjectStore,
	input: RemoveElementInput,
): Promise<boolean> {
	const project = await store.getProject(input.projectId);
	const scene = mainScene(project);

	const mainIndex = scene.tracks.main.elements.findIndex(
		(el) => el.id === input.elementId,
	);
	if (mainIndex !== -1) {
		scene.tracks.main.elements.splice(mainIndex, 1);
		await touchAndSave(store, project);
		return true;
	}
	for (const track of scene.tracks.overlay) {
		const index = track.elements.findIndex((el) => el.id === input.elementId);
		if (index !== -1) {
			track.elements.splice(index, 1);
			await touchAndSave(store, project);
			return true;
		}
	}
	return false;
}

export async function getProjectState(
	store: ProjectStore,
	projectId: string,
): Promise<Project> {
	return store.getProject(projectId);
}

/** Lists every project persisted to disk, for an agent to choose from before calling `get_project_state`/`export_video`/etc. */
export async function listProjects(store: ProjectStore): Promise<ProjectSummary[]> {
	return store.listProjects();
}

/**
 * Deletes a project from disk and the in-memory cache. Does not touch any
 * render job or output file already produced by `export_video` for it, and
 * does not remove its `media` records (other projects may reference the
 * same `mediaId` — media is not currently scoped per-project, see
 * `addMedia`).
 */
export async function deleteProject(
	store: ProjectStore,
	projectId: string,
): Promise<void> {
	await store.deleteProject(projectId); // throws "No project with id" if missing
}

export interface ExportVideoInput {
	projectId: string;
	outputPath: string;
}

/**
 * Starts a render job and returns immediately with a `jobId` — `export_video`
 * must not block the MCP connection for the duration of a render. Progress
 * is reported by `getRenderStatus` polling `store.jobs`.
 */
export async function exportVideo(
	store: ProjectStore,
	input: ExportVideoInput,
): Promise<{ jobId: string }> {
	const project = await store.getProject(input.projectId);
	const scene = mainScene(project);

	const mediaPaths: Record<string, string> = {};
	for (const element of scene.tracks.main.elements) {
		if (element.type !== "video") continue;
		mediaPaths[element.mediaId] = store.getMediaOrThrow(element.mediaId).path;
	}

	const durationSeconds = secondsFromMediaTime(endOfScene(scene));
	const fps = project.settings.fps.numerator / project.settings.fps.denominator;

	const jobId = nextId("job");
	store.jobs.set(jobId, {
		id: jobId,
		projectId: input.projectId,
		status: "queued",
		progress: 0,
	});

	// Fire-and-forget: the job map is the only channel back to the caller.
	void (async () => {
		const job = store.jobs.get(jobId);
		if (!job) return;
		job.status = "running";
		try {
			const result = await renderProject({
				project,
				scene,
				mediaPaths,
				outputPath: input.outputPath,
				fps,
				durationSeconds,
			});
			job.status = "done";
			job.progress = 1;
			job.outputPath = result.outputPath;
		} catch (err) {
			job.status = "error";
			job.error = err instanceof Error ? err.message : String(err);
		}
	})();

	return { jobId };
}

export function getRenderStatus(store: ProjectStore, jobId: string) {
	const job = store.jobs.get(jobId);
	if (!job) {
		throw new Error(`No render job "${jobId}"`);
	}
	return job;
}
