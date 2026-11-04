import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFrameEncoder } from "../src/encode";

/**
 * Regression test for the hang found by /ponytail-audit: if the ffmpeg
 * encode process dies, a pending `writeFrame` must reject, not hang forever
 * waiting for a 'drain' event that will never come.
 *
 * Forces an immediate ffmpeg failure (an invalid `-video_size`) rather than
 * reproducing the exact backpressure timing — the point under test is
 * "does writeFrame ever settle once the process has died", which this
 * proves without needing to engineer a precise race.
 */
async function main() {
	const outputPath = join(mkdtempSync(join(tmpdir(), "encode-crash-test-")), "out.mp4");
	const encoder = openFrameEncoder({
		outputPath,
		width: 0, // invalid: ffmpeg will exit immediately on an empty/zero frame size
		height: 0,
		fps: 10,
	});

	// Large and numerous enough to overflow the stdin pipe buffer (a dead
	// ffmpeg never reads it), so at least one write hits real backpressure
	// — otherwise every write just succeeds synchronously and the fix under
	// test (the drain-vs-close race) never actually runs.
	const frame = Buffer.alloc(1024 * 1024);

	const result = await Promise.race([
		(async () => {
			try {
				for (let i = 0; i < 64; i += 1) {
					await encoder.writeFrame(frame);
				}
				return { kind: "resolved" as const };
			} catch (err) {
				return { kind: "rejected" as const, err };
			}
		})(),
		new Promise<{ kind: "timeout" }>((resolve) =>
			setTimeout(() => resolve({ kind: "timeout" }), 10_000),
		),
	]);

	assert.notEqual(result.kind, "timeout", "writeFrame hung instead of settling after the encoder process died");
	assert.equal(result.kind, "rejected", "writeFrame should reject once the ffmpeg process has exited");

	console.log(JSON.stringify({ result: result.kind }, null, 2));
	console.log("\nAll encode.test.ts checks PASSED");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
