// Everything the app does besides UI: find WoW, read the addon's saved data, upload it, install the addon.
// Node APIs only, so it runs in Electron's main process and under `bun test`.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { extractExports, extractLink, PREFIX, type Snapshot } from "../src/savedvars.ts";

export type { Snapshot };
export const ADDON = "UwucrewSync";
export const ADDON_URL = "https://github.com/0xGingi/wow-forever-discord-bot/releases/download/latest/UwucrewSync.zip";

// ---------- finding WoW ----------

const WOW_DIRS: Record<string, string[]> = {
  win32: ["C:\\Program Files (x86)\\World of Warcraft", "C:\\Program Files\\World of Warcraft", "D:\\World of Warcraft", "D:\\Games\\World of Warcraft", "E:\\World of Warcraft"],
  darwin: ["/Applications/World of Warcraft"],
  linux: [
    join(homedir(), "Games/world-of-warcraft/drive_c/Program Files (x86)/World of Warcraft"),
    join(homedir(), "Games/battlenet/drive_c/Program Files (x86)/World of Warcraft"),
    join(homedir(), ".wine/drive_c/Program Files (x86)/World of Warcraft"),
  ],
};

const ls = (dir: string) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
const isGameFolder = (name: string) => /^_\w+_$/.test(name);

/** Game version folders (_forever_, _retail_...) inside the WoW folder, Forever first. */
export const gameFolders = (wowDir: string) =>
  ls(wowDir).filter(isGameFolder).sort((a, b) => Number(/forever/i.test(b)) - Number(/forever/i.test(a)) || a.localeCompare(b));

/** People often pick the game folder itself; step up to the WoW folder. */
export const normalizeWowDir = (dir: string) => (isGameFolder(basename(dir)) ? dirname(dir) : dir);

export const detectWowDir = () => (WOW_DIRS[process.platform] ?? []).find((d) => gameFolders(d).length > 0);

// ---------- the addon's saved data ----------

export type Account = { file: string; game: string; name: string; link: string | null; exports: string[]; chars: Snapshot[] };

/** Every UwucrewSync.lua under the WoW folder: any game folder, any WoW account. */
export function savedVarFiles(wowDir: string) {
  const files: string[] = [];
  for (const game of gameFolders(wowDir)) {
    for (const account of ls(join(wowDir, game, "WTF", "Account"))) {
      const file = join(wowDir, game, "WTF", "Account", account, "SavedVariables", `${ADDON}.lua`);
      if (existsSync(file)) files.push(file);
    }
  }
  return files;
}

export function readAccount(file: string): Account {
  const text = readFileSync(file, "utf8");
  const parts = file.split(/[\\/]/); // .../<game>/WTF/Account/<name>/SavedVariables/UwucrewSync.lua
  const exports: string[] = [];
  const chars: Snapshot[] = [];
  for (const code of extractExports(text)) {
    try {
      chars.push(JSON.parse(code.slice(PREFIX.length)));
      exports.push(code); // kept in step with chars, so upload results line up with them
    } catch {} // a damaged entry; the next logout rewrites it
  }
  return { file, game: parts.at(-6)!, name: parts.at(-3)!, link: extractLink(text), exports, chars };
}

// ---------- uploading ----------

export function decodeLink(code: string) {
  try {
    const { u, t } = JSON.parse(Buffer.from(code.trim().replace(/^uwusync-/, ""), "base64url").toString());
    return typeof u === "string" && /^https?:\/\//.test(u) && typeof t === "string" ? { url: u.replace(/\/$/, ""), token: t } : null;
  } catch {
    return null;
  }
}

export type Result = { ok: boolean; message: string; name?: string };
export type Upload = { status: "ok"; results: Result[] } | { status: "expired" | "retry" | "throttled"; message: string };

export async function upload(link: { url: string; token: string }, exports: string[]): Promise<Upload> {
  let res: Response;
  try {
    res = await fetch(`${link.url}/sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${link.token}`, "content-type": "application/json" },
      body: JSON.stringify({ exports }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return { status: "retry", message: `Can't reach the bot (${(err as Error).message})` };
  }
  const body: any = await res.json().catch(() => ({}));
  if (res.status === 401) return { status: "expired", message: "This link was replaced by a newer /sync link" };
  if (res.status === 429) return { status: "throttled", message: "" }; // two accounts of one player uploading back to back
  if (!res.ok) return { status: "retry", message: `The bot answered ${res.status}${body.error ? `: ${body.error}` : ""}` };
  return { status: "ok", results: (body.results ?? []).map((r: any) => ({ ok: !!r.ok, name: r.name, message: String(r.message ?? "").replace(/\*\*/g, "") })) };
}

// ---------- installing the addon ----------

export const addonDir = (wowDir: string, game: string) => join(wowDir, game, "Interface", "AddOns", ADDON);
export const tocVersion = (toc?: Buffer | string) => toc?.toString().match(/^## Version:\s*(.+?)\s*$/m)?.[1] ?? null;
export const installedVersion = (dir: string) => tocVersion(existsSync(join(dir, `${ADDON}.toc`)) ? readFileSync(join(dir, `${ADDON}.toc`)) : undefined);

/** Reads a zip with Node's zlib. ponytail: no zip64 or encryption, which our CI's `zip -r` never produces. */
export function unzip(buf: Buffer) {
  const files = new Map<string, Buffer>();
  const end = buf.lastIndexOf(Buffer.from("PK\x05\x06", "latin1"));
  if (end < 0) throw new Error("not a zip file");
  let p = buf.readUInt32LE(end + 16);
  for (let i = buf.readUInt16LE(end + 10); i > 0; i--) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (!name.endsWith("/")) files.set(name, method === 8 ? inflateRawSync(data) : data);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return files;
}

/** The latest addon release: path inside the addon folder -> contents. */
export async function fetchAddon(url = ADDON_URL) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Couldn't download the addon (${res.status})`);
  const files = new Map<string, Buffer>();
  for (const [name, data] of unzip(Buffer.from(await res.arrayBuffer()))) {
    const rel = name.slice(ADDON.length + 1);
    // Only files inside UwucrewSync/, and nothing that could climb out of it.
    if (name.startsWith(`${ADDON}/`) && /^[\w.\- /]+$/.test(rel) && !rel.split("/").some((s) => s === ".." || s === "")) files.set(rel, data);
  }
  if (!files.has(`${ADDON}.toc`)) throw new Error("The addon download looks broken (no .toc file)");
  return files;
}

/** Files that are missing or different on disk. */
export const addonChanges = (dir: string, files: Map<string, Buffer>) =>
  [...files].filter(([rel, data]) => !existsSync(join(dir, rel)) || !readFileSync(join(dir, rel)).equals(data)).map(([rel]) => rel);

// ponytail: files dropped from a later release stay on disk; WoW only loads what the .toc lists.
export function installAddon(dir: string, files: Map<string, Buffer>) {
  const changed = addonChanges(dir, files);
  for (const rel of changed) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), files.get(rel)!);
  }
  return changed;
}
