// uwucrew Sync desktop app: installs and updates the addon, uploads its saved data after every logout or /reload,
// and shows your characters. Closing the window leaves it syncing from the tray.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from "electron";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { autoUpdater } from "electron-updater";
import * as core from "./core.ts";

const DIR = import.meta.dirname;
const SMOKE = process.argv.includes("--smoke"); // CI: open the window, check the UI rendered, quit
if (!app.requestSingleInstanceLock()) app.exit(0);

// ---------- settings ----------

type Config = {
  wowDir?: string; game?: string; link?: string; autoUpdate?: boolean; openAtLogin?: boolean; trayHint?: boolean;
  restartedHiddenAt?: number; // set just before a quiet self-update restart, so the app comes back to the tray
};
const CONFIG = join(app.getPath("userData"), "config.json");
const readJson = (file: string) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
// First run picks up the WoW folder the old command-line app saved.
const cfg: Config = readJson(CONFIG) ?? { wowDir: readJson(join(homedir(), ".uwucrew-sync.json"))?.wowDir };
function save() {
  mkdirSync(dirname(CONFIG), { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
}

const games = () => (cfg.wowDir ? core.gameFolders(cfg.wowDir) : []);
// A folder picked during the beta is skipped now that it's over.
const game = () => (games().includes(cfg.game ?? "") && !/beta|ptr/i.test(cfg.game!) ? cfg.game! : games()[0]);

// ---------- state shown in the window ----------

type Status = { ok: boolean; text: string; at: number };
type CharSync = core.Result & { at: number };
type AccountState = core.Account & { mtime: number; status: Status | null; synced: Record<string, CharSync> };

const accounts = new Map<string, AccountState>();
const activity: { at: number; ok: boolean; text: string }[] = [];
const addon = { installed: null as string | null, latest: null as string | null, outdated: false, busy: false, error: null as string | null, checkedAt: 0 };
let updateReady: string | null = null; // a downloaded app version waiting for a restart
const appUpdate = { busy: false, error: null as string | null, checkedAt: 0, downloading: null as string | null };
let guild: core.Guild | null = null; // the guild feed from the bot, for the Guild and Raids tabs
let guildError: string | null = null;
const ICONS = join(app.getPath("userData"), "icons.json");
const icons: Record<number, string | null> = readJson(ICONS) ?? {}; // item id -> Wowhead icon name, null if Wowhead has none

/** Which link uploads this account: its own from /uwu link in game, else the one pasted into the app. */
function linkedBy(a: { link: string | null }) {
  if (a.link) return "game";
  if (cfg.link) return "app";
  return null;
}

const view = () => ({
  version: app.getVersion(),
  canOpenAtLogin: process.platform !== "linux",
  wowDir: cfg.wowDir ?? null,
  wowFound: games().length > 0,
  game: game() ?? null,
  games: games(),
  autoUpdate: cfg.autoUpdate !== false,
  openAtLogin: !!cfg.openAtLogin,
  linkServer: cfg.link ? (core.decodeLink(cfg.link)?.url ?? null) : null,
  addon,
  activity: activity.slice(0, 40),
  updateReady,
  appUpdate,
  guild,
  guildError,
  icons,
  accounts: [...accounts.values()].filter((a) => a.chars.length).map(({ exports, ...a }) => ({ ...a, linkedBy: linkedBy(a) })),
});

let win: BrowserWindow | null = null;
const push = () => win?.webContents.send("state", view());
function note(text: string, ok = true) {
  activity.unshift({ at: Date.now(), ok, text });
  activity.length = Math.min(activity.length, 100);
}
function notify(title: string, body: string) {
  if (Notification.isSupported() && !SMOKE) new Notification({ title, body, icon: join(DIR, "icon.png") }).show();
}

// ---------- syncing ----------

const uploaded = new Map<string, number>(); // file -> mtime already uploaded
let files: string[] = [];
let lastScan = 0;

function setStatus(a: AccountState, ok: boolean, text: string) {
  if (!ok && a.status?.text !== text) note(`${a.name}: ${text}`, false); // successes are logged per character
  a.status = { ok, text, at: Date.now() };
}

/** Uploads one WoW account. Returns false if it should be retried. */
async function syncAccount(a: AccountState) {
  if (!a.exports.length) return true; // nothing to upload, e.g. only beta characters
  const link = core.decodeLink(a.link ?? cfg.link ?? "");
  if (!link) return setStatus(a, false, "Not linked to Discord yet, so nothing was uploaded."), true;
  const r = await core.upload(link, a.exports);
  if (r.status !== "ok") {
    if (r.status === "throttled") return false;
    if (r.status === "retry") return setStatus(a, false, `${r.message.replace(/\.$/, "")}. Trying again shortly.`), false;
    const fix = a.link ? "type /uwu link with the new code in game, then /reload" : "paste the new code in Settings";
    return setStatus(a, false, `${r.message}: ${fix}.`), true;
  }
  r.results.forEach((res, i) => {
    const c = a.chars[i];
    if (c) a.synced[[c.first, c.last].filter(Boolean).join(" ")] = { ...res, at: Date.now() };
    note(res.message, res.ok);
  });
  lastGuild = 0; // fresh levels for the Guild tab
  const failed = r.results.filter((x) => !x.ok).length;
  setStatus(a, !failed, failed ? `${failed} of ${r.results.length} characters didn't sync.` : `Synced ${r.results.length} character${r.results.length === 1 ? "" : "s"}.`);
  return true;
}

let lastGame: string | undefined;
async function tick() {
  if (!cfg.wowDir) return;
  let changed = false;
  if (Date.now() - lastScan > 60_000) {
    files = core.savedVarFiles(cfg.wowDir);
    lastScan = Date.now();
    for (const f of accounts.keys()) if (!files.includes(f)) changed = accounts.delete(f);
    if (game() !== lastGame) checkAddon(); // e.g. the live _forever_ folder just appeared: install there right away
    lastGame = game();
  }
  for (const file of files) {
    const mtime = existsSync(file) ? statSync(file).mtimeMs : 0;
    if (!mtime) continue;
    let a = accounts.get(file);
    if (a?.mtime !== mtime) {
      a = { ...core.readAccount(file), mtime, status: a?.status ?? null, synced: a?.synced ?? {} };
      accounts.set(file, a);
      changed = true;
    }
    if (uploaded.get(file) === mtime) continue;
    if (await syncAccount(a)) uploaded.set(file, mtime);
    changed = true;
  }
  if (changed) {
    push();
    fetchIcons();
  }
  if (Date.now() - lastGuild > 5 * 60_000) refreshGuild();
}

let running: Promise<void> | null = null;
const runTick = () => (running ??= tick().catch((err) => console.error(err)).finally(() => (running = null)));
function syncNow() {
  uploaded.clear();
  lastScan = 0;
  runTick();
}
function wowChanged() {
  accounts.clear();
  syncNow();
  checkAddon();
}

// ---------- the guild ----------

let lastGuild = 0;
/** Any link this PC has: the one pasted into the app, else one from /uwu link in game. Every link belongs to a guild member. */
const anyLink = () => core.decodeLink(cfg.link ?? [...accounts.values()].find((a) => a.link)?.link ?? "");

async function refreshGuild() {
  lastGuild = Date.now();
  const link = anyLink();
  if (!link) {
    guild = null;
    return push();
  }
  try {
    guild = await core.fetchGuild(link);
    guildError = null;
    const g = game();
    if (cfg.wowDir && g) core.writeGuildFile(core.addonDir(cfg.wowDir, g), guild); // the addon picks it up on the next /reload
  } catch (err) {
    guildError = (err as Error).message;
  }
  push();
}

let fetchingIcons = false;
async function fetchIcons() {
  if (fetchingIcons) return;
  fetchingIcons = true;
  let found = false;
  try {
    const wanted = new Set([...accounts.values()].flatMap((a) => a.chars.flatMap((c) => (c.gear ?? []).map((g) => g.id))));
    for (const id of wanted) {
      if (id in icons) continue;
      try {
        icons[id] = await core.itemIcon(id);
        found = true;
      } catch {} // offline or rate limited: left out, so it's tried again next time
    }
  } finally {
    fetchingIcons = false;
  }
  if (!found) return;
  writeFileSync(ICONS, JSON.stringify(icons));
  push();
}

// ---------- the addon ----------

async function checkAddon(install = cfg.autoUpdate !== false) {
  const g = game();
  if (!cfg.wowDir || !g || addon.busy) return;
  const dir = core.addonDir(cfg.wowDir, g);
  Object.assign(addon, { busy: true, error: null });
  push();
  try {
    const release = await core.fetchAddon();
    const had = core.installedVersion(dir);
    addon.latest = core.tocVersion(release.get(`${core.ADDON}.toc`));
    if (install && core.installAddon(dir, release).length) {
      note(had ? `Updated the addon to ${addon.latest}.` : `Installed the addon (${addon.latest}).`);
      if (had) notify(`uwucrew Sync addon updated to ${addon.latest}`, "If WoW is open, restart it to load the update.");
      else notify("uwucrew Sync addon installed", "If WoW is open, restart it to load the addon.");
    }
    addon.outdated = core.addonChanges(dir, release).length > 0;
  } catch (err) {
    addon.error = (err as Error).message;
    note(`Addon: ${addon.error}`, false);
  }
  Object.assign(addon, { busy: false, checkedAt: Date.now(), installed: core.installedVersion(dir) });
  push();
}

// ---------- updating the app itself ----------

function installUpdate() {
  quitting = true; // quitAndInstall closes the window before before-quit fires, so let it close now
  autoUpdater.quitAndInstall(true, true); // silent installer, then reopen
}

async function checkForUpdates() {
  if (!app.isPackaged) return Object.assign(appUpdate, { error: "Updates only work in the installed app.", checkedAt: Date.now() }), push();
  if (appUpdate.busy) return;
  Object.assign(appUpdate, { busy: true, error: null });
  push();
  try {
    const r = await autoUpdater.checkForUpdates(); // a newer version then downloads in the background
    appUpdate.downloading = r?.isUpdateAvailable && r.updateInfo.version !== updateReady ? r.updateInfo.version : null;
  } catch (err) {
    appUpdate.error = `Couldn't check for updates (${(err as Error).message.split("\n")[0]})`; // the next check retries
  }
  Object.assign(appUpdate, { busy: false, checkedAt: Date.now() });
  push();
}

function setupUpdates() {
  // Every build has the same file names, so old and new block maps would collide. Download whole files instead.
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.on("error", (err) => console.error(`Update failed: ${err.message}`));
  autoUpdater.on("update-downloaded", ({ version }) => {
    updateReady = version;
    appUpdate.downloading = null;
    note(`Downloaded version ${version}.`);
    push();
    // In the tray, nobody is looking: restart into it now and come back hidden. Otherwise wait for the button or the next quit.
    // Linux AppImages relaunch without their arguments (Ubuntu needs --no-sandbox), so they wait for the next quit too.
    if (win?.isVisible() || process.platform === "linux") return;
    cfg.restartedHiddenAt = Date.now();
    save();
    installUpdate();
  });
  checkForUpdates();
  setInterval(checkForUpdates, 3 * 3600_000);
}

// ---------- window and tray ----------

let quitting = false;
let tray: Tray | null = null;
const show = () => {
  win?.show();
  win?.focus();
};
const openExternal = (url: string) => /^https:\/\//.test(url) && shell.openExternal(url);

function setOpenAtLogin(on: boolean) {
  cfg.openAtLogin = on;
  save();
  if (app.isPackaged && process.platform !== "linux") app.setLoginItemSettings({ openAtLogin: on, args: ["--hidden"] });
}

function createWindow(hidden: boolean) {
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 960, minHeight: 620, show: false,
    title: "uwucrew Sync", backgroundColor: "#121629", icon: join(DIR, "icon.png"),
    webPreferences: { preload: join(DIR, "preload.cjs"), sandbox: true, contextIsolation: true },
  });
  if (process.platform !== "darwin") win.removeMenu(); // macOS keeps its menu for Cmd+C/V/Q
  win.webContents.setWindowOpenHandler(({ url }) => (openExternal(url), { action: "deny" }));
  win.webContents.on("will-navigate", (e, url) => (e.preventDefault(), openExternal(url)));
  win.once("ready-to-show", () => hidden || win!.show());
  win.on("session-end", () => (quitting = true)); // Windows logoff/shutdown skips before-quit; don't block it
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win!.hide();
    if (cfg.trayHint) return;
    cfg.trayHint = true;
    save();
    notify("uwucrew Sync is still running", `It keeps syncing from the ${process.platform === "darwin" ? "menu bar" : "tray"}. Quit from its icon there.`);
  });
  win.loadFile(join(DIR, "index.html"));
}

