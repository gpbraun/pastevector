import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";

import {
  nonce, ensureDir, removeIfExists, statSafe, writeBytes,
  commandExists, runText, runBin,
  isWSL, wslpathWin, psEscapeSingleQuoted,
} from "./util";
import { finalizeSvgWithInkscape } from "./svg";
import { convertEmfToSvg } from "./emf";

// ── Types ─────────────────────────────────────────────────────────────────────

// Plan: the output path is known; convert() does the slow I/O work in background.
export type ClipboardPlan = {
  outAbs: string;
  handler: string;
  usedType: string;
  convert: () => Promise<void>;
};

type BackendKind = "wayland" | "x11";
type OfferedType = { raw: string; base: string };
type WslExportKind = "svg" | "emf" | "png";

type LinuxHandler = {
  name: string;
  ext: string;
  bases: string[];
  run: (bytes: Buffer, outAbs: string, finalizeSvg: boolean) => Promise<void>;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const T_LIST_MS   = 1_200;
const T_READ_MS   = 6_000;
const T_WINCLIP_MS = 12_000;

// ── Linux clipboard backend ───────────────────────────────────────────────────

class ClipboardBackend {
  constructor(public kind: BackendKind) {}

  async listTypes(): Promise<OfferedType[]> {
    if (this.kind === "wayland") {
      const r = await runText("wl-paste", ["--list-types"], T_LIST_MS);
      return (r.stdout || "")
        .split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        .map((raw) => ({ raw, base: raw.split(";")[0].trim() }));
    }
    const r = await runText("xclip", ["-selection", "clipboard", "-o", "-t", "TARGETS"], T_LIST_MS);
    return (r.stdout || "")
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      .map((raw) => ({ raw, base: raw }));
  }

  async readType(rawType: string): Promise<Buffer> {
    const r = this.kind === "wayland"
      ? await runBin("wl-paste", ["-t", rawType], T_READ_MS)
      : await runBin("xclip", ["-selection", "clipboard", "-o", "-t", rawType], T_READ_MS);
    if (r.code !== 0 || r.bytes.length === 0) throw new Error(`Clipboard read failed (${rawType}).`);
    return r.bytes;
  }
}

function getBackends(prefer: "auto" | "wayland" | "x11"): ClipboardBackend[] {
  const hasWayland = !!process.env.WAYLAND_DISPLAY && commandExists("wl-paste");
  const hasX11 = commandExists("xclip");
  const w = hasWayland ? new ClipboardBackend("wayland") : null;
  const x = hasX11    ? new ClipboardBackend("x11")     : null;
  const ordered = prefer === "wayland" ? [w, x] : prefer === "x11" ? [x, w] : [w, x];
  return ordered.filter(Boolean) as ClipboardBackend[];
}

function pickFirst(offered: OfferedType[], bases: string[]): OfferedType | null {
  for (const b of bases) {
    const hit = offered.find((t) => t.base === b);
    if (hit) return hit;
  }
  return null;
}

async function maybeGunzip(buf: Buffer): Promise<Buffer> {
  return new Promise((resolve) => zlib.gunzip(buf, (err, out) => resolve(err ? buf : out)));
}

// ── Linux handlers ────────────────────────────────────────────────────────────

const LINUX_HANDLERS: LinuxHandler[] = [
  {
    name: "svg",
    ext: "svg",
    bases: ["image/svg+xml", "image/x-inkscape-svg"],
    run: async (b, out, doFinalize) => {
      await writeBytes(out, b);
      if (doFinalize) await finalizeSvgWithInkscape(out);
    },
  },
  {
    name: "svgz",
    ext: "svg",
    bases: ["image/svg+xml-compressed", "image/x-inkscape-svg-compressed"],
    run: async (b, out, doFinalize) => {
      await writeBytes(out, await maybeGunzip(b));
      if (doFinalize) await finalizeSvgWithInkscape(out);
    },
  },
  {
    name: "emf",
    ext: "svg",
    bases: ["WCF_ENHMETAFILE", "image/x-emf", "image/emf"],
    run: async (b, out) => {
      const cfg = vscode.workspace.getConfiguration();
      const scalePercent = cfg.get<number>("pasteVector.emfScalePercent", 125);
      const fitPage      = cfg.get<boolean>("pasteVector.fitSvgPageWithInkscape", false);
      const tmpEmf = path.join(os.tmpdir(), `pastevector_${nonce()}.emf`);
      await fs.writeFile(tmpEmf, b);
      try {
        await convertEmfToSvg(tmpEmf, out, scalePercent, fitPage);
      } finally {
        await removeIfExists(tmpEmf);
      }
    },
  },
  {
    name: "png",
    ext: "png",
    bases: ["image/png", "image/x-png"],
    run: async (b, out) => { await writeBytes(out, b); },
  },
  {
    name: "jpg",
    ext: "jpg",
    bases: ["image/jpeg"],
    run: async (b, out) => { await writeBytes(out, b); },
  },
];

// planLinuxClipboard: list types synchronously, then return a plan.
// convert() does the actual byte read and conversion in the background.
export async function planLinuxClipboard(
  prefer: "auto" | "wayland" | "x11",
  makeOutAbs: (ext: string) => string,
  finalizeSvg: boolean,
): Promise<ClipboardPlan | null> {
  for (const backend of getBackends(prefer)) {
    const offered = await backend.listTypes();
    for (const h of LINUX_HANDLERS) {
      const t = pickFirst(offered, h.bases);
      if (!t) continue;
      const outAbs = makeOutAbs(h.ext);
      return {
        outAbs,
        handler: `linux-${h.name}`,
        usedType: `${backend.kind}/${t.base}`,
        convert: async () => {
          const bytes = await backend.readType(t.raw);
          await h.run(bytes, outAbs, finalizeSvg);
          const st = await statSafe(outAbs);
          if (!st.exists || st.size === 0) throw new Error(`Linux handler ${h.name} produced empty output.`);
        },
      };
    }
  }
  return null;
}

// ── WSL / Windows clipboard ───────────────────────────────────────────────────

// Exports the Windows clipboard to files via PowerShell.
// Returns "svg", "emf", or "png" depending on what was found, or null if nothing.
async function exportWindowsClipboard(
  outSvgAbs: string,
  outPngAbs: string,
  tmpEmfAbs: string,
): Promise<WslExportKind | null> {
  if (!isWSL() || !commandExists("powershell.exe") || !commandExists("wslpath")) return null;

  const outSvgWin = wslpathWin(outSvgAbs);
  const outPngWin = wslpathWin(outPngAbs);
  const tmpEmfWin = wslpathWin(tmpEmfAbs);
  if (!outSvgWin || !outPngWin || !tmpEmfWin) return null;

  await ensureDir(path.dirname(outSvgAbs));
  await ensureDir(path.dirname(outPngAbs));
  await ensureDir(path.dirname(tmpEmfAbs));

  const ps = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "Add-Type -AssemblyName System.Drawing;",
    "$do=[System.Windows.Forms.Clipboard]::GetDataObject();",
    "if($do -ne $null) {",
    "  try {",
    "    $fmts=$do.GetFormats();",
    "    $svgFmt=$fmts | Where-Object { $_ -eq 'image/svg+xml' } | Select-Object -First 1;",
    "    if(-not $svgFmt) { $svgFmt=$fmts | Where-Object { $_ -match 'svg' } | Select-Object -First 1; }",
    "    if($svgFmt) {",
    "      $d=$do.GetData($svgFmt);",
    `      if($d -is [string]) { [System.IO.File]::WriteAllText('${psEscapeSingleQuoted(outSvgWin)}', $d, [System.Text.Encoding]::UTF8); exit 12 }`,
    `      if($d -is [byte[]]) { [System.IO.File]::WriteAllBytes('${psEscapeSingleQuoted(outSvgWin)}', $d); exit 12 }`,
    "      if($d -is [System.IO.Stream]) {",
    "        $ms=New-Object System.IO.MemoryStream; $d.CopyTo($ms);",
    `        [System.IO.File]::WriteAllBytes('${psEscapeSingleQuoted(outSvgWin)}', $ms.ToArray()); exit 12`,
    "      }",
    "    }",
    "  } catch { }",
    "  try {",
    "    if($do.GetDataPresent([System.Windows.Forms.DataFormats]::Html)) {",
    "      $html=$do.GetData([System.Windows.Forms.DataFormats]::Html);",
    "      if($html -is [string] -and $html -match '<svg') {",
    "        $start=$html.IndexOf('<svg');",
    "        $end=$html.LastIndexOf('</svg>');",
    "        if($start -ge 0 -and $end -ge 0 -and $end -gt $start) {",
    "          $svg=$html.Substring($start, $end-$start+6);",
    `          [System.IO.File]::WriteAllText('${psEscapeSingleQuoted(outSvgWin)}', $svg, [System.Text.Encoding]::UTF8); exit 12`,
    "        }",
    "      }",
    "    }",
    "  } catch { }",
    "  if($do.GetDataPresent([System.Windows.Forms.DataFormats]::EnhancedMetafile)) {",
    "    try {",
    "      Add-Type -Language CSharp -TypeDefinition @'",
    "using System;",
    "using System.IO;",
    "using System.Runtime.InteropServices;",
    "public static class ClipEmf {",
    "  const uint CF_ENHMETAFILE = 14;",
    "  [DllImport(\"user32.dll\", ExactSpelling=true)] static extern bool OpenClipboard(IntPtr h);",
    "  [DllImport(\"user32.dll\", ExactSpelling=true)] static extern bool CloseClipboard();",
    "  [DllImport(\"user32.dll\", ExactSpelling=true)] static extern bool IsClipboardFormatAvailable(uint format);",
    "  [DllImport(\"user32.dll\", ExactSpelling=true)] static extern IntPtr GetClipboardData(uint format);",
    "  [DllImport(\"gdi32.dll\",  ExactSpelling=true)] static extern uint GetEnhMetaFileBits(IntPtr hemf, uint cbBuffer, byte[] lpbBuffer);",
    "  public static int Save(string path) {",
    "    if (!IsClipboardFormatAvailable(CF_ENHMETAFILE)) return 2;",
    "    if (!OpenClipboard(IntPtr.Zero)) return 3;",
    "    IntPtr hemf = GetClipboardData(CF_ENHMETAFILE);",
    "    CloseClipboard();",
    "    if (hemf == IntPtr.Zero) return 4;",
    "    uint size = GetEnhMetaFileBits(hemf, 0, null);",
    "    if (size == 0) return 5;",
    "    byte[] buf = new byte[size];",
    "    if (GetEnhMetaFileBits(hemf, size, buf) != size) return 6;",
    "    File.WriteAllBytes(path, buf);",
    "    return 0;",
    "  }",
    "}",
    "'@;",
    `      $rc=[ClipEmf]::Save('${psEscapeSingleQuoted(tmpEmfWin)}');`,
    "      if($rc -eq 0) { exit 10 }",
    "    } catch { }",
    "  }",
    "}",
    "$img=[System.Windows.Forms.Clipboard]::GetImage();",
    "if($img -ne $null) {",
    `  $img.Save('${psEscapeSingleQuoted(outPngWin)}', [System.Drawing.Imaging.ImageFormat]::Png);`,
    "  exit 11",
    "}",
    "exit 2",
  ].join("\n");

  const r = await runText("powershell.exe", ["-NoProfile", "-STA", "-Command", ps], T_WINCLIP_MS);

  if (r.code === 12) { const st = await statSafe(outSvgAbs); return st.exists && st.size > 0 ? "svg" : null; }
  if (r.code === 10) { const st = await statSafe(tmpEmfAbs); return st.exists && st.size > 0 ? "emf" : null; }
  if (r.code === 11) { const st = await statSafe(outPngAbs); return st.exists && st.size > 0 ? "png" : null; }
  if (r.code === 2) return null;

  const details = [r.stderr?.trim(), r.stdout?.trim()].filter(Boolean).join("\n");
  throw new Error(`Windows clipboard export failed.\n${details}`.trim());
}

