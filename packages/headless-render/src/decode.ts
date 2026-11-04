import { spawn } from "node:child_process";

/**
 * Decodes a single frame from `sourcePath` at `atSeconds`, scaled to
 * `width`x`height`, as a PNG buffer (not raw RGBA) — see the MVP note in
 * `docs/mcp-headless.md` §risk 4: this trades a theoretically faster raw
 * pipe for `@napi-rs/canvas`'s well-tested `loadImage()` PNG path, which
 * avoids hand-rolling RGBA buffer plumbing for the first working version.
 *
 * One ffmpeg process per frame. Correct but not fast — fine for the MVP
 * end-to-end proof; a real render loop would decode the source once as a
 * stream and seek forward, not re-open per frame.
 */
export function decodeFramePng({
	sourcePath,
	atSeconds,
	width,
	height,
}: {
	sourcePath: string;
	atSeconds: number;
	width: number;
	height: number;
}): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const args = [
			"-y",
			"-ss",
			atSeconds.toFixed(6),
			"-i",
			sourcePath,
			"-frames:v",
			"1",
			"-vf",
			`scale=${width}:${height}`,
			"-f",
			"image2",
			"-vcodec",
			"png",
			"pipe:1",
		];
		const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
		proc.on("error", reject);
		proc.on("close", (code) => {
			if (code !== 0) {
				reject(
					new Error(
						`ffmpeg decode exited ${code}: ${Buffer.concat(stderrChunks).toString("utf8").slice(-2000)}`,
					),
				);
				return;
			}
			resolve(Buffer.concat(chunks));
		});
	});
}
