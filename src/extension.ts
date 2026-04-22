import * as vscode from "vscode";
import * as path from "path";

import { isWSL } from "./util";
import { looksLikeSvgText, writeSvgText, finalizeSvgWithInkscape } from "./svg";
import {
  planLinuxClipboard,
  planWslWindowsClipboard,
  listClipboardTypes,
  ClipboardPlan,
} from "./clipboard";

// ── Formatting helpers ────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString();
}
function nowSec() {
  return Math.floor(Date.now() / 1000).toString();
}

function expandTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\$\{([^}]+)\}/g, (_, k) => vars[k] ?? "");
}

function relPosixNoDot(fromDir: string, toFile: string): string {
  return path.relative(fromDir, toFile).replace(/\\/g, "/");
}

function mdImage(rel: string, altText: string): string {
  const alt = (altText ?? "").trim();
  const safeAlt = alt.replace(/[\r\n\t]+/g, " ").replace(/]/g, "\\]");
  return alt ? `![${safeAlt}](${rel})` : `![](${rel})`;
}

async function insertMarkdown(
  editor: vscode.TextEditor,
  docDir: string,
  outAbs: string,
  altText: string,
  copyMd: boolean,
): Promise<string> {
  const rel = relPosixNoDot(docDir, outAbs);
  const md = mdImage(rel, altText);
  await editor.edit((eb) => eb.insert(editor.selection.active, md));
  if (copyMd) await vscode.env.clipboard.writeText(md);
  return rel;
}

// Runs plan.convert() in the background. On failure, logs and shows a VS Code
// error notification so the user knows the image file was not written.
function runConvert(plan: ClipboardPlan, log: (msg: string) => void): void {
  plan.convert().catch((e: any) => {
    const msg = e?.message ?? String(e);
    log(`error ${plan.handler}: ${msg}`);
    vscode.window.showErrorMessage(`pasteVector: Conversion failed — ${msg}`);
  });
}

