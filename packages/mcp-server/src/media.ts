import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProbedMedia {
	durationSeconds: number;
	width: number;
	height: number;
	fps: number;
}

function parseFrameRate(rFrameRate: string): number {
	const [num, den] = rFrameRate.split("/").map(Number);
	if (!num || !den) return 30;
	return num / den;
}

/** Shells out to `ffprobe` (same decision as `@opencut/headless-render`'s use of `ffmpeg`: see docs/mcp-headless.md §2.4) to read real media metadata rather than trusting whatever the caller claims. */
export async function probeMedia(filePath: string): Promise<ProbedMedia> {
	const { stdout } = await execFileAsync("ffprobe", [
		"-v",
		"error",
		"-select_streams",
		"v:0",
		"-show_entries",
		"stream=width,height,r_frame_rate:format=duration",
		"-of",
		"json",
		filePath,
	]);
	const data = JSON.parse(stdout) as {
		streams: Array<{ width: number; height: number; r_frame_rate: string }>;
		format: { duration: string };
	};
	const stream = data.streams[0];
	if (!stream) {
		throw new Error(`probeMedia: no video stream found in "${filePath}"`);
	}
	const durationSeconds = Number(data.format.duration);
	if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
		// ffprobe reports duration as "N/A" for some containers — trusting that
		// as-is turns into a stored NaN (JSON.stringify writes `null`), which
		// then fails Zod validation the next time the project is loaded.
		throw new Error(
			`probeMedia: ffprobe returned an unusable duration ("${data.format.duration}") for "${filePath}"`,
		);
	}
	return {
		durationSeconds,
		width: stream.width,
		height: stream.height,
		fps: parseFrameRate(stream.r_frame_rate),
	};
}
