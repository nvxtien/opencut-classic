import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { writeFileSync } from "node:fs";

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
  } catch (err) {
    results.push({ name, ok: false, detail: String(err) });
  }
}

const canvas = createCanvas(320, 180);
const ctx = canvas.getContext("2d");

check("ctx.save/restore/translate/scale/rotate", () => {
  ctx.save();
  ctx.translate(160, 90);
  ctx.scale(1.2, 1.2);
  ctx.rotate((15 * Math.PI) / 180);
  ctx.restore();
  return "ok";
});

check("ctx.fillStyle + fillRect (base layer)", () => {
  ctx.fillStyle = "#1c1b19";
  ctx.fillRect(0, 0, 320, 180);
  return "ok";
});

check("ctx.globalCompositeOperation (blend mode)", () => {
  const supported = [];
  for (const mode of ["multiply", "screen", "overlay", "lighter"]) {
    ctx.globalCompositeOperation = mode;
    supported.push([mode, ctx.globalCompositeOperation === mode]);
  }
  ctx.globalCompositeOperation = "source-over";
  return supported;
});

check("ctx.filter (CSS filter string, e.g. blur)", () => {
  ctx.filter = "blur(4px)";
  const readBack = ctx.filter;
  ctx.filter = "none";
  return { set: "blur(4px)", readBack };
});

check("ctx.roundRect", () => {
  ctx.beginPath();
  ctx.roundRect(20, 20, 100, 40, 8);
  ctx.fillStyle = "#a8491f";
  ctx.fill();
  return "ok";
});

check("ctx.font + measureText + fillText + textAlign/textBaseline", () => {
  GlobalFonts.registerFromPath(
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "Arial",
  );
  ctx.font = '600 28px "Arial", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const metrics = ctx.measureText("OpenCut headless");
  ctx.fillStyle = "#efe9da";
  ctx.fillText("OpenCut headless", 160, 140);
  return {
    width: metrics.width,
    hasActualBoundingBox:
      typeof metrics.actualBoundingBoxAscent === "number" &&
      typeof metrics.actualBoundingBoxDescent === "number",
  };
});

check("canvas.toBuffer('image/png') — export real PNG bytes", () => {
  const buf = canvas.toBuffer("image/png");
  writeFileSync(new URL("./spike-output.png", import.meta.url), buf);
  return { bytes: buf.length };
});

console.log(JSON.stringify(results, null, 2));

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} check(s) FAILED`);
  process.exit(1);
} else {
  console.log(`\nAll ${results.length} checks PASSED`);
}
