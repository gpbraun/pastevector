import * as cp from "child_process";
import * as fs from "fs/promises";
import * as path from "path";

export const T_CONVERT_MS = 45_000;

// ── File helpers ──────────────────────────────────────────────────────────────

export function nonce(): string {
  return `${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
}

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

export async function removeIfExists(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch {
    /* ignore */
  }
}

export async function statSafe(
  p: string,
): Promise<{ exists: boolean; size: number }> {
  try {
    const st = await fs.stat(p);
    return { exists: true, size: st.size };
  } catch {
    return { exists: false, size: 0 };
  }
}

export async function writeBytes(outAbs: string, bytes: Buffer): Promise<void> {
  await ensureDir(path.dirname(outAbs));
  await fs.writeFile(outAbs, bytes);
}

// ── Process helpers ───────────────────────────────────────────────────────────

const CMD_CACHE = new Map<string, boolean>();

export function commandExists(cmd: string): boolean {
  const cached = CMD_CACHE.get(cmd);
  if (cached !== undefined) return cached;
  const r = cp.spawnSync("bash", ["-lc", `command -v ${cmd} >/dev/null 2>&1`], {
    stdio: "ignore",
  });
  const ok = r.status === 0;
  CMD_CACHE.set(cmd, ok);
  return ok;
}

export function runText(
  cmd: string,
  args: string[],
  timeoutMs: number,
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
        stderr: `${stderr}\n[TIMEOUT ${timeoutMs}ms]`,
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
        stderr: `${stderr}\n[SPAWN ERROR] ${e?.message ?? String(e)}`,
      });
    });
  });
}

export function runBin(
  cmd: string,
  args: string[],
  timeoutMs: number,
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
        stderr: `${stderr}\n[TIMEOUT ${timeoutMs}ms]`,
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
        stderr: `${stderr}\n[SPAWN ERROR] ${e?.message ?? String(e)}`,
      });
    });
  });
}

// ── Platform helpers ──────────────────────────────────────────────────────────

export function isWSL(): boolean {
  return !!process.env.WSL_DISTRO_NAME || !!process.env.WSL_INTEROP;
}

export function wslpathWin(linuxAbs: string): string | null {
  try {
    const r = cp.spawnSync("wslpath", ["-w", linuxAbs], { encoding: "utf8" });
    const out = (r.stdout ?? "").toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

export function psEscapeSingleQuoted(s: string): string {
  return s.replace(/'/g, "''");
}
