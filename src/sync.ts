import { createHash, randomBytes } from "node:crypto";
import {
  ActionRowBuilder, EmbedBuilder, ModalBuilder, SlashCommandBuilder, TextInputBuilder, TextInputStyle,
  type ChatInputCommandInteraction, type Client, type ModalSubmitInteraction,
} from "discord.js";
import { db, getChar, userChars, type Char } from "./db.ts";
import { CLASSES, formatCharName, PROFESSIONS, RACES, type ClassName } from "./game.ts";
import { announceLevelUp, isFirstTo60, levelUpEmbed } from "./progress.ts";
import { PREFIX } from "./savedvars.ts";
import { bar, clip, COLOR, e, icon, notice } from "./ui.ts";

const PUBLIC_URL = process.env.SYNC_PUBLIC_URL?.replace(/\/$/, "");
const COMPANION_URL = process.env.COMPANION_URL;

/** One character as the uwucrew Sync addon reports it. Short keys keep the paste code small. */
export type Snapshot = {
  v: 1; t: number; first: string; last: string; level: number; xp?: number; xpMax?: number;
  class: string; race?: string; raceFile?: string; role?: string; guild?: string;
  money?: number; played?: number; ilvl?: number; quests?: number;
  gear: { s: number; id: number; n?: string; q?: number; l?: number }[];
  profs: { n: string; r: number; m: number }[];
  lockouts: { n: string; raid: boolean; k: number; of: number; reset: number }[];
  reps: { n: string; r: number; p: number; m: number }[];
  /** Current quest log (addon 1.1+). Objectives may be empty in paste codes, which trim them to fit. */
  log?: { id: number; n: string; l?: number; z?: string; c: boolean; o: { t: string; d: boolean }[] }[];
  /** Quests left out of a paste code to make it fit. */
  logMore?: number;
};

// ---------- parsing (trust boundary: anyone can paste anything) ----------

const isNum = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const isStr = (v: unknown, max = 100): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const opt = (v: unknown, ok: (v: unknown) => boolean) => v === undefined || v === null || ok(v);
const list = <T>(v: unknown, max: number, ok: (x: any) => boolean): v is T[] => Array.isArray(v) && v.length <= max && v.every(ok);

export function parseExport(text: string): { snap: Snapshot } | { error: string } {
  const s = text.trim();
  if (!s.startsWith(PREFIX)) return { error: "That isn't a sync code. In game, type `/uwu sync` and copy the whole box." };
  let d: any;
  try {
    d = JSON.parse(s.slice(PREFIX.length));
  } catch {
    return { error: "That sync code is cut off or damaged. Copy the whole box again with Ctrl+A, Ctrl+C." };
  }
  const valid =
    d && d.v === 1 && isNum(d.t) && d.t < Date.now() / 1000 + 86400 &&
    isStr(d.first, 24) && isStr(d.last, 24) && isNum(d.level, 1, 60) && isStr(d.class, 20) &&
    opt(d.race, (v) => isStr(v, 40)) && opt(d.raceFile, (v) => isStr(v, 40)) && opt(d.role, (v) => isStr(v, 10)) && opt(d.guild, (v) => isStr(v, 60)) &&
    ["xp", "xpMax", "money", "played", "ilvl", "quests"].every((k) => opt(d[k], (v) => isNum(v))) &&
    list(d.gear, 19, (g) => isNum(g?.s, 1, 19) && isNum(g?.id, 1) && opt(g?.n, (v) => isStr(v)) && opt(g?.q, (v) => isNum(v, 0, 9)) && opt(g?.l, (v) => isNum(v, 0, 1000))) &&
    list(d.profs, 15, (p) => isStr(p?.n, 40) && isNum(p?.r, 0, 1000) && isNum(p?.m, 0, 1000)) &&
    list(d.lockouts, 50, (l) => isStr(l?.n) && typeof l?.raid === "boolean" && isNum(l?.k, 0, 100) && isNum(l?.of, 0, 100) && isNum(l?.reset)) &&
    list(d.reps, 20, (r) => isStr(r?.n) && isNum(r?.r, 1, 8) && isNum(r?.p, 0, 1e6) && isNum(r?.m, 0, 1e6)) &&
    opt(d.logMore, (v) => isNum(v, 0, 60)) &&
    opt(d.log, (v) => list(v, 60, (q) => isNum(q?.id, 1) && isStr(q?.n, 150) && opt(q?.l, (x) => isNum(x, 0, 100)) && opt(q?.z, (x) => isStr(x)) &&
      typeof q?.c === "boolean" && list(q?.o, 12, (o) => isStr(o?.t, 200) && typeof o?.d === "boolean")));
  if (!valid) return { error: "That sync code doesn't look right. Make sure the uwucrew Sync addon is up to date, then try again." };
  return { snap: d as Snapshot };
}

