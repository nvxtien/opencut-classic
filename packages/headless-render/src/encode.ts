import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export interface FrameEncoder {
	writeFrame(rgba: Buffer): Promise<void>;
	finish(): Promise<void>;
}

/**
 * Opens one ffmpeg process for the whole export and streams raw RGBA frames
 * into its stdin, muxed to H.264/mp4. One process reused across all frames
 * (unlike `decode.ts`, which spawns per frame) — this is the actual encode
 * path, so it's written the way a real render loop would.
 */
export function openFrameEncoder({
	outputPath,
	width,
	height,
	fps,
}: {
	outputPath: string;
	width: number;
	height: number;
	fps: number;
}): FrameEncoder {
	const args = [
		"-y",
		"-f",
		"rawvideo",
		"-pixel_format",
		"rgba",
		"-video_size",
		`${width}x${height}`,
		"-framerate",
		String(fps),
		"-i",
		"pipe:0",
		"-pix_fmt",
		"yuv420p",
		"-vcodec",
		"libx264",
		outputPath,
	];
	const proc: ChildProcessByStdio<Writable, null, Readable> = spawn("ffmpeg", args, {
		stdio: ["pipe", "ignore", "pipe"],
	});

	const stderrChunks: Buffer[] = [];
	proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

	let spawnError: Error | null = null;
	proc.on("error", (err) => {
		spawnError = err;
	});

	const exitPromise = new Promise<void>((resolve, reject) => {
		proc.on("close", (code) => {
			if (code !== 0) {
				reject(
					new Error(
						`ffmpeg encode exited ${code}: ${Buffer.concat(stderrChunks).toString("utf8").slice(-2000)}`,
					),
				);
				return;
			}
			resolve();
		});
		proc.on("error", reject);
	});

	return {
		writeFrame(rgba: Buffer): Promise<void> {
			if (spawnError) return Promise.reject(spawnError);
			return new Promise((resolve) => {
				if (!proc.stdin.write(rgba)) {
					proc.stdin.once("drain", resolve);
				} else {
					resolve();
				}
			});
		},
		async finish(): Promise<void> {
			proc.stdin.end();
			await exitPromise;
		},
	};
}
