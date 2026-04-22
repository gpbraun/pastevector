import * as fs from "fs/promises";
import * as path from "path";

import { T_CONVERT_MS, ensureDir, removeIfExists, statSafe, commandExists, runText } from "./util";
import { scaleSvgRootDimensions, finalizeEmfWithInkscape } from "./svg";

// emf2svg-conv produces SVGs with width/height but no viewBox. The content is
// positioned via a large translate() that exactly maps to the declared canvas.
// Without a viewBox, scaling width/height shrinks the canvas but leaves content
// coordinates unchanged, clipping anything near the original edges. Adding
// viewBox="0 0 W H" makes the coordinate system scale with the canvas.
async function ensureViewBox(svgPath: string): Promise<void> {
  let svg = await fs.readFile(svgPath, "utf8");
  if (/\bviewBox\s*=/.test(svg)) return;
  const wm = svg.match(/\bwidth="([\d.]+)[^"]*"/);
  const hm = svg.match(/\bheight="([\d.]+)[^"]*"/);
  if (!wm || !hm) return;
  svg = svg.replace(/(<svg\b[^>]*?)(\/?>)/, `$1 viewBox="0 0 ${wm[1]} ${hm[1]}"$2`);
  await fs.writeFile(svgPath, svg, "utf8");
}

export async function convertEmfToSvg(
  inEmfAbs: string,
  outSvgAbs: string,
  scalePercent: number,
  fitWithInkscape: boolean,
  log?: (msg: string) => void,
): Promise<void> {
  if (!commandExists("emf2svg-conv")) {
    throw new Error(
      "emf2svg-conv not found in PATH. Install libemf2svg (e.g. apt install libemf2svg-dev or build from source).",
    );
  }

  await ensureDir(path.dirname(outSvgAbs));
  await removeIfExists(outSvgAbs);

  const r = await runText("emf2svg-conv", ["-i", inEmfAbs, "-o", outSvgAbs], T_CONVERT_MS);

  const st = await statSafe(outSvgAbs);
  if (!st.exists || st.size === 0) {
    const detail = [r.stderr?.trim(), r.stdout?.trim()].filter(Boolean).join("\n");
    throw new Error(`emf2svg-conv produced no output.\n${detail}`.trim());
  }

  const factor = 100 / scalePercent;
  if (log) log(`handler=emf2svg-conv scalePercent=${scalePercent} factor=${factor.toFixed(6)} fit=${fitWithInkscape}`);

  if (fitWithInkscape) await finalizeEmfWithInkscape(outSvgAbs, log);

  // Always run after fit (no-op if Inkscape already added viewBox; fixes missing
  // viewBox when fit was skipped or failed).
  await ensureViewBox(outSvgAbs);
  await scaleSvgRootDimensions(outSvgAbs, factor);

  if (log) log(`emf2svg-conv -> ${outSvgAbs}`);
}
