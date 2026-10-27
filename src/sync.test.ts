import { expect, test } from "bun:test";
import { db, getChar } from "./db.ts";
import { extractExports, extractLink, type Snapshot } from "./savedvars.ts";
import { applySync, newLinkCode, parseExport, profileEmbed, startSyncServer, userForToken } from "./sync.ts";
import { questsEmbed } from "./quests.ts";
import { crafterIndex } from "./guild.ts";
import { progressEmbed, raidProgress } from "./progress.ts";

const luajit = Bun.which("luajit");
const fakeClient = { channels: { fetch: async () => null }, users: { fetch: async () => ({ displayName: "Someone" }), send: async () => {} } } as any;

/** Run the real addon under addon/test/harness.lua and return its SavedVariables file. */
async function addonSavedVariables(link?: string) {
  const out = `/tmp/uwucrew-sv-${process.pid}.lua`;
  const p = Bun.spawnSync([luajit!, "addon/test/harness.lua", "addon/UwucrewSync", out], { env: { ...process.env, ...(link ? { UWU_LINK: link } : {}) } });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return Bun.file(out).text();
}

test.skipIf(!luajit)("addon output survives SavedVariables and lands in the roster", async () => {
  const codes = extractExports(await addonSavedVariables());
  expect(codes).toHaveLength(1);
  const parsed = parseExport(codes[0]!);
  if ("error" in parsed) throw new Error(parsed.error);
  expect(parsed.snap.gear[0]!.n).toBe('Heavehammer "the Big"'); // quotes survive JSON-in-Lua escaping

  const r = applySync("addon-user", parsed.snap);
  if ("error" in r) throw new Error(r.error);
  expect(r.created).toBe(true);
  expect(r.char).toMatchObject({ name: "Asha Brightvale", class: "Mage", race: "Skyborne", role: "DPS", level: 30, is_main: 1 });
  expect(db.query("select prof, skill from profs where char_id = ? order by prof").all(r.char.id))
    .toEqual([{ prof: "Enchanting", skill: 152 }, { prof: "Fishing", skill: 154 }, { prof: "Tailoring", skill: 151 }]);

  const embed = profileEmbed(r.char).toJSON();
  const size = JSON.stringify(embed).length;
  expect(size).toBeLessThan(6000);
  expect(JSON.stringify(embed)).toContain("wowhead.com/forever/item=271766");

  // Addon 1.2: boss kills, recipes and a Hardcore death come through too.
  expect(r.firstKills).toEqual([{ raid: "Hyjal Summit", bosses: ["Rage Winterchill", "Anetheron"], down: 2, of: 5 }]);
  expect(r.death).toMatchObject({ l: 30, z: "Wetlands" });
  expect(getChar("Asha Brightvale")!.died_at).toBe(r.death!.t);
  expect(crafterIndex().get("Azure Silk Hood")).toEqual([{ name: "Asha Brightvale", class: "Mage", user_id: "addon-user", prof: "Tailoring" }]);
});

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  v: 1, t: Math.floor(Date.now() / 1000) - 60, first: "Mira", last: "Brightvale", level: 20, class: "PRIEST", race: "Night Elf",
  gear: [], profs: [], lockouts: [], reps: [], ...over,
});
const code = (s: unknown) => `UWU1:${JSON.stringify(s)}`;

test.skipIf(!luajit)("/uwu link in game ties the WoW account to the Discord user who ran /sync link", async () => {
  const code = newLinkCode("linked-user", "https://sync.example.com");
  const sv = await addonSavedVariables(code);
  expect(extractLink(sv)).toBe(code);
  const { t } = JSON.parse(Buffer.from(code.slice("uwusync-".length), "base64url").toString());
  expect(userForToken(t)).toBe("linked-user");
  expect(extractExports(sv)[0]).not.toContain(t); // the secret never goes into paste codes
});