const RACE_FILES: Record<string, string> = { Scourge: "Undead", NightElf: "Night Elf" };
const squash = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
const findRace = (s?: string) => (s ? RACES.find((r) => squash(r) === squash(s)) : undefined);

// ---------- applying ----------

type Applied = { char: Char; created: boolean; prevLevel: number | null; first60: boolean; unchanged?: boolean };

export function applySync(userId: string, snap: Snapshot): Applied | { error: string } {
  const name = formatCharName(snap.first, snap.last);
  if (!name) return { error: `Couldn't read the name "${snap.first} ${snap.last}".` };
  const cls = Object.keys(CLASSES).find((c) => c.toUpperCase() === snap.class.toUpperCase()) as ClassName | undefined;
  if (!cls) return { error: `Unknown class "${snap.class}".` };
  const existing = getChar(name);
  if (existing && existing.user_id !== userId) return { error: `**${name}** is registered to someone else. Ask an officer if that's wrong.` };

  const prev = existing && db.query<{ data: string }, [number]>("select data from synced where char_id = ?").get(existing.id);
  if (existing && prev && (JSON.parse(prev.data) as Snapshot).t >= snap.t) return { char: existing, created: false, prevLevel: existing.level, first60: false, unchanged: true };

  const race = findRace(snap.race) ?? findRace(RACE_FILES[snap.raceFile ?? ""] ?? snap.raceFile) ?? existing?.race ?? snap.race ?? "Unknown";
  const role = ["Tank", "Healer", "DPS"].includes(snap.role ?? "") ? snap.role! : (existing?.role ?? "DPS");
  const first60 = isFirstTo60(snap.level, existing?.level ?? 0);

  db.transaction(() => {
    if (existing) {
      db.run(
        "update chars set class = ?, race = ?, role = ?, level = ?, level_at = case when level = ? then level_at else unixepoch() end where id = ?",
        [cls, race, role, snap.level, snap.level, existing.id],
      );
    } else {
      db.run("insert into chars (user_id, name, class, race, role, level, is_main) values (?, ?, ?, ?, ?, ?, ?)",
        [userId, name, cls, race, role, snap.level, userChars(userId).length === 0 ? 1 : 0]);
    }
    const id = getChar(name)!.id;
    // The game is the source of truth for professions it reports.
    db.run("delete from profs where char_id = ?", [id]);
    for (const p of snap.profs) {
      const prof = PROFESSIONS.find((x) => x.toLowerCase() === p.n.toLowerCase());
      if (prof) db.run("insert or replace into profs values (?, ?, ?)", [id, prof, p.r]);
    }
    db.run("insert into synced values (?, ?, unixepoch()) on conflict do update set data = excluded.data, synced_at = excluded.synced_at",
      [id, JSON.stringify(snap)]);
  })();
  return { char: getChar(name)!, created: !existing, prevLevel: existing?.level ?? null, first60 };
}

/** Parse, apply and announce one code. Shared by /sync paste and the companion app endpoint. */
export async function syncCode(client: Client, userId: string, text: string, fallbackChannelId?: string | null) {
  const parsed = parseExport(text);
  if ("error" in parsed) return { ok: false as const, message: parsed.error };
  const r = applySync(userId, parsed.snap);
  if ("error" in r) return { ok: false as const, message: r.error };
  if (r.prevLevel !== null && r.char.level > r.prevLevel)
    await announceLevelUp(client, levelUpEmbed(r.char, r.char.level, `<@${userId}>`, r.first60), fallbackChannelId).catch(console.error);
  let what = "synced";
  if (r.created) what = "registered and synced";
  if (r.unchanged) what = "already up to date";
  return { ok: true as const, name: r.char.name, message: `**${r.char.name}** ${what} (level ${r.char.level}).` };
}

