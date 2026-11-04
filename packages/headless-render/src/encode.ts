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

	// Set once, before `exitPromise` settles, so a `writeFrame` call waiting
	// on `close`/stdin `error` (below) always sees the real reason, not a
	// generic fallback. First error wins — a later EPIPE while we're still
	// unwinding from the original failure shouldn't overwrite the cause.
	let endedWith: Error | null = null;
	let spawnError: Error | null = null;
	function markEnded(err: Error): void {
		endedWith ??= err;
	}

	// Writing to a dead process's stdin raises EPIPE as an 'error' event on
	// the stream itself (separate from the ChildProcess's own 'error'/
	// 'close'). Node's default for an unhandled stream 'error' is to throw
	// and crash the whole process — found by the regression test below
	// (`write EPIPE` took down the Node process, not just this export).
	proc.stdin.on("error", (err) => markEnded(err));

	const exitPromise = new Promise<void>((resolve, reject) => {
		proc.on("close", (code) => {
			if (code !== 0) {
				const err = new Error(
					`ffmpeg encode exited ${code}: ${Buffer.concat(stderrChunks).toString("utf8").slice(-2000)}`,
				);
				markEnded(err);
				reject(endedWith ?? err);
				return;
			}
			resolve();
		});
		proc.on("error", (err) => {
			spawnError = err;
			markEnded(err);
			reject(err);
		});
	});
	// Observed by writeFrame/finish below; without this, an export that
	// fails before either is called (nothing written yet) logs an
	// unhandled-rejection warning for a promise nobody awaited in time.
	exitPromise.catch(() => {});

	return {
		writeFrame(rgba: Buffer): Promise<void> {
			if (spawnError) return Promise.reject(spawnError);
			if (endedWith) return Promise.reject(endedWith);
			if (proc.stdin.write(rgba)) return Promise.resolve();
			// Backpressure: wait for the stream to drain, but also give up if
			// the process closes or its stdin errors first (crash, disk full,
			// bad pixel data) — otherwise a dead process never drains and this
			// hangs forever.
			return new Promise((resolve, reject) => {
				const cleanup = () => {
					proc.stdin.off("drain", onDrain);
					proc.off("close", onEnd);
					proc.stdin.off("error", onEnd);
				};
				const onDrain = () => {
					cleanup();
					resolve();
				};
				const onEnd = (err?: Error) => {
					cleanup();
					reject(
						endedWith ??
							err ??
							new Error("ffmpeg encode process closed before accepting this frame"),
					);
				};
				proc.stdin.once("drain", onDrain);
				proc.once("close", onEnd);
				proc.stdin.once("error", onEnd);
			});
		},
		async finish(): Promise<void> {
			proc.stdin.end();
			await exitPromise;
		},
	};
}