// ── Extension entry points ────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel("pasteVector");

  const pasteCmd = vscode.commands.registerCommand(
    "pasteVector.pasteVector",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      if (editor.document.languageId !== "markdown") {
        await vscode.commands.executeCommand(
          "editor.action.clipboardPasteAction",
        );
        return;
      }

      const cfg = vscode.workspace.getConfiguration();
      const preferBackend = cfg.get<"auto" | "wayland" | "x11">(
        "pasteVector.preferBackend",
        "auto",
      );
      const tpl = cfg.get<string>(
        "pasteVector.destinationTemplate",
        "img_${documentBaseName}_${unixTime}.${fileExtName}",
      );
      const altText = cfg.get<string>("pasteVector.altText", "");
      const showLog = cfg.get<boolean>("pasteVector.showLog", false);
      const copyMdToClipboard = cfg.get<boolean>(
        "pasteVector.copyMarkdownToClipboard",
        false,
      );
      const finalizeSvg = cfg.get<boolean>(
        "pasteVector.finalizeSvgWithInkscape",
        true,
      );
      const emfScalePercent = cfg.get<number>(
        "pasteVector.emfScalePercent",
        125,
      );
      const finalizeEmfWithInkscape = cfg.get<boolean>(
        "pasteVector.finalizeEmfWithInkscape",
        true,
      );
      const copyMd = copyMdToClipboard && !isWSL();
      const docPath = editor.document.uri.fsPath;
      const docDir = path.dirname(docPath);
      const docBase = path.basename(docPath, path.extname(docPath));
      const unixTime = nowSec();

      const makeOutAbs = (ext: string) =>
        path.join(
          docDir,
          expandTemplate(tpl, {
            documentBaseName: docBase,
            unixTime,
            fileExtName: ext,
          }),
        );

      const log = (msg: string) => {
        out.appendLine(`${ts()} ${msg}`);
        if (showLog) out.show(true);
      };

      const clipText = (await vscode.env.clipboard.readText()) ?? "";
      const t = clipText.trim();

      // SVG text / data-URI in clipboard — insert link immediately, write in background
      if (t && looksLikeSvgText(t)) {
        try {
          const outSvgAbs = makeOutAbs("svg");
          const rel = await insertMarkdown(
            editor,
            docDir,
            outSvgAbs,
            altText,
            copyMd,
          );
          log(`ok handler=svg-text -> ${rel}`);
          (async () => {
            await writeSvgText(outSvgAbs, t);
            if (finalizeSvg) await finalizeSvgWithInkscape(outSvgAbs);
          })().catch((e: any) => {
            const msg = e?.message ?? String(e);
            log(`error svg-text: ${msg}`);
            vscode.window.showErrorMessage(
              `pasteVector: Conversion failed — ${msg}`,
            );
          });
          return;
        } catch (e: any) {
          log(`warn svg-text failed: ${e?.message ?? String(e)}`);
        }
      }

      // WSL → Windows clipboard (SVG, EMF, PNG)
      // Must run before the plain-text whitespace check: Windows apps (e.g.
      // ChemDraw) place text alongside EMF on the clipboard; readText() returns
      // that text in modern VS Code + WSL, so the whitespace check would
      // short-circuit before we ever reach the Windows clipboard.
      // PS extraction runs synchronously so we know the path and type; conversion
      // (emf2svg-conv / Inkscape) runs in the background after the link is inserted.
      try {
        const plan = await planWslWindowsClipboard(
          makeOutAbs,
          finalizeSvg,
          { emfScalePercent, finalizeEmfWithInkscape },
          log,
        );
        if (plan) {
          const rel = await insertMarkdown(
            editor,
            docDir,
            plan.outAbs,
            altText,
            copyMd,
          );
          log(`ok handler=${plan.handler} type=${plan.usedType} -> ${rel}`);
          runConvert(plan, log);
          return;
        }
      } catch (e: any) {
        log(`warn wsl clipboard failed: ${e?.message ?? String(e)}`);
      }

      // Plain text with whitespace → default paste
      if (t && /\s/.test(t)) {
        await vscode.commands.executeCommand(
          "editor.action.clipboardPasteAction",
        );
        return;
      }

      // Linux clipboard (Wayland / X11)
      // Type listing runs synchronously so we know the path and extension; byte
      // read and conversion run in the background after the link is inserted.
      try {
        const plan = await planLinuxClipboard(
          preferBackend,
          makeOutAbs,
          finalizeSvg,
        );
        if (plan) {
          const rel = await insertMarkdown(
            editor,
            docDir,
            plan.outAbs,
            altText,
            copyMd,
          );
          log(`ok handler=${plan.handler} type=${plan.usedType} -> ${rel}`);
          runConvert(plan, log);
          return;
        }
      } catch (e: any) {
        log(`warn linux clipboard failed: ${e?.message ?? String(e)}`);
      }

      await vscode.commands.executeCommand(
        "editor.action.clipboardPasteAction",
      );
    },
  );

  const showTypesCmd = vscode.commands.registerCommand(
    "pasteVector.showClipboardTypes",
    async () => {
      const cfg = vscode.workspace.getConfiguration();
      const preferBackend = cfg.get<"auto" | "wayland" | "x11">(
        "pasteVector.preferBackend",
        "auto",
      );
      out.appendLine(`${ts()} clipboard types`);
      out.show(true);

      for (const entry of await listClipboardTypes(preferBackend)) {
        if (entry.error) {
          out.appendLine(`${ts()} backend=${entry.kind} error=${entry.error}`);
        } else {
          out.appendLine(
            `${ts()} backend=${entry.kind} types=${entry.types.length}`,
          );
          out.appendLine(entry.types.map((t) => `- ${t}`).join("\n"));
        }
      }
      if (isWSL()) {
        out.appendLine(
          `${ts()} backend=wsl note=Windows clipboard formats accessed via powershell.exe`,
        );
      }
    },
  );

  context.subscriptions.push(out, pasteCmd, showTypesCmd);
}

export function deactivate() {}
