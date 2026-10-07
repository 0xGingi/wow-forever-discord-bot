// CI check: run a built uwucrew-sync binary against a fake WoW folder and a fake bot, and make sure it uploads.
// usage: bun companion/smoke.ts <path to binary>
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = process.argv[2];
if (!bin) throw new Error("usage: bun companion/smoke.ts <binary>");

const dir = mkdtempSync(join(tmpdir(), "uwucrew-smoke-"));
const home = join(dir, "home");
const saved = join(dir, "wow", "_forever_", "WTF", "Account", "SMOKE#1", "SavedVariables");
mkdirSync(home, { recursive: true });
mkdirSync(saved, { recursive: true });

let got: { auth: string | null; exports: string[] } | null = null;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body: any = await req.json();
    got = { auth: req.headers.get("authorization"), exports: body.exports };
    return Response.json({ results: [{ ok: true, message: "**Smoke Test** synced (level 30)." }] });
  },
});

// What WoW writes after /uwu link + a logout: a linked account with one character.
const link = `uwusync-${Buffer.from(JSON.stringify({ u: `http://127.0.0.1:${server.port}`, t: "smoke-token" })).toString("base64url")}`;
await Bun.write(join(saved, "UwucrewSync.lua"),
  `\nUwucrewSyncDB = {\n\t["link"] = "${link}",\n\t["exports"] = {\n\t\t["Smoke Test"] = "UWU1:{\\"first\\":\\"Smoke\\",\\"last\\":\\"Test\\"}",\n\t},\n}\n`);
await Bun.write(join(home, ".uwucrew-sync.json"), JSON.stringify({ wowDir: join(dir, "wow") }));

// os.homedir() reads HOME on macOS/Linux and USERPROFILE on Windows.
const app = Bun.spawn([bin], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdout: "pipe", stderr: "pipe" });
const deadline = Date.now() + 30_000;
while (!got && Date.now() < deadline) await Bun.sleep(200);
app.kill();
server.stop(true);
console.log(await new Response(app.stdout).text(), await new Response(app.stderr).text());
rmSync(dir, { recursive: true, force: true });

const ok = got !== null && (got as any).auth === "Bearer smoke-token" && (got as any).exports?.[0]?.startsWith("UWU1:");
console.log(ok ? "SMOKE OK: found the addon file, read the link, uploaded." : `SMOKE FAILED: ${JSON.stringify(got)}`);
process.exit(ok ? 0 : 1);
