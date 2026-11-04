import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { TICKS_PER_SECOND } from "../src/time";

/**
 * `TICKS_PER_SECOND` here is a hand-copied mirror of
 * `rust/crates/time/src/media_time.rs::TICKS_PER_SECOND` (see the doc
 * comment on the export) — there's no codegen or FFI keeping the two in
 * sync. This test is the next-smallest thing: it reads the actual Rust
 * source and fails loudly if the two values ever drift, instead of staying
 * silently wrong (a mismatch here corrupts every `MediaTime` conversion in
 * every rendered video, with no runtime error to point at the cause).
 */
function main() {
	const repoRoot = join(
		dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))),
	);
	const rustSourcePath = join(repoRoot, "rust/crates/time/src/media_time.rs");
	const rustSource = readFileSync(rustSourcePath, "utf8");

	const match = rustSource.match(/TICKS_PER_SECOND:\s*i64\s*=\s*([\d_]+)/);
	assert.ok(
		match,
		`could not find "pub const TICKS_PER_SECOND: i64 = ..." in ${rustSourcePath} — ` +
			"the Rust source's shape changed; update this test's regex, then re-check the TS value below",
	);
	const rustValue = Number((match as RegExpMatchArray)[1]!.replace(/_/g, ""));

	assert.equal(
		TICKS_PER_SECOND,
		rustValue,
		`TS TICKS_PER_SECOND (${TICKS_PER_SECOND}) no longer matches Rust's (${rustValue}) — ` +
			"update packages/headless-render/src/time.ts to match",
	);

	console.log(JSON.stringify({ TICKS_PER_SECOND, rustValue }, null, 2));
	console.log("\nAll ticks-per-second.test.ts checks PASSED");
}

main();
