//
// src/extension.ts
//
// pasteVector (WSL + Linux)
// - Vector-first for ChemDraw (Windows clipboard EMF -> SVG via emf2svg-conv)
// - SVG-from-Inkscape on Windows (Windows clipboard SVG format / HTML / text)
// - Raster fallback (Windows clipboard Image -> PNG)
// - Linux clipboard fallback (wl-paste / xclip)
//
// Gabriel Braun, 2025
//

import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import * as zlib from "zlib";

type BackendKind = "wayland" | "x11";
type OfferedType = { raw: string; base: string };

const T_LIST_MS = 1200;
const T_READ_MS = 6000;
const T_CONVERT_MS = 45000;
const T_WINCLIP_MS = 12000;

function ts() {
  return new Date().toISOString();
}
function nowSec() {
  return Math.floor(Date.now() / 1000).toString();
}
function nonce() {
  return `${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
}

function expandTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\$\{([^}]+)\}/g, (_, k) => vars[k] ?? "");
}
function relPosixNoDot(fromDir: string, toFile: string): string {
  return path.relative(fromDir, toFile).replace(/\\/g, "/");
}
function escapeAltText(s: string): string {
  return s.replace(/[\r\n\t]+/g, " ").replace(/]/g, "\\]");
}
function mdImage(rel: string, altText: string): string {
  const alt = (altText ?? "").trim();
  return alt ? `![${escapeAltText(alt)}](${rel})` : `![](${rel})`;
}

async function ensureDir(p: string) {
  await fs.mkdir(p, { recursive: true });
}
async function statSafe(p: string): Promise<{ exists: boolean; size: number }> {
  try {
    const st = await fs.stat(p);
    return { exists: true, size: st.size };
  } catch {
    return { exists: false, size: 0 };
  }
}
async function writeBytes(outAbs: string, bytes: Buffer) {
  await ensureDir(path.dirname(outAbs));
  await fs.writeFile(outAbs, bytes);
  const st = await statSafe(outAbs);
  if (!st.exists || st.size === 0) throw new Error("Output file missing/empty after write.");
}

/* --------------------------- process helpers --------------------------- */

const CMD_CACHE = new Map<string, boolean>();

function commandExists(cmd: string): boolean {
  const cached = CMD_CACHE.get(cmd);
  if (cached !== undefined) return cached;

  const r = cp.spawnSync("bash", ["-lc", `command -v ${cmd} >/dev/null 2>&1`], {
    stdio: "ignore",
  });
  const ok = r.status === 0;
  CMD_CACHE.set(cmd, ok);
  return ok;
}

function runText(
  cmd: string,
  args: string[],
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = cp.spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.setEncoding("utf8");
    p.stderr.setEncoding("utf8");
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));

    const timer = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {}
      resolve({ code: -1, stdout, stderr: stderr + `\n[TIMEOUT ${timeoutMs}ms]` });
    }, timeoutMs);

    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    p.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + `\n[SPAWN ERROR] ${e?.message ?? e}` });
    });
  });
}

function runBin(
  cmd: string,
  args: string[],
  timeoutMs: number
): Promise<{ code: number | null; bytes: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const p = cp.spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";
    p.stderr.setEncoding("utf8");
    p.stdout.on("data", (d: Buffer) => chunks.push(d));
    p.stderr.on("data", (d) => (stderr += d));

    const timer = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {}
      resolve({ code: -1, bytes: Buffer.concat(chunks), stderr: stderr + `\n[TIMEOUT ${timeoutMs}ms]` });
    }, timeoutMs);

    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, bytes: Buffer.concat(chunks), stderr });
    });
    p.on("error", (e) => {
      clearTimeout(timer);
      resolve({
        code: -1,
        bytes: Buffer.concat(chunks),
        stderr: stderr + `\n[SPAWN ERROR] ${e?.message ?? e}`,
      });
    });
  });
}

/* --------------------------- svg helpers --------------------------- */

function looksLikeSvgText(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (t.startsWith("data:image/svg+xml")) return true;
  return /<svg[\s>]/i.test(t) && /<\/svg>/i.test(t);
}

function decodeSvgTextOrDataUri(s: string): string {
  const t = s.trim();
  if (!t.startsWith("data:image/svg+xml")) return t;

  const comma = t.indexOf(",");
  if (comma < 0) return t;

  const meta = t.slice(0, comma);
  const data = t.slice(comma + 1);

  if (/;base64/i.test(meta)) return Buffer.from(data, "base64").toString("utf8");
  try {
    return decodeURIComponent(data);
  } catch {
    return data;
  }
}

async function writeSvgText(outSvgAbs: string, svgText: string) {
  const decoded = decodeSvgTextOrDataUri(svgText);
  await writeBytes(outSvgAbs, Buffer.from(decoded, "utf8"));
}

async function maybeGunzip(buf: Buffer): Promise<Buffer> {
  return await new Promise((resolve) => zlib.gunzip(buf, (err, out) => resolve(err ? buf : out)));
}

/* --------------------------- EMF -> SVG (Linux tool) --------------------------- */

async function emfPathToSvg(inEmfAbs: string, outSvgAbs: string) {
  if (!commandExists("emf2svg-conv")) throw new Error("emf2svg-conv not found in PATH.");
  await ensureDir(path.dirname(outSvgAbs));

  const r = await runText("emf2svg-conv", ["-i", inEmfAbs, "-o", outSvgAbs, "-p"], T_CONVERT_MS);
  const st = await statSafe(outSvgAbs);
  if (!st.exists || st.size === 0) {
    const details = [r.stderr?.trim(), r.stdout?.trim()].filter(Boolean).join("\n");
    throw new Error(`emf2svg-conv produced no output.\n${details}`.trim());
  }
}

/* --------------------------- Linux clipboard fallback --------------------------- */

class ClipboardBackend {
  constructor(public kind: BackendKind) {}

  async listTypes(): Promise<OfferedType[]> {
    if (this.kind === "wayland") {
      const r = await runText("wl-paste", ["--list-types"], T_LIST_MS);
      return (r.stdout || "")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((raw) => ({ raw, base: raw.split(";")[0].trim() }));
    }

    const r = await runText("xclip", ["-selection", "clipboard", "-o", "-t", "TARGETS"], T_LIST_MS);
    return (r.stdout || "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((raw) => ({ raw, base: raw }));
  }

  async readType(rawType: string): Promise<Buffer> {
    const r =
      this.kind === "wayland"
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
  const x = hasX11 ? new ClipboardBackend("x11") : null;
  const list = prefer === "wayland" ? [w, x] : prefer === "x11" ? [x, w] : [w, x];
  return list.filter(Boolean) as ClipboardBackend[];
}

function pickFirst(offered: OfferedType[], bases: string[]): OfferedType | null {
  for (const b of bases) {
    const hit = offered.find((t) => t.base === b);
    if (hit) return hit;
  }
  return null;
}

type LinuxHandler = {
  name: string;
  ext: string;
  bases: string[];
  run: (bytes: Buffer, outAbs: string) => Promise<void>;
};

const LINUX_HANDLERS: LinuxHandler[] = [
  {
    name: "svg",
    ext: "svg",
    bases: ["image/svg+xml", "image/x-inkscape-svg"],
    run: async (b, out) => writeBytes(out, b),
  },
  {
    name: "svgz",
    ext: "svg",
    bases: ["image/svg+xml-compressed", "image/x-inkscape-svg-compressed"],
    run: async (b, out) => writeBytes(out, await maybeGunzip(b)),
  },
  {
    name: "emf",
    ext: "svg",
    bases: ["WCF_ENHMETAFILE", "image/x-emf", "image/emf"],
    run: async (b, out) => {
      const tmpEmf = path.join(os.tmpdir(), `pastevector_${nonce()}.emf`);
      await fs.writeFile(tmpEmf, b);
      await emfPathToSvg(tmpEmf, out);
    },
  },
  { name: "png", ext: "png", bases: ["image/png", "image/x-png"], run: async (b, out) => writeBytes(out, b) },
  { name: "jpg", ext: "jpg", bases: ["image/jpeg"], run: async (b, out) => writeBytes(out, b) },
];

async function tryLinuxClipboard(
  prefer: "auto" | "wayland" | "x11",
  makeOutAbs: (ext: string) => string
): Promise<{ outAbs: string; handler: string; usedType: string } | null> {
  const backends = getBackends(prefer);
  for (const b of backends) {
    const offered = await b.listTypes();
    for (const h of LINUX_HANDLERS) {
      const t = pickFirst(offered, h.bases);
      if (!t) continue;

      const bytes = await b.readType(t.raw);
      const outAbs = makeOutAbs(h.ext);
      await h.run(bytes, outAbs);

      const st = await statSafe(outAbs);
      if (!st.exists || st.size === 0) throw new Error(`Linux handler ${h.name} produced empty output.`);
      return { outAbs, handler: `linux-${h.name}`, usedType: `${b.kind}/${t.base}` };
    }
  }
  return null;
}

/* --------------------------- WSL Windows clipboard bridge --------------------------- */

function isWSL(): boolean {
  return !!process.env.WSL_DISTRO_NAME || !!process.env.WSL_INTEROP;
}
function wslpathWin(linuxAbs: string): string | null {
  try {
    const r = cp.spawnSync("wslpath", ["-w", linuxAbs], { encoding: "utf8" });
    const out = (r.stdout ?? "").toString().trim();
    return out || null;
  } catch {
    return null;
  }
}
function psEscapeSingleQuoted(s: string): string {
  return s.replace(/'/g, "''");
}

type WslExportKind = "svg" | "emf" | "png";

async function wslExportWindowsClipboard(
  outSvgAbs: string,
  outPngAbs: string,
  tmpEmfAbs: string
): Promise<WslExportKind | null> {
  if (!isWSL()) return null;
  if (!commandExists("powershell.exe") || !commandExists("wslpath")) return null;

  const outSvgWin = wslpathWin(outSvgAbs);
  const outPngWin = wslpathWin(outPngAbs);
  const tmpEmfWin = wslpathWin(tmpEmfAbs);
  if (!outSvgWin || !outPngWin || !tmpEmfWin) return null;

  await ensureDir(path.dirname(outSvgAbs));
  await ensureDir(path.dirname(outPngAbs));
  await ensureDir(path.dirname(tmpEmfAbs));

  // Exit codes:
  // 12 = SVG written
  // 10 = EMF written (tmpEmf)
  // 11 = PNG written
  // 2  = nothing usable
  const ps = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "Add-Type -AssemblyName System.Drawing;",
    "$do=[System.Windows.Forms.Clipboard]::GetDataObject();",
    "if($do -ne $null) {",
    "  # 1) SVG (prefer vector from Inkscape if available)",
    "  try {",
    "    $fmts=$do.GetFormats();",
    "    $svgFmt=$fmts | Where-Object { $_ -eq 'image/svg+xml' } | Select-Object -First 1;",
    "    if(-not $svgFmt) { $svgFmt=$fmts | Where-Object { $_ -match 'svg' } | Select-Object -First 1; }",
    "    if($svgFmt) {",
    "      $d=$do.GetData($svgFmt);",
    "      if($d -is [string]) { [System.IO.File]::WriteAllText('" +
      psEscapeSingleQuoted(outSvgWin) +
      "', $d, [System.Text.Encoding]::UTF8); exit 12 }",
    "      if($d -is [byte[]]) { [System.IO.File]::WriteAllBytes('" +
      psEscapeSingleQuoted(outSvgWin) +
      "', $d); exit 12 }",
    "      if($d -is [System.IO.Stream]) {",
    "        $ms=New-Object System.IO.MemoryStream; $d.CopyTo($ms);",
    "        [System.IO.File]::WriteAllBytes('" +
      psEscapeSingleQuoted(outSvgWin) +
      "', $ms.ToArray()); exit 12",
    "      }",
    "    }",
    "  } catch { }",
    "  # 1b) SVG embedded in HTML clipboard (some apps do this)",
    "  try {",
    "    if($do.GetDataPresent([System.Windows.Forms.DataFormats]::Html)) {",
    "      $html=$do.GetData([System.Windows.Forms.DataFormats]::Html);",
    "      if($html -is [string] -and $html -match '<svg') {",
    "        $start=$html.IndexOf('<svg');",
    "        $end=$html.LastIndexOf('</svg>');",
    "        if($start -ge 0 -and $end -ge 0 -and $end -gt $start) {",
    "          $svg=$html.Substring($start, $end-$start+6);",
    "          [System.IO.File]::WriteAllText('" +
      psEscapeSingleQuoted(outSvgWin) +
      "', $svg, [System.Text.Encoding]::UTF8); exit 12",
    "        }",
    "      }",
    "    }",
    "  } catch { }",
    "  # 2) EMF (ChemDraw)",
    "  if($do.GetDataPresent([System.Windows.Forms.DataFormats]::EnhancedMetafile)) {",
    "    # Fast path: managed save",
    "    try {",
    "      $mf=$do.GetData([System.Windows.Forms.DataFormats]::EnhancedMetafile);",
    "      if($mf -ne $null) {",
    "        $mf.Save('" + psEscapeSingleQuoted(tmpEmfWin) + "', [System.Drawing.Imaging.ImageFormat]::Emf);",
    "        exit 10",
    "      }",
    "    } catch { }",
    "    # Robust path: P/Invoke GetEnhMetaFileBits",
    "    try {",
    "      Add-Type -Language CSharp -TypeDefinition @'",
    "using System;",
    "using System.IO;",
    "using System.Runtime.InteropServices;",
    "public static class ClipEmf {",
    "  const uint CF_ENHMETAFILE = 14;",
    "  [DllImport(\"user32.dll\", ExactSpelling=true)] static extern bool OpenClipboard(IntPtr hWndNewOwner);",
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
    "    uint got = GetEnhMetaFileBits(hemf, size, buf);",
    "    if (got != size) return 6;",
    "    File.WriteAllBytes(path, buf);",
    "    return 0;",
    "  }",
    "}",
    "'@;",
    "      $rc=[ClipEmf]::Save('" + psEscapeSingleQuoted(tmpEmfWin) + "');",
    "      if($rc -eq 0) { exit 10 }",
    "    } catch { }",
    "  }",
    "}",
    "# 3) Raster fallback",
    "$img=[System.Windows.Forms.Clipboard]::GetImage();",
    "if($img -ne $null) {",
    "  $img.Save('" + psEscapeSingleQuoted(outPngWin) + "', [System.Drawing.Imaging.ImageFormat]::Png);",
    "  exit 11",
    "}",
    "exit 2",
  ].join("\n");

  const r = await runText("powershell.exe", ["-NoProfile", "-STA", "-Command", ps], T_WINCLIP_MS);

  if (r.code === 12) {
    const st = await statSafe(outSvgAbs);
    return st.exists && st.size > 0 ? "svg" : null;
  }
  if (r.code === 10) {
    const st = await statSafe(tmpEmfAbs);
    return st.exists && st.size > 0 ? "emf" : null;
  }
  if (r.code === 11) {
    const st = await statSafe(outPngAbs);
    return st.exists && st.size > 0 ? "png" : null;
  }
  if (r.code === 2) return null;

  const details = [r.stderr?.trim(), r.stdout?.trim()].filter(Boolean).join("\n");
  throw new Error(`Windows clipboard export failed.\n${details}`.trim());
}

async function tryWslWindowsClipboard(makeOutAbs: (ext: string) => string): Promise<{
  outAbs: string;
  handler: string;
  usedType: string;
} | null> {
  if (!isWSL()) return null;

  const outSvgAbs = makeOutAbs("svg");
  const outPngAbs = makeOutAbs("png");
  const tmpEmfAbs = path.join(os.tmpdir(), `pastevector_${nonce()}.emf`);

  const kind = await wslExportWindowsClipboard(outSvgAbs, outPngAbs, tmpEmfAbs);
  if (!kind) return null;

  if (kind === "svg") return { outAbs: outSvgAbs, handler: "wsl-svg", usedType: "windows/svg" };

  if (kind === "emf") {
    await emfPathToSvg(tmpEmfAbs, outSvgAbs);
    return { outAbs: outSvgAbs, handler: "wsl-emf", usedType: "windows/emf" };
  }

  return { outAbs: outPngAbs, handler: "wsl-png", usedType: "windows/png" };
}

/* --------------------------- main command logic --------------------------- */

async function insertMarkdown(
  editor: vscode.TextEditor,
  docDir: string,
  outAbs: string,
  altText: string,
  copyMdToClipboard: boolean
) {
  const rel = relPosixNoDot(docDir, outAbs);
  const md = mdImage(rel, altText);
  await editor.edit((eb) => eb.insert(editor.selection.active, md));
  if (copyMdToClipboard) {
    // Can be slow in Remote WSL; keep configurable.
    await vscode.env.clipboard.writeText(md);
  }
  return rel;
}

export async function activate(context: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel("pasteVector");

  const pasteCmd = vscode.commands.registerCommand("pasteVector.pasteVector", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    if (editor.document.languageId !== "markdown") {
      await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
      return;
    }

    const cfg = vscode.workspace.getConfiguration();
    const preferBackend = cfg.get<"auto" | "wayland" | "x11">("pasteVector.preferBackend", "auto");
    const tpl = cfg.get<string>("pasteVector.destinationTemplate", `image.\${fileExtName}`);
    const altText = cfg.get<string>("pasteVector.altText", "");
    const showLog = cfg.get<boolean>("pasteVector.showLog", false);
    const copyMdToClipboard = cfg.get<boolean>("pasteVector.copyMarkdownToClipboard", false);

    const docPath = editor.document.uri.fsPath;
    const docDir = path.dirname(docPath);
    const docBase = path.basename(docPath, path.extname(docPath));
    const unixTime = nowSec();

    const makeOutAbs = (ext: string) => {
      const outRel = expandTemplate(tpl, { documentBaseName: docBase, unixTime, fileExtName: ext });
      return path.join(docDir, outRel);
    };

    const log = (msg: string) => {
      out.appendLine(`${ts()} ${msg}`);
      if (showLog) out.show(true);
    };

    // 1) Read clipboard text ONCE.
    //    Important: ChemDraw often provides a "text" representation (SMILES/molfile). We must NOT
    //    automatically assume "text paste" just because readText() is non-empty.
    const clipText = (await vscode.env.clipboard.readText()) ?? "";
    const t = clipText.trim();

    // 1a) SVG-as-text (Windows Inkscape / other apps): handle immediately.
    if (t && looksLikeSvgText(t)) {
      try {
        const outSvgAbs = makeOutAbs("svg");
        await writeSvgText(outSvgAbs, t);
        const rel = await insertMarkdown(editor, docDir, outSvgAbs, altText, copyMdToClipboard && !isWSL());
        log(`ok handler=svg-text -> ${rel}`);
        return;
      } catch (e: any) {
        // fall through (maybe it's not really SVG text)
        log(`warn svg-text failed: ${e?.message ?? String(e)}`);
      }
    }

    // 1b) Fast text paste: only when it "looks like real text" (contains whitespace).
    //     Single-token "text" might be ChemDraw SMILES; in that case, continue and try vector/raster.
    if (t && /\s/.test(t)) {
      await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
      return;
    }

    // 2) Media path: WSL Windows clipboard bridge first (vector-first, includes SVG formats)
    try {
      const wslRes = await tryWslWindowsClipboard(makeOutAbs);
      if (wslRes) {
        const rel = await insertMarkdown(
          editor,
          docDir,
          wslRes.outAbs,
          altText,
          copyMdToClipboard && !isWSL()
        );
        log(`ok handler=${wslRes.handler} type=${wslRes.usedType} -> ${rel}`);
        return;
      }
    } catch (e: any) {
      // keep going to Linux backends, but remember the reason
      log(`warn wsl export failed: ${e?.message ?? String(e)}`);
    }

    // 3) Linux clipboard backends (wl-paste/xclip) as fallback
    try {
      const linuxRes = await tryLinuxClipboard(preferBackend, makeOutAbs);
      if (linuxRes) {
        const rel = await insertMarkdown(
          editor,
          docDir,
          linuxRes.outAbs,
          altText,
          copyMdToClipboard && !isWSL()
        );
        log(`ok handler=${linuxRes.handler} type=${linuxRes.usedType} -> ${rel}`);
        return;
      }
    } catch (e: any) {
      log(`warn linux clipboard failed: ${e?.message ?? String(e)}`);
    }

    // 4) If nothing worked, default paste (so text-only still works even for single-token)
    await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
  });

  const showTypesCmd = vscode.commands.registerCommand("pasteVector.showClipboardTypes", async () => {
    const cfg = vscode.workspace.getConfiguration();
    const preferBackend = cfg.get<"auto" | "wayland" | "x11">("pasteVector.preferBackend", "auto");

    out.appendLine(`${ts()} clipboard types`);
    out.show(true);

    // Linux backends
    const backends = getBackends(preferBackend);
    for (const b of backends) {
      try {
        const offered = await b.listTypes();
        out.appendLine(`${ts()} backend=${b.kind} types=${offered.length}`);
        out.appendLine(offered.map((t) => `- ${t.base}`).join("\n"));
      } catch (e: any) {
        out.appendLine(`${ts()} backend=${b.kind} error=${e?.message ?? String(e)}`);
      }
    }

    // WSL note
    if (isWSL()) {
      out.appendLine(`${ts()} backend=wsl note=Windows clipboard formats are accessed via powershell.exe`);
    }
  });

  context.subscriptions.push(out, pasteCmd, showTypesCmd);
}

export function deactivate() {}
