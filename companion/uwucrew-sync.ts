// uwucrew-sync: uploads your uwucrew Sync addon data to the guild Discord after every logout or /reload.
// WoW only writes addon data to disk at those moments, so this just watches that file.
// Linking happens in game (/uwu link <code>), so each WoW account on this PC syncs to whoever linked it.
//   Options: --reset   forget the saved WoW folder
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractExports, extractLink } from "../src/savedvars.ts";

const CONFIG = join(homedir(), ".uwucrew-sync.json");
type Config = { wowDir?: string };

const log = (msg: string) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

function decodeLinkCode(code: string) {
  try {
    const { u, t } = JSON.parse(Buffer.from(code.replace(/^uwusync-/, ""), "base64url").toString());
    return typeof u === "string" && typeof t === "string" ? { url: u, token: t } : null;
  } catch {
    return null;
  }
}

const WOW_DIRS: Record<string, string[]> = {
  win32: ["C:\\Program Files (x86)\\World of Warcraft", "C:\\Program Files\\World of Warcraft", "D:\\World of Warcraft", "D:\\Games\\World of Warcraft", "E:\\World of Warcraft"],
  darwin: ["/Applications/World of Warcraft"],
  linux: [
    join(homedir(), "Games/world-of-warcraft/drive_c/Program Files (x86)/World of Warcraft"),
    join(homedir(), "Games/battlenet/drive_c/Program Files (x86)/World of Warcraft"),
    join(homedir(), ".wine/drive_c/Program Files (x86)/World of Warcraft"),
  ],
};

/** Every UwucrewSync.lua under the WoW folder: any game version folder, any account. */
async function findFiles(wowDir: string) {
  const files: string[] = [];
  for await (const f of new Bun.Glob("*/WTF/Account/*/SavedVariables/UwucrewSync.lua").scan({ cwd: wowDir, onlyFiles: true })) files.push(join(wowDir, f));
  return files;
}

async function setup(): Promise<Config> {
  let cfg: Config = {};
  if (!process.argv.includes("--reset") && existsSync(CONFIG)) cfg = (await Bun.file(CONFIG).json().catch(() => null)) ?? {};
  while (!cfg.wowDir || !existsSync(cfg.wowDir)) {
    cfg.wowDir = (WOW_DIRS[process.platform] ?? []).find(existsSync);
    if (!cfg.wowDir) cfg.wowDir = prompt("Where is World of Warcraft installed? (the folder containing your game folders):")?.trim().replace(/^"|"$/g, "");
  }
  await Bun.write(CONFIG, JSON.stringify(cfg, null, 2));
  return cfg;
}

const account = (file: string) => file.split(/[\\/]/).at(-3); // .../WTF/Account/<NAME>/SavedVariables/UwucrewSync.lua

async function upload(file: string) {
  const text = await Bun.file(file).text();
  const link = decodeLinkCode(extractLink(text) ?? "");
  if (!link) {
    log(`WoW account ${account(file)} isn't linked yet: run /sync link in Discord, then /uwu link <code> in game and /reload.`);
    return true;
  }
  const exports = extractExports(text);
  if (!exports.length) return true;
  const res = await fetch(`${link.url}/sync`, {
    method: "POST",
    headers: { authorization: `Bearer ${link.token}`, "content-type": "application/json" },
    body: JSON.stringify({ exports }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (res.status === 401) {
    log(`WoW account ${account(file)}: link expired (a newer /sync link replaced it). Run /uwu link with the new code in game, then /reload.`);
    return true; // retrying won't help
  }
  if (!res.ok) {
    log(`Upload failed (${res.status}) ${body.error ?? ""}, will retry.`);
    return false;
  }
  for (const r of body.results ?? []) log(`${r.ok ? "OK " : "!! "} ${String(r.message).replace(/\*\*/g, "")}`);
  return true;
}

const cfg = await setup();
log(`Watching ${cfg.wowDir} for uwucrew Sync data. Leave this running while you play; it syncs whenever you log out or /reload.`);

const seen = new Map<string, number>(); // file -> mtime already uploaded
let files: string[] = [];
let lastScan = 0;
for (;;) {
  if (Date.now() - lastScan > 60_000) {
    files = await findFiles(cfg.wowDir!);
    if (!files.length && !lastScan) log("No uwucrew Sync data yet. Install the addon, log in once, then log out or /reload.");
    lastScan = Date.now();
  }
  for (const file of files) {
    const mtime = existsSync(file) ? statSync(file).mtimeMs : 0;
    if (!mtime || seen.get(file) === mtime) continue;
    const done = await upload(file).catch((err) => (log(`Can't reach the bot (${err.message}), will retry.`), false));
    if (done) seen.set(file, mtime);
  }
  await Bun.sleep(5000);
}
