// 
// src/extension.ts
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

const T_LIST_MS = 2500;
const T_READ_MS = 8000;
const T_CONVERT_MS = 45000;

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
  if (!st.exists || st.size === 0)
    throw new Error("Output file missing/empty after write.");
}

function commandExists(cmd: string): boolean {
  const r = cp.spawnSync("bash", ["-lc", `command -v ${cmd} >/dev/null 2>&1`], {
    stdio: "ignore",
  });
  return r.status === 0;
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
      resolve({
        code: -1,
        stdout,
        stderr: stderr + `\n[TIMEOUT ${timeoutMs}ms]`,
      });
    }, timeoutMs);

    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    p.on("error", (e) => {
      clearTimeout(timer);
      resolve({
        code: -1,
        stdout,
        stderr: stderr + `\n[SPAWN ERROR] ${e?.message ?? e}`,
      });
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
      resolve({
        code: -1,
        bytes: Buffer.concat(chunks),
        stderr: stderr + `\n[TIMEOUT ${timeoutMs}ms]`,
      });
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

    const r = await runText(
      "xclip",
      ["-selection", "clipboard", "-o", "-t", "TARGETS"],
      T_LIST_MS
    );
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
        : await runBin(
            "xclip",
            ["-selection", "clipboard", "-o", "-t", rawType],
            T_READ_MS
          );

    if (r.code !== 0 || r.bytes.length === 0)
      throw new Error(`Clipboard read failed (${rawType}).`);
    return r.bytes;
  }
}

function getBackends(prefer: "auto" | "wayland" | "x11"): ClipboardBackend[] {
  const hasWayland = !!process.env.WAYLAND_DISPLAY && commandExists("wl-paste");
  const hasX11 = commandExists("xclip");
  const w = hasWayland ? new ClipboardBackend("wayland") : null;
  const x = hasX11 ? new ClipboardBackend("x11") : null;

  const list =
    prefer === "wayland" ? [w, x] : prefer === "x11" ? [x, w] : [w, x];
  return list.filter(Boolean) as ClipboardBackend[];
}

function pickFirst(
  offered: OfferedType[],
  bases: string[]
): OfferedType | null {
  for (const b of bases) {
    const hit = offered.find((t) => t.base === b);
    if (hit) return hit;
  }
  return null;
}

async function maybeGunzip(buf: Buffer): Promise<Buffer> {
  return await new Promise((resolve) => {
    zlib.gunzip(buf, (err, out) => resolve(err ? buf : out));
  });
}

async function emfToSvg(emfBytes: Buffer, outSvgAbs: string) {
  if (!commandExists("emf2svg-conv"))
    throw new Error("emf2svg-conv not found in PATH.");
  await ensureDir(path.dirname(outSvgAbs));

  const tmpEmf = path.join(os.tmpdir(), `pastevector_${nonce()}.emf`);
  await fs.writeFile(tmpEmf, emfBytes);

  const r = await runText(
    "emf2svg-conv",
    ["-i", tmpEmf, "-o", outSvgAbs, "-p"],
    T_CONVERT_MS
  );
  const st = await statSafe(outSvgAbs);
  if (!st.exists || st.size === 0) {
    const details = [r.stderr?.trim(), r.stdout?.trim()]
      .filter(Boolean)
      .join("\n");
    throw new Error(`emf2svg-conv produced no output.\n${details}`.trim());
  }
}

/** Extend by adding handlers */
type Handler = {
  name: string;
  ext: string;
  bases: string[];
  run: (bytes: Buffer, outAbs: string) => Promise<void>;
};

const HANDLERS: Handler[] = [
  // Prefer vector when available
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
    run: async (b, out) => emfToSvg(b, out),
  },
  // Raster
  {
    name: "png",
    ext: "png",
    bases: ["image/png", "image/x-png"],
    run: async (b, out) => writeBytes(out, b),
  },
  {
    name: "jpg",
    ext: "jpg",
    bases: ["image/jpeg"],
    run: async (b, out) => writeBytes(out, b),
  },
];