test.skipIf(!luajit)("/quests: full quest log from the app, with guildmates on the same quest", async () => {
  const full = parseExport(extractExports(await addonSavedVariables())[0]!);
  if ("error" in full) throw new Error(full.error);
  expect(full.snap.log).toHaveLength(40); // Forever's quest log cap
  expect(full.snap.log![1]!.o.map((o) => o.t)).toContain("Gnoll Paw: 3/8"); // the app's upload keeps objectives

  const asha = applySync("quest-user", { ...full.snap, first: "Quest", last: "Haver" });
  const mate = applySync("quest-mate", snap({ first: "Party", last: "Member", log: [{ id: 1002, n: "Shared", c: false, o: [] }] }));
  if ("error" in asha || "error" in mate) throw new Error("sync failed");

  const embed = questsEmbed(asha.char).toJSON();
  expect(JSON.stringify(embed).length).toBeLessThan(6000);
  expect(embed.fields!.every((f) => f.value.length <= 1024)).toBe(true);
  expect(embed.fields!.map((f) => f.name).filter((n) => n !== "\u200b")).toEqual(["Wetlands · 10", "Zephras Isle · 10", "Hall of Thanes · 10", "Riverglades · 10"]);
  for (const q of full.snap.log!) expect(JSON.stringify(embed)).toContain(q.n); // all 40 quests listed
  expect(JSON.stringify(embed)).toMatch(/quest=1002\)[^\n]*also: [^\n]*Party Member/);
  expect(embed.description).toContain("**4** ready to turn in");
});

test("/quests says when a paste code had to leave quests out", () => {
  const r = applySync("paste-user", snap({ first: "Paste", last: "Only", log: [{ id: 5, n: "Kept", c: true, o: [] }], logMore: 4 }));
  if ("error" in r) throw new Error(r.error);
  const desc = questsEmbed(r.char).toJSON().description!;
  expect(desc).toContain("**5** quests");
  expect(desc).toContain("4 more didn't fit");
});

test("rejects junk and tampering with a helpful message", () => {
  expect(parseExport("hello")).toHaveProperty("error");
  expect(parseExport("UWU1:{broken")).toHaveProperty("error");
  expect(parseExport(code(snap({ level: 99 })))).toHaveProperty("error");
  expect(parseExport(code(snap({ t: Date.now() / 1000 + 10 * 86400 })))).toHaveProperty("error"); // from the future
  expect(parseExport(code(snap({ t: Date.parse("2026-10-20T12:00:00Z") / 1000 })))).toMatchObject({ error: expect.stringContaining("beta character") });
  expect(parseExport(code({ ...snap(), gear: [{ s: 1, id: "x" }] }))).toHaveProperty("error");
  expect(parseExport(code(snap()))).toHaveProperty("snap");
});

test("updates, ignores stale uploads, and protects other people's characters", () => {
  const first = applySync("mira-owner", snap());
  if ("error" in first) throw new Error(first.error);

  const stale = applySync("mira-owner", snap({ level: 25, t: first.char.level_at - 3600 }));
  expect(stale).toMatchObject({ unchanged: true });
  expect(getChar("Mira Brightvale")!.level).toBe(20);

  const up = applySync("mira-owner", snap({ level: 21, t: Math.floor(Date.now() / 1000) }));
  expect(up).toMatchObject({ prevLevel: 20 });
  expect(getChar("Mira Brightvale")!.level).toBe(21);

  expect(applySync("someone-else", snap({ t: Math.floor(Date.now() / 1000) + 5 }))).toHaveProperty("error");
});

test("companion endpoint: needs a link code, syncs, throttles", async () => {
  const server = startSyncServer(fakeClient, 0);
  const url = `http://localhost:${server.port}/sync`;
  const post = (token: string | null, body: unknown) =>
    fetch(url, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) });

  expect((await post(null, { exports: [] })).status).toBe(401);
  const linked = JSON.parse(Buffer.from(newLinkCode("app-user", "https://example.com").slice("uwusync-".length), "base64url").toString());
  expect(linked.u).toBe("https://example.com");

  const res = await post(linked.t, { exports: [code(snap({ first: "Thalen" })), "garbage"] });
  expect(res.status).toBe(200);
  const { results } = (await res.json()) as any;
  expect(results.map((r: any) => r.ok)).toEqual([true, false]);
  expect(getChar("Thalen Brightvale")!.user_id).toBe("app-user");

  expect((await post(linked.t, { exports: [] })).status).toBe(429);
  server.stop(true);
});

