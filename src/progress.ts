import { EmbedBuilder, type Client } from "discord.js";
import { db, type Char } from "./db.ts";
import { CLASSES, type ClassName } from "./game.ts";
import { bar, COLOR, icon } from "./ui.ts";

export const PROGRESS_CHANNEL_ID = process.env.PROGRESS_CHANNEL_ID || null;

/** Post a level-up to the progress channel (or `fallbackChannelId` if none is set). Returns where it went, or null. */
export async function announceLevelUp(client: Client, embed: EmbedBuilder, fallbackChannelId?: string | null) {
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
