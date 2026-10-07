import { expect, test } from "bun:test";
import { db, getChar } from "./db.ts";
import { extractExports, extractLink } from "./savedvars.ts";
import { applySync, newLinkCode, parseExport, profileEmbed, startSyncServer, userForToken, type Snapshot } from "./sync.ts";

const luajit = Bun.which("luajit");
const fakeClient = { channels: { fetch: async () => null } } as any;

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

test("rejects junk and tampering with a helpful message", () => {
  expect(parseExport("hello")).toHaveProperty("error");
  expect(parseExport("UWU1:{broken")).toHaveProperty("error");
  expect(parseExport(code(snap({ level: 99 })))).toHaveProperty("error");
  expect(parseExport(code(snap({ t: Date.now() / 1000 + 10 * 86400 })))).toHaveProperty("error"); // from the future
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