export async function listClipboardTypes(
  prefer: "auto" | "wayland" | "x11",
): Promise<Array<{ kind: string; types: string[]; error?: string }>> {
  const results: Array<{ kind: string; types: string[]; error?: string }> = [];
  for (const b of getBackends(prefer)) {
    try {
      const offered = await b.listTypes();
      results.push({ kind: b.kind, types: offered.map((t) => t.base) });
    } catch (e: any) {
      results.push({ kind: b.kind, types: [], error: e?.message ?? String(e) });
    }
  }
  return results;
}

// planWslWindowsClipboard: runs the PS export synchronously (raw bytes land on
// disk), then returns a plan. convert() does only the emf2svg-conv / Inkscape
// work in the background — the slow file-I/O part is already done.
export async function planWslWindowsClipboard(
  makeOutAbs: (ext: string) => string,
  finalizeSvg: boolean,
  config: { emfScalePercent: number; fitSvgPageWithInkscape: boolean },
  log: (msg: string) => void,
): Promise<ClipboardPlan | null> {
  if (!isWSL()) return null;

  const outSvgAbs = makeOutAbs("svg");
  const outPngAbs = makeOutAbs("png");
  const tmpEmfAbs = path.join(os.tmpdir(), `pastevector_${nonce()}.emf`);

  const kind = await exportWindowsClipboard(outSvgAbs, outPngAbs, tmpEmfAbs);
  if (!kind) return null;

  if (kind === "svg") {
    return {
      outAbs: outSvgAbs,
      handler: "wsl-svg",
      usedType: "windows/svg",
      convert: async () => {
        if (finalizeSvg) await finalizeSvgWithInkscape(outSvgAbs);
      },
    };
  }

  if (kind === "emf") {
    return {
      outAbs: outSvgAbs,
      handler: "wsl-emf",
      usedType: "windows/emf",
      convert: async () => {
        try {
          await convertEmfToSvg(
            tmpEmfAbs, outSvgAbs,
            config.emfScalePercent, config.fitSvgPageWithInkscape,
            log,
          );
        } finally {
          await removeIfExists(tmpEmfAbs);
        }
      },
    };
  }

  // kind === "png" — file already written by PS script
  return {
    outAbs: outPngAbs,
    handler: "wsl-png",
    usedType: "windows/png",
    convert: async () => {},
  };
}