// ---------- companion app link codes ----------

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function newLinkCode(userId: string, url: string) {
  const token = randomBytes(24).toString("base64url");
  db.run("insert into sync_tokens values (?, ?) on conflict do update set hash = excluded.hash", [userId, sha(token)]);
  return `uwusync-${Buffer.from(JSON.stringify({ u: url, t: token })).toString("base64url")}`;
}
export const userForToken = (token: string | undefined | null) =>
  token ? (db.query<{ user_id: string }, [string]>("select user_id from sync_tokens where hash = ?").get(sha(token))?.user_id ?? null) : null;

// ---------- HTTP endpoint for the companion app ----------

const lastUpload = new Map<string, number>();

export function startSyncServer(client: Client, port = Number(process.env.SYNC_PORT ?? 8787)) {
  return Bun.serve({
    port,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/health") return new Response("ok");
      if (req.method !== "POST" || path !== "/sync") return new Response("Not found", { status: 404 });
      const userId = userForToken(req.headers.get("authorization")?.replace(/^Bearer\s+/i, ""));
      if (!userId) return Response.json({ error: "This app isn't linked. Run /sync link in Discord and paste the new code." }, { status: 401 });
      // ponytail: in-memory per-user throttle; fine for one bot process.
      if (Date.now() - (lastUpload.get(userId) ?? 0) < 3000) return Response.json({ error: "Slow down a little." }, { status: 429 });
      lastUpload.set(userId, Date.now());
      const raw = await req.text();
      if (raw.length > 512_000) return Response.json({ error: "Upload too large." }, { status: 413 });
      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        return Response.json({ error: "Expected JSON." }, { status: 400 });
      }
      if (!Array.isArray(body?.exports)) return Response.json({ error: "Expected { exports: [...] }." }, { status: 400 });
      const results = [];
      for (const code of body.exports.slice(0, 50)) results.push(await syncCode(client, userId, String(code)));
      return Response.json({ results });
    },
  });
}

// ---------- /sync command ----------

export const definition = new SlashCommandBuilder().setName("sync").setDescription("Sync characters from the uwucrew Sync addon")
  .addSubcommand((s) => s.setName("paste").setDescription("Paste the code from /uwu sync in game"))
  .addSubcommand((s) => s.setName("link").setDescription("Connect your WoW account so all its characters sync automatically"))
  .addSubcommand((s) => s.setName("unlink").setDescription("Disconnect your WoW account from automatic syncing"));

export async function sync(i: ChatInputCommandInteraction) {
  const sub = i.options.getSubcommand();
  if (sub === "paste") {
    return i.showModal(new ModalBuilder().setCustomId("syncpaste").setTitle("Paste your sync code").addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder()
        .setCustomId("code").setLabel("Code from /uwu sync (starts with UWU1:)").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)),
    ));
  }
  if (sub === "unlink") {
    const { changes } = db.run("delete from sync_tokens where user_id = ?", [i.user.id]);
    if (!changes) return i.reply(notice("info", "You haven't linked a WoW account."));
    return i.reply(notice("ok", "Disconnected. Automatic syncing stops until you run `/sync link` again."));
  }
  if (!PUBLIC_URL) return i.reply(notice("err", "Automatic syncing isn't set up on this server yet. Use `/sync paste` for now."));
  const code = newLinkCode(i.user.id, PUBLIC_URL);
  return i.reply({
    ...notice("info", "**Connect your WoW account**", [
      `**1.** In game, type \`/uwu link \` and paste the code below (Ctrl+V), then \`/reload\`.`,
      `**2.** ${COMPANION_URL ? `[Download the uwucrew-sync app](${COMPANION_URL}) and run it` : "Run the uwucrew-sync app"}. Leave it open while you play.`,
      "Every character on that WoW account then syncs to you after each logout or `/reload`. Keep the code private, and running this again replaces it.",
    ].join("\n")),
    content: `\`\`\`\n${code}\n\`\`\``,
  });
}

