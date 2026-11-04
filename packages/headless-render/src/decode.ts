import { spawn } from "node:child_process";

export interface FrameSource {
	/**
	 * Returns the next frame as raw RGBA bytes (`width * height * 4`), in
	 * order — no seek. `render.ts` opens one `FrameSource` per element, the
	 * first time that element becomes active, and only ever asks it for its
	 * next frame as the render loop advances through that element's span.
	 */
	nextFrame(): Promise<Buffer>;
	close(): void;
}

/**
 * Opens a decoder for `frameCount` frames of `sourcePath` starting at
 * `startSeconds`, resampled to `fps` — one ffmpeg process per element
 * instead of one process per frame (found to be the dominant cost in a
 * performance review: ~32ms of the ~44ms/frame end-to-end render time was
 * ffmpeg process-spawn overhead, not actual decoding or compositing work).
 *
 * The whole clip is decoded into memory up front, on the first `nextFrame`
 * call, rather than streamed frame-by-frame as the encoder asks for them.
 * That costs memory (`width * height * 4 * frameCount` bytes, held until
 * `close()`) but turned out necessary, not just simpler: running the decode
 * process and the encoder's ffmpeg process at the same time, each decoding
 * real video content, measured *catastrophically* slower on this machine
 * than either one running alone — 15s for 120 frames interleaved vs. ~150ms
 * decode + ~200ms encode run one after the other. Not fully root-caused
 * (reads like resource contention between two concurrently-active ffmpeg
 * processes, specific to this environment); decoding fully before encoding
 * starts sidesteps it rather than explains it.
 *
 * `-r fps` on the output makes ffmpeg hand us frames already spaced at
 * exactly `1/fps` seconds — the same spacing `render.ts`'s frame loop asks
 * for, so no timestamp math is needed to line a decoded frame up with the
 * output frame that wants it.
 */
export function openFrameSource({
	sourcePath,
	startSeconds,
	frameCount,
	width,
	height,
	fps,
}: {
	sourcePath: string;
	startSeconds: number;
	/** How many frames this element will need over its whole active span — not just the one frame being requested right now. */
	frameCount: number;
	width: number;
	height: number;
	fps: number;
}): FrameSource {
	const frameSize = width * height * 4;
	let cursor = 0;
	let framesPromise: Promise<Buffer[]> | null = null;

	async function decodeAll(): Promise<Buffer[]> {
		const args = [
			"-ss",
			startSeconds.toFixed(6),
			"-i",
			sourcePath,
			"-vf",
			`scale=${width}:${height}`,
			"-r",
			String(fps),
			"-frames:v",
			String(frameCount),
			"-pix_fmt",
			"rgba",
			"-f",
			"rawvideo",
			"pipe:1",
		];
		const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
		proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

		await new Promise<void>((resolve, reject) => {
			proc.on("close", (code) => {
				if (code !== 0) {
					reject(
						new Error(
							`ffmpeg decode exited ${code}: ${Buffer.concat(stderrChunks).toString("utf8").slice(-2000)}`,
						),
					);
					return;
				}
				resolve();
			});
			proc.on("error", reject);
		});

		const all = Buffer.concat(stdoutChunks);
		const frames: Buffer[] = [];
		for (let offset = 0; offset + frameSize <= all.length; offset += frameSize) {
			frames.push(all.subarray(offset, offset + frameSize));
		}
		return frames;
	}

	return {
		async nextFrame(): Promise<Buffer> {
			framesPromise ??= decodeAll();
			const frames = await framesPromise;
			const frame = frames[cursor];
			if (!frame) {
				throw new Error(
					`frame source for "${sourcePath}" exhausted: requested frame ${cursor}, only decoded ${frames.length}`,
				);
			}
			cursor += 1;
			return frame;
		},
		close(): void {
			// Decoding already finished (fully, into `frames`) before any frame
			// is handed out — nothing left running to clean up.
		},
	};
}
