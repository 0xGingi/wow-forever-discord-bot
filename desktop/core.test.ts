// A fake WoW folder, a fake bot and a fake addon release: finds the saved data, uploads it, installs and updates the addon.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "./core.ts";

const dir = mkdtempSync(join(tmpdir(), "uwucrew-app-"));
const wow = join(dir, "World of Warcraft");
mkdirSync(join(wow, "_retail_"), { recursive: true });

test("finds the saved data, reads the link and uploads every character", async () => {
  let got: { auth: string | null; exports: string[] } | null = null;
  const bot = Bun.serve({
    port: 0,
    async fetch(req) {
      got = { auth: req.headers.get("authorization"), exports: ((await req.json()) as any).exports };
      return Response.json({ results: [{ ok: true, name: "Smoke Test", message: "**Smoke Test** synced (level 30)." }] });
    },
  });
  // What WoW writes after /uwu link and a logout: a linked account with one character, plus a damaged entry and a beta leftover.
  const link = `uwusync-${Buffer.from(JSON.stringify({ u: `http://127.0.0.1:${bot.port}`, t: "smoke-token" })).toString("base64url")}`;
  const saved = join(wow, "_forever_", "WTF", "Account", "SMOKE#1", "SavedVariables");
  mkdirSync(saved, { recursive: true });
  writeFileSync(join(saved, "UwucrewSync.lua"),
    `\nUwucrewSyncDB = {\n\t["link"] = "${link}",\n\t["exports"] = {\n\t\t["Smoke Test"] = "UWU1:{\\"first\\":\\"Smoke\\",\\"last\\":\\"Test\\",\\"level\\":30}",\n\t\t["Bad"] = "UWU1:{oops",\n\t\t["Old Beta"] = "UWU1:{\\"t\\":1792497600,\\"first\\":\\"Old\\",\\"last\\":\\"Beta\\",\\"level\\":30}",\n\t},\n}\n`);

  expect(core.gameFolders(wow)).toEqual(["_forever_", "_retail_"]);
  expect(core.normalizeWowDir(join(wow, "_forever_"))).toBe(wow);
  const [file] = core.savedVarFiles(wow);
  const account = core.readAccount(file!);
  expect(account).toMatchObject({ game: "_forever_", name: "SMOKE#1", link });
  expect(account.chars.map((c) => c.first)).toEqual(["Smoke"]);

  const r = await core.upload(core.decodeLink(account.link!)!, account.exports);
  bot.stop(true);
  expect(r).toEqual({ status: "ok", results: [{ ok: true, name: "Smoke Test", message: "Smoke Test synced (level 30)." }] });
  expect(got!).toEqual({ auth: "Bearer smoke-token", exports: ['UWU1:{"first":"Smoke","last":"Test","level":30}'] });
  expect(await core.upload({ url: `http://127.0.0.1:${bot.port}`, token: "x" }, [])).toMatchObject({ status: "retry" });
});

test("installs the addon from the release zip, then only updates what changed", async () => {
  const src = join(dir, "release");
  mkdirSync(join(src, "UwucrewSync"), { recursive: true });
  writeFileSync(join(src, "UwucrewSync", "UwucrewSync.toc"), "## Interface: 16001\n## Version: 1.2.0\n");
  writeFileSync(join(src, "UwucrewSync", "UwucrewSync.lua"), "-- addon ".repeat(500)); // big enough to get deflated
  const zip = Bun.spawnSync(["zip", "-qr", "-", "UwucrewSync"], { cwd: src }).stdout;
  const release = Bun.serve({ port: 0, fetch: () => new Response(zip) });

  const files = await core.fetchAddon(`http://127.0.0.1:${release.port}`);
  release.stop(true);
  const addon = core.addonDir(wow, "_forever_");
  expect(core.installedVersion(addon)).toBeNull();
  expect(core.installAddon(addon, files).sort()).toEqual(["UwucrewSync.lua", "UwucrewSync.toc"]);
  expect(core.installedVersion(addon)).toBe("1.2.0");
  expect(core.addonChanges(addon, files)).toEqual([]);

  writeFileSync(join(addon, "UwucrewSync.lua"), "-- old version");
  expect(core.installAddon(addon, files)).toEqual(["UwucrewSync.lua"]);
});

test("GuildData.lua: what the app writes loads in Lua, and addon updates never overwrite it", () => {
  const addon = core.addonDir(wow, "_forever_");
  const guild: core.Guild = {
    chars: [
      { name: 'Lyra "Lightbringer" Dawn', quests: [338, 1053] } as core.GuildChar,
      { name: "Wren Thistledown", quests: [338] } as core.GuildChar,
    ],
    events: [{ id: 1, title: "Barrow Deeps", startsAt: 1_900_000_000, size: 10, going: 4, mine: { status: "in", role: "Healer" } } as core.GuildEvent],
    recipes: {}, progress: [], raidsOpen: 0,
  };
  expect(core.writeGuildFile(addon, guild)).toBe(true);
  expect(core.writeGuildFile(addon, guild)).toBe(false); // unchanged content isn't rewritten

  const luajit = Bun.which("luajit");
  if (luajit) {
    const lua = `dofile(arg[1]); local g = UwucrewSyncGuild; print(g.raids[1].title, g.raids[1].mine, g.raids[1].size, table.concat(g.quests[338], "|"))`;
    const out = Bun.spawnSync([luajit, "-e", `arg = { "${join(addon, core.GUILD_FILE)}" } ${lua}`]).stdout.toString().trim();
    expect(out).toBe('Barrow Deeps\tHealer\t10\tLyra "Lightbringer" Dawn|Wren Thistledown');
  }

  const release = new Map([[core.GUILD_FILE, Buffer.from("-- empty stub")], ["UwucrewSync.toc", readFileSync(join(addon, "UwucrewSync.toc"))]]);
  expect(core.addonChanges(addon, release)).toEqual([]); // the app's GuildData.lua stays
  rmSync(join(addon, core.GUILD_FILE));
  expect(core.installAddon(addon, release)).toEqual([core.GUILD_FILE]); // but a fresh install gets the stub
});
