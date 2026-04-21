import * as path from "path";

import { T_CONVERT_MS, ensureDir, removeIfExists, statSafe, commandExists, runText } from "./util";
import { scaleSvgRootDimensions, fitSvgPageWithInkscape } from "./svg";

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

  if (fitWithInkscape) await fitSvgPageWithInkscape(outSvgAbs, log);

  await scaleSvgRootDimensions(outSvgAbs, factor);

  if (log) log(`emf2svg-conv -> ${outSvgAbs}`);
}
