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
	return {
		durationSeconds: Number(data.format.duration),
		width: stream.width,
		height: stream.height,
		fps: parseFrameRate(stream.r_frame_rate),
	};
}