/** The tray has no status line, so say how the check went. */
async function checkFromTray() {
  await checkForUpdates();
  if (appUpdate.error) notify("Couldn't check for updates", appUpdate.error);
  else if (appUpdate.downloading) notify(`Downloading uwucrew Sync ${appUpdate.downloading}`, "It updates once the download finishes.");
  else if (!updateReady) notify("uwucrew Sync is up to date", `You have version ${app.getVersion()}.`);
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(join(DIR, "icon.png")).resize({ width: process.platform === "darwin" ? 18 : 32 }));
  tray.setToolTip("uwucrew Sync");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open uwucrew Sync", click: show },
    { label: "Sync now", click: syncNow },
    { label: "Check for updates", click: checkFromTray },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));
  tray.on("click", show);
}

function smokeTest() {
  setTimeout(() => (console.error("SMOKE FAILED: timed out"), app.exit(2)), 30_000);
  win!.webContents.on("console-message", (e) => e.level === "error" && (console.error(`SMOKE FAILED: ${e.message}`), app.exit(1)));
  win!.webContents.once("did-finish-load", async () => {
    await win!.webContents.executeJavaScript(`new Promise((ok) => setInterval(() => document.querySelector("#app")?.childElementCount && ok(), 100))`);
    console.log("SMOKE OK: the window opened and the UI rendered.");
    app.exit(0);
  });
}

