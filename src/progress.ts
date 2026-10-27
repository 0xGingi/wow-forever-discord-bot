import { EmbedBuilder, type Client } from "discord.js";
import { db, type Char } from "./db.ts";
import { CLASSES, RAIDS_OPEN, type ClassName } from "./game.ts";
import type { Snapshot } from "./savedvars.ts";
import { bar, COLOR, icon } from "./ui.ts";

export const PROGRESS_CHANNEL_ID = process.env.PROGRESS_CHANNEL_ID || null;

/** Post to the progress channel (or `fallbackChannelId` if none is set). Returns where it went, or null. */
export async function announce(client: Client, embed: EmbedBuilder, fallbackChannelId?: string | null) {
  const id = PROGRESS_CHANNEL_ID ?? fallbackChannelId;
  const ch = id ? await client.channels.fetch(id).catch(() => null) : null;
  if (!ch?.isSendable()) return null;
  await ch.send({ embeds: [embed] });
  return ch.id;
}

/** Check before saving the new level: true if nobody in the guild had reached 60 yet. */
export const isFirstTo60 = (level: number, prevLevel: number) =>
  level === 60 && prevLevel < 60 && !db.query("select 1 from chars where level = 60").get();

/** The level-up announcement shared by /ding and addon syncs. Call after saving the new level. */
export function levelUpEmbed(c: Char, level: number, who: string, first60: boolean) {
  const { rank } = db.query<{ rank: number }, [number, number]>(
    "select count(*) + 1 rank from chars where level > ? or (level = ? and level_at < unixepoch())",
  ).get(level, level)!;
  let [headline, body, thumb] = [`Ding! Level ${level}`, `**${c.name}** the ${c.race} ${c.class} is now level **${level}**.\n${bar(level / 60, 12)} \`${level}/60\``, "ding"];
  if (level === 60) [headline, body, thumb] = ["Level 60!", `**${c.name}** the ${c.race} ${c.class} hit max level. Welcome to endgame, the raid team awaits uwu`, "level60"];
  if (first60) [headline, body, thumb] = ["First to 60!", `**${c.name}** the ${c.race} ${c.class} is the **first in uwucrew** to hit max level. All hail ${who}!`, "crown"];
  return new EmbedBuilder()
    .setAuthor({ name: c.name, iconURL: icon(c.class) ?? undefined })
    .setColor(level === 60 ? COLOR.legendary : (CLASSES[c.class as ClassName] ?? COLOR.brand))
    .setThumbnail(icon(thumb))
    .setDescription(`## ${headline}\n${body}`)
    .setFooter({ text: `#${rank} in the race to 60 · /leaderboard` });
}

// ---------- raid progress ----------

export type FirstKill = { raid: string; bosses: string[]; down: number; of: number };

/** Record the raid bosses in `snap`'s lockouts. Returns the ones nobody in the guild had killed before, per raid. */
export function recordKills(charName: string, snap: Snapshot): FirstKill[] {
  const first: FirstKill[] = [];
  for (const l of snap.lockouts) {
    if (!l.raid || !l.b?.length) continue;
    const bosses = l.b.filter((boss) => db.run("insert into kills (raid, boss, char_name) values (?, ?, ?) on conflict do nothing", [l.n, boss, charName]).changes);
    if (!bosses.length) continue;
    const down = db.query<{ n: number }, [string]>("select count(*) n from kills where raid = ?").get(l.n)!.n;
    first.push({ raid: l.n, bosses, down, of: l.of });
  }
  return first;
}

export function firstKillEmbed(c: Char, k: FirstKill) {
  const cleared = k.of > 0 && k.down >= k.of;
  const names = k.bosses.map((b) => `**${b}**`).join(", ");
  return new EmbedBuilder()
    .setAuthor({ name: k.raid, iconURL: icon("raid") ?? undefined })
    .setColor(COLOR.legendary)
    .setThumbnail(icon(cleared ? "crown" : "raid"))
    .setDescription(cleared
      ? `## ${k.raid} cleared!\nuwucrew has now killed every boss in ${k.raid}, finishing with ${names}.`
      : `## First kill!\nuwucrew downed ${names} for the first time.\n${bar(k.down / Math.max(1, k.of), 12)} \`${k.down}/${k.of || "?"}\` bosses`)
    .setFooter({ text: `Spotted on ${c.name}'s lockout · /progress` });
}

type RaidState = { raid: string; of: number; week: number; kills: { boss: string; at: number; char_name: string }[] };

/** Every raid the guild has data for: boss count, best clear this week, and first kills in order. */
export function raidProgress(): RaidState[] {
  const now = Date.now() / 1000;
  const raids = new Map<string, RaidState>();
  const get = (raid: string) => raids.get(raid) ?? raids.set(raid, { raid, of: 0, week: 0, kills: [] }).get(raid)!;
  // ponytail: parses every synced snapshot per call; fine for a guild, cache if the roster gets into the thousands.
  for (const { data } of db.query<{ data: string }, []>("select data from synced").all()) {
    for (const l of (JSON.parse(data) as Snapshot).lockouts) {
      if (!l.raid) continue;
      const r = get(l.n);
      r.of = Math.max(r.of, l.of);
      if (l.reset > now) r.week = Math.max(r.week, l.k);
    }
  }
  for (const k of db.query<{ raid: string; boss: string; at: number; char_name: string }, []>("select * from kills order by at").all()) get(k.raid).kills.push(k);
  return [...raids.values()].sort((a, b) => (b.kills.at(-1)?.at ?? 0) - (a.kills.at(-1)?.at ?? 0));
}

export function progressEmbed() {
  const raids = raidProgress();
  const embed = new EmbedBuilder().setAuthor({ name: "uwucrew raid progress", iconURL: icon("raid") ?? undefined }).setColor(COLOR.epic);
  if (!raids.length) return embed.setDescription(`No raid kills yet. Raids open <t:${RAIDS_OPEN / 1000}:R>, and kills show up here as people sync.`);
  for (const r of raids.slice(0, 25)) {
    const down = Math.max(r.kills.length, r.week); // older addons report counts but not boss names
    const of = Math.max(r.of, down);
    const kills = r.kills.map((k) => `${k.boss} <t:${k.at}:d>`).join("\n");
    embed.addFields({ name: `${r.raid} · ${down}/${of || "?"}`, value: `${bar(down / Math.max(1, of), 10)} best this week \`${r.week}/${of || "?"}\`\n${kills}`.slice(0, 1024) });
  }
  return embed.setFooter({ text: "From synced raid lockouts" });
}

// ---------- Hardcore ----------

export function deathEmbed(c: Char, died: NonNullable<Snapshot["died"]>) {
  return new EmbedBuilder()
    .setAuthor({ name: c.name, iconURL: icon(c.class) ?? undefined })
    .setColor(COLOR.gray)
    .setDescription(`## Rest in peace\n**${c.name}** the ${c.race} ${c.class} fell at level **${died.l}**${died.z ? ` in ${died.z}` : ""}. Hardcore is forever. o7`)
    .setTimestamp(died.t * 1000);
}