test("raid progress: first kills announced once, a full clear called out, Hardcore deaths once", () => {
  const lock = (b: string[]) => ({ n: "Barrow Deeps", raid: true, k: b.length, of: 3, reset: Date.now() / 1000 + 86400, b });
  const t = Math.floor(Date.now() / 1000);
  const a = applySync("raider-1", snap({ first: "Raider", last: "One", t, lockouts: [lock(["Gravelord"])] }));
  const again = applySync("raider-2", snap({ first: "Raider", last: "Two", t, lockouts: [lock(["Gravelord", "Bonewhisper"])] }));
  const done = applySync("raider-2", snap({ first: "Raider", last: "Two", t: t + 1, lockouts: [lock(["Gravelord", "Bonewhisper", "The Hollow King"])] }));
  if ("error" in a || "error" in again || "error" in done) throw new Error("sync failed");
  expect(a.firstKills).toEqual([{ raid: "Barrow Deeps", bosses: ["Gravelord"], down: 1, of: 3 }]);
  expect(again.firstKills).toEqual([{ raid: "Barrow Deeps", bosses: ["Bonewhisper"], down: 2, of: 3 }]); // Gravelord wasn't new
  expect(done.firstKills).toEqual([{ raid: "Barrow Deeps", bosses: ["The Hollow King"], down: 3, of: 3 }]);
  const barrow = raidProgress().find((r) => r.raid === "Barrow Deeps")!;
  expect(barrow).toMatchObject({ of: 3, week: 3 });
  expect(barrow.kills.map((k) => [k.boss, k.char_name])).toEqual([["Gravelord", "Raider One"], ["Bonewhisper", "Raider Two"], ["The Hollow King", "Raider Two"]]);
  expect(JSON.stringify(progressEmbed().toJSON())).toContain("Barrow Deeps · 3/3");

  const died = { t, l: 41, z: "Badlands" };
  const rip = applySync("hc-player", snap({ first: "Brave", last: "Soul", t, hc: true, died }));
  const later = applySync("hc-player", snap({ first: "Brave", last: "Soul", t: t + 60, hc: true, died }));
  if ("error" in rip || "error" in later) throw new Error("sync failed");
  expect(rip.death).toEqual(died);
  expect(later.death).toBeUndefined(); // announced only the first time
});

test("a paste code without recipes keeps the ones the app uploaded", () => {
  const t = Math.floor(Date.now() / 1000);
  applySync("crafty", snap({ first: "Crafty", last: "Hands", t, recipes: { Alchemy: ["Minor Healing Potion"] } }));
  applySync("crafty", snap({ first: "Crafty", last: "Hands", t: t + 1 }));
  expect(crafterIndex().get("Minor Healing Potion")?.map((c) => c.name)).toEqual(["Crafty Hands"]);
  expect(parseExport(code(snap({ recipes: { Alchemy: [42] } } as any)))).toHaveProperty("error"); // recipes are validated
});

test("app endpoints: the guild feed hides Discord IDs, and raid signups behave like the buttons", async () => {
  const server = startSyncServer(fakeClient, 0);
  const token = JSON.parse(Buffer.from(newLinkCode("feed-user", "https://example.com").slice("uwusync-".length), "base64url").toString()).t;
  const api = (method: string, path: string, body?: unknown) =>
    fetch(`http://localhost:${server.port}${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as any);
  applySync("feed-user", snap({ first: "Feed", last: "Reader", log: [{ id: 77, n: "Shared", c: false, o: [] }] }));
  const ev = Number(db.run("insert into events (kind, title, starts_at, size, creator_id) values ('raid', 'Hyjal Summit', unixepoch() + 86400, 20, 'officer')").lastInsertRowid);

  const feed = await api("GET", "/guild");
  expect(feed.chars.find((c: any) => c.name === "Feed Reader")).toMatchObject({ mine: true, owner: "Feed Reader", quests: [77] });
  expect(feed.chars.find((c: any) => c.name === "Asha Brightvale")?.mine).toBe(false);
  expect(JSON.stringify(feed)).not.toContain("addon-user"); // Discord user IDs stay on the server
  expect(feed.events.find((e: any) => e.id === ev)).toMatchObject({ title: "Hyjal Summit", going: 0, mine: null });

  expect(await api("POST", "/signup", { event: ev, action: "Healer" })).toEqual({ ok: true, message: "You're in for Hyjal Summit as Healer." });
  expect((await api("GET", "/guild")).events.find((e: any) => e.id === ev)).toMatchObject({ going: 1, roles: { Healer: 1 }, names: ["Feed Reader"], mine: { status: "in", role: "Healer" } });
  expect(await api("POST", "/signup", { event: ev, action: "Healer" })).toEqual({ ok: true, message: "Withdrawn from Hyjal Summit." });
  expect((await api("POST", "/signup", { event: ev, action: "Mage" })).ok).toBe(false);
  expect((await fetch(`http://localhost:${server.port}/guild`)).status).toBe(401);
  server.stop(true);
});
