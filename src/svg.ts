import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { T_CONVERT_MS, nonce, removeIfExists, statSafe, commandExists, runText, writeBytes } from "./util";

// ── Root dimension scaler ─────────────────────────────────────────────────────

export async function scaleSvgRootDimensions(svgPath: string, factor: number): Promise<void> {
  if (factor === 1.0) return;
  let svg = await fs.readFile(svgPath, "utf8");

  const wRe = /(<svg\b[^>]*[\s])width="([\d.]+)([a-z%]*)"/;
  const hRe = /(<svg\b[^>]*[\s])height="([\d.]+)([a-z%]*)"/;
  const wm = svg.match(wRe);
  const hm = svg.match(hRe);

  if (!wm || !hm) {
    const vb = svg.match(/viewBox="([\d.\s-]+)"/);
    if (!vb) return;
    const parts = vb[1].trim().split(/\s+/).map(Number);
    if (parts.length < 4 || parts[2] <= 0 || parts[3] <= 0) return;
    const newW = (parts[2] * factor).toFixed(4);
    const newH = (parts[3] * factor).toFixed(4);
    svg = svg.replace(/(<svg\b[^>]*)(\/?>)/, `$1 width="${newW}px" height="${newH}px"$2`);
  } else {
    svg = svg.replace(wRe, `$1width="${(parseFloat(wm[2]) * factor).toFixed(4)}${wm[3]}"`);
    svg = svg.replace(hRe, `$1height="${(parseFloat(hm[2]) * factor).toFixed(4)}${hm[3]}"`);
  }

  await fs.writeFile(svgPath, svg, "utf8");
}

// ── Inkscape helpers ──────────────────────────────────────────────────────────

export async function fitSvgPageWithInkscape(
  svgPath: string,
  log?: (msg: string) => void,
): Promise<void> {
  if (!commandExists("inkscape")) {
    if (log) log("warn fitSvgPageWithInkscape: inkscape not in PATH, skipping");
    return;
  }

  const tmpOut = path.join(os.tmpdir(), `pastevector_${nonce()}.fit.svg`);
  const args = [
    "--batch-process", "--actions",
    [
      "select-all",
      "fit-canvas-to-selection",
      `export-filename:${tmpOut}`,
      "export-type:svg",
      "export-plain-svg",
      "export-do",
      "quit-immediate",
    ].join(";"),
    svgPath,
  ];

  try {
    const r = await runText("inkscape", args, T_CONVERT_MS);
    const st = await statSafe(tmpOut);
    if (st.exists && st.size > 0) {
      await fs.copyFile(tmpOut, svgPath);
      if (log && r.stderr?.trim()) log(`inkscape fit stderr: ${r.stderr.trim()}`);
    } else {
      const detail = [r.stderr?.trim(), r.stdout?.trim()].filter(Boolean).join(" | ");
      if (log) log(`warn fitSvgPageWithInkscape: no output (${detail}), skipping`);
    }
  } catch (e: any) {
    if (log) log(`warn fitSvgPageWithInkscape: ${e?.message ?? String(e)}, skipping`);
  } finally {
    await removeIfExists(tmpOut);
  }
}

// Used for direct SVG clipboard pastes — runs multiple Inkscape strategies
// to fit the canvas and export as plain SVG.
export async function finalizeSvgWithInkscape(inSvgAbs: string): Promise<void> {
  if (!commandExists("inkscape")) throw new Error("Inkscape not found in PATH.");

  const tmpOut = path.join(os.tmpdir(), `pastevector_${nonce()}.final.svg`);

  const tryCommand = async (args: string[]) => {
    const r = await runText("inkscape", args, T_CONVERT_MS);
    const st = await statSafe(tmpOut);
    return { r, ok: st.exists && st.size > 0 };
  };

  const attempts: string[][] = [
    [
      inSvgAbs,
      "--batch-process",
      `--export-filename=${tmpOut}`,
      "--export-type=svg",
      "--export-plain-svg",
      "--export-area-drawing",
      "--vacuum-defs",
    ],
    [
      "--batch-process", "--actions",
      [
        "select-all",
        "fit-canvas-to-selection",
        `export-filename:${tmpOut}`,
        "export-type:svg",
        "export-plain-svg",
        "export-do",
        "quit-immediate",
      ].join(";"),
      inSvgAbs,
    ],
    [
      "--batch-process", "--actions",
      [
        "select-all",
        "object-stroke-to-path",
        "fit-canvas-to-selection",
        `export-filename:${tmpOut}`,
        "export-type:svg",
        "export-plain-svg",
        "export-do",
        "quit-immediate",
      ].join(";"),
      inSvgAbs,
    ],
  ];

  let lastErr = "";
  for (const args of attempts) {
    await removeIfExists(tmpOut);
    const { r, ok } = await tryCommand(args);
    if (ok) {
      await fs.copyFile(tmpOut, inSvgAbs);
      await removeIfExists(tmpOut);
      return;
    }
    lastErr = [r.stderr?.trim(), r.stdout?.trim()].filter(Boolean).join("\n");
  }

  throw new Error(`Inkscape finalization failed.\n${lastErr}`.trim());
}

// ── SVG text helpers ──────────────────────────────────────────────────────────

export function looksLikeSvgText(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (t.startsWith("data:image/svg+xml")) return true;
  return /<svg[\s>]/i.test(t) && /<\/svg>/i.test(t);
}

function decodeSvgDataUri(s: string): string {
  const comma = s.indexOf(",");
  if (comma < 0) return s;
  const meta = s.slice(0, comma);
  const data = s.slice(comma + 1);
  if (/;base64/i.test(meta)) return Buffer.from(data, "base64").toString("utf8");
  try { return decodeURIComponent(data); } catch { return data; }
}

export async function writeSvgText(outSvgAbs: string, svgText: string): Promise<void> {
  const t = svgText.trim();
  const decoded = t.startsWith("data:image/svg+xml") ? decodeSvgDataUri(t) : t;
  await writeBytes(outSvgAbs, Buffer.from(decoded, "utf8"));
}