export async function syncPasteSubmit(i: ModalSubmitInteraction) {
  const r = await syncCode(i.client, i.user.id, i.fields.getTextInputValue("code"), i.channelId);
  return i.reply(notice(r.ok ? "ok" : "err", r.message));
}

// ---------- /char view ----------

const STANDING = ["", "Hated", "Hostile", "Unfriendly", "Neutral", "Friendly", "Honored", "Revered", "Exalted"];
const SLOT = ["", "Head", "Neck", "Shoulders", "Shirt", "Chest", "Waist", "Legs", "Feet", "Wrists", "Hands", "Ring", "Ring", "Trinket", "Trinket", "Back", "Main Hand", "Off Hand", "Ranged", "Tabard"];
const money = (c: number) => `${Math.floor(c / 10000)}${e("gold")} ${Math.floor(c / 100) % 100}${e("silver")} ${c % 100}${e("copper")}`;
const played = (s: number) => `${Math.floor(s / 86400)}d ${Math.floor(s / 3600) % 24}h`;

export function profileEmbed(c: Char) {
  const row = db.query<{ data: string }, [number]>("select data from synced where char_id = ?").get(c.id);
  const embed = new EmbedBuilder()
    .setAuthor({ name: c.name, iconURL: icon(c.class) ?? undefined })
    .setColor(CLASSES[c.class as ClassName] ?? COLOR.brand)
    .setThumbnail(icon(c.class));
  if (!row) {
    return embed.setDescription(`Level ${c.level} ${c.race} ${c.class} · ${e(c.role)} ${c.role}\n\n${e("note")} Not synced yet. Install the uwucrew Sync addon, then \`/uwu sync\` in game and \`/sync paste\` here.`);
  }
  const d = JSON.parse(row.data) as Snapshot;
  const xp = d.level < 60 && d.xpMax ? `\n${bar(d.xp! / d.xpMax, 12)} \`${Math.floor((100 * d.xp!) / d.xpMax)}%\` to ${d.level + 1}` : "";
  embed.setDescription(`**Level ${d.level}** ${c.race} ${c.class} · ${e(c.role)} ${c.role}${d.guild ? ` · <${d.guild}>` : ""}${xp}`);

  const stats = [
    d.ilvl !== undefined && `**Item level** \`${d.ilvl}\``,
    d.money !== undefined && `**Gold** ${money(d.money)}`,
    d.played !== undefined && `**Played** ${played(d.played)}`,
    d.quests !== undefined && `**Quests done** \`${d.quests}\``,
    d.log && `**Quest log** \`${d.log.length}\` active · /quests`,
  ].filter(Boolean);
  if (stats.length) embed.addFields({ name: "Stats", value: stats.join("\n") });

  const gear = d.gear.map((g) => `\`${String(g.l ?? "").padStart(3)}\` [${g.n ?? `Item ${g.id}`}](https://www.wowhead.com/forever/item=${g.id}) *${SLOT[g.s]}*`);
  const half = Math.ceil(gear.length / 2);
  if (gear.length) embed.addFields(
    { name: `${e("loot")} Gear`, value: clip(gear.slice(0, half), 1024), inline: true },
    { name: "​", value: clip(gear.slice(half), 1024) || "​", inline: true },
  );
  if (d.profs.length) embed.addFields({
    name: "Professions",
    value: d.profs.map((p) => `${e(p.n)} ${p.n} \`${p.r}/${p.m}\` ${bar(p.m ? p.r / p.m : 0, 6)}`).join("\n"),
  });
  const now = Date.now() / 1000;
  const locks = d.lockouts.filter((l) => l.reset > now);
  if (locks.length) embed.addFields({
    name: "Lockouts",
    value: clip(locks.map((l) => `${e(l.raid ? "raid" : "dungeon")} ${l.n} \`${l.k}/${l.of}\` · resets <t:${Math.round(l.reset)}:R>`), 1024),
  });
  if (d.reps.length) embed.addFields({
    name: "Reputation",
    value: clip(d.reps.map((r) => `**${r.n}** ${STANDING[r.r]}${r.m ? ` \`${r.p}/${r.m}\`` : ""}`), 1024),
  });
  return embed.setFooter({ text: "Synced from the game" }).setTimestamp(d.t * 1000);
}