// ---------- actions from the window ----------

ipcMain.handle("state", view);
ipcMain.handle("act", async (_e, name: string, arg: unknown): Promise<string | null> => {
  switch (name) {
    case "pickWowDir": {
      const r = await dialog.showOpenDialog(win!, { title: "Choose your World of Warcraft folder", defaultPath: cfg.wowDir, properties: ["openDirectory"] });
      if (r.canceled || !r.filePaths[0]) return null;
      const dir = core.normalizeWowDir(r.filePaths[0]);
      if (!core.gameFolders(dir).length) return "That folder doesn't look like World of Warcraft. Choose the one that contains _forever_ or another game folder.";
      Object.assign(cfg, { wowDir: dir, game: undefined });
      save();
      wowChanged();
      break;
    }
    case "setGame":
      cfg.game = String(arg);
      save();
      wowChanged();
      break;
    case "setAutoUpdate":
      cfg.autoUpdate = !!arg;
      save();
      if (arg) checkAddon(true);
      break;
    case "setOpenAtLogin":
      setOpenAtLogin(!!arg);
      break;
    case "setLink": {
      const code = String(arg ?? "").trim();
      if (code && !core.decodeLink(code)) return "That isn't a link code. Run /sync link in Discord and copy the whole code (it starts with uwusync).";
      cfg.link = code || undefined;
      save();
      if (code) note("Saved your Discord link.");
      syncNow();
      refreshGuild();
      break;
    }
    case "installAddon":
      await checkAddon(true);
      break;
    case "checkAddon":
      await checkAddon();
      break;
    case "openAddonFolder": {
      const g = game();
      if (!cfg.wowDir || !g) break;
      const dir = core.addonDir(cfg.wowDir, g);
      shell.openPath(existsSync(dir) ? dir : join(cfg.wowDir, g));
      break;
    }
    case "syncNow":
      syncNow();
      break;
    case "openExternal":
      openExternal(String(arg));
      break;
    case "checkApp":
      await checkForUpdates();
      break;
    case "installUpdate":
      installUpdate();
      break;
    case "signup": {
      const link = anyLink();
      const { event, action } = (arg ?? {}) as { event?: number; action?: string };
      if (!link) return "Link your Discord account first, in Settings.";
      try {
        const r = await core.signup(link, Number(event), String(action));
        if (!r.ok) return r.message;
        note(r.message);
      } catch (err) {
        return `Couldn't sign up: ${(err as Error).message}`;
      }
      await refreshGuild();
      break;
    }
    case "refreshGuild":
      await refreshGuild();
      break;
  }
  push();
  return null;
});

app.on("second-instance", show);
app.on("activate", show);
app.on("before-quit", () => (quitting = true));

app.setAppUserModelId("gg.uwucrew.sync"); // Windows only shows notifications for an app with an id

app.whenReady().then(() => {
  if (!cfg.wowDir || !existsSync(cfg.wowDir)) cfg.wowDir = core.detectWowDir() ?? cfg.wowDir;
  if (cfg.openAtLogin === undefined && !SMOKE) setOpenAtLogin(process.platform !== "linux");
  const afterQuietUpdate = Date.now() - (cfg.restartedHiddenAt ?? 0) < 120_000;
  delete cfg.restartedHiddenAt;
  save();
  const startHidden = afterQuietUpdate || process.argv.includes("--hidden") || app.getLoginItemSettings().wasOpenedAtLogin === true;
  createWindow(startHidden);
  createTray();
  if (SMOKE) return smokeTest();
  if (app.isPackaged) setupUpdates();
  checkAddon();
  setInterval(checkAddon, 3 * 3600_000);
  (async () => {
    for (;;) {
      await runTick();
      await new Promise((r) => setTimeout(r, 5000));
    }
  })();
});