async function tryHandle(
  backend: ClipboardBackend,
  offered: OfferedType[],
  makeOutAbs: (ext: string) => string
): Promise<{ handler: Handler; usedType: string; outAbs: string } | null> {
  for (const h of HANDLERS) {
    const t = pickFirst(offered, h.bases);
    if (!t) continue;

    const bytes = await backend.readType(t.raw);
    const outAbs = makeOutAbs(h.ext);

    await h.run(bytes, outAbs);

    const st = await statSafe(outAbs);
    if (!st.exists || st.size === 0)
      throw new Error(`Handler ${h.name} produced empty output.`);

    return { handler: h, usedType: t.base, outAbs };
  }
  return null;
}

export async function activate(context: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel("pasteVector");

  const pasteCmd = vscode.commands.registerCommand(
    "pasteVector.pasteVector",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      if (editor.document.languageId !== "markdown") {
        await vscode.commands.executeCommand(
          "editor.action.clipboardPasteAction"
        );
        return;
      }

      const cfg = vscode.workspace.getConfiguration();
      const preferBackend = cfg.get<"auto" | "wayland" | "x11">(
        "pasteVector.preferBackend",
        "auto"
      );
      const tpl = cfg.get<string>(
        "pasteVector.destinationTemplate",
        `image.\${fileExtName}`
      );
      const altText = cfg.get<string>("pasteVector.altText", "");

      const docPath = editor.document.uri.fsPath;
      const docDir = path.dirname(docPath);
      const docBase = path.basename(docPath, path.extname(docPath));
      const unixTime = nowSec();

      const makeOutAbs = (ext: string) => {
        const outRel = expandTemplate(tpl, {
          documentBaseName: docBase,
          unixTime,
          fileExtName: ext,
        });
        return path.join(docDir, outRel);
      };

      const backends = getBackends(preferBackend);
      if (backends.length === 0) {
        vscode.window.showErrorMessage(
          "pasteVector: no clipboard backend found (install wl-clipboard or xclip)."
        );
        return;
      }

      out.show(true);
      out.appendLine(`${ts()} paste`);

      let lastErr: string | null = null;

      for (const b of backends) {
        try {
          const offered = await b.listTypes();
          const res = await tryHandle(b, offered, makeOutAbs);
          if (!res) continue;

          const rel = relPosixNoDot(docDir, res.outAbs);
          const md = mdImage(rel, altText);

          await editor.edit((eb) => eb.insert(editor.selection.active, md));
          await vscode.env.clipboard.writeText(md);

          out.appendLine(
            `${ts()} ok backend=${b.kind} handler=${res.handler.name} type=${
              res.usedType
            } -> ${rel}`
          );
          return;
        } catch (e: any) {
          lastErr = e?.message ?? String(e);
          out.appendLine(`${ts()} fail backend=${b.kind} ${lastErr}`);
        }
      }

      if (lastErr)
        vscode.window.showErrorMessage(`pasteVector: failed (${lastErr})`);
      await vscode.commands.executeCommand(
        "editor.action.clipboardPasteAction"
      );
    }
  );

  const showTypesCmd = vscode.commands.registerCommand(
    "pasteVector.showClipboardTypes",
    async () => {
      const cfg = vscode.workspace.getConfiguration();
      const preferBackend = cfg.get<"auto" | "wayland" | "x11">(
        "pasteVector.preferBackend",
        "auto"
      );
      const backends = getBackends(preferBackend);

      out.show(true);
      out.appendLine(`${ts()} clipboard types`);

      for (const b of backends) {
        const offered = await b.listTypes();
        out.appendLine(`${ts()} backend=${b.kind} types=${offered.length}`);
        out.appendLine(offered.map((t) => `- ${t.base}`).join("\n"));
      }
    }
  );

  context.subscriptions.push(out, pasteCmd, showTypesCmd);
}

export function deactivate() {}
