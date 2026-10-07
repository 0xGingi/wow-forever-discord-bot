import { EmbedBuilder, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { db, getChar, userChars, type Char } from "./db.ts";
import { CLASSES, type ClassName } from "./game.ts";
import type { Snapshot } from "./sync.ts";
import { COLOR, e, icon, notice } from "./ui.ts";

export const definition = new SlashCommandBuilder().setName("quests").setDescription("Quests a character is on right now (synced from the game)")
  .addStringOption((o) => o.setName("name").setDescription("Character (defaults to your main)").setAutocomplete(true));

type Quest = NonNullable<Snapshot["log"]>[number];

const snapshotOf = (c: Char) => {
  const row = db.query<{ data: string }, [number]>("select data from synced where char_id = ?").get(c.id);
  return row ? (JSON.parse(row.data) as Snapshot) : null;
};

/** Quest id -> names of other synced guild members who have it in their log. */
function othersOnQuests(exceptCharId: number) {
  const others = new Map<number, string[]>();
  const rows = db.query<{ name: string; data: string }, [number]>(
    "select c.name, s.data from synced s join chars c on c.id = s.char_id where s.char_id != ?",
  ).all(exceptCharId);
  for (const r of rows) {
    for (const q of (JSON.parse(r.data) as Snapshot).log ?? []) others.set(q.id, [...(others.get(q.id) ?? []), r.name]);
  }
  return others;
}

export function questsEmbed(c: Char) {
  const embed = new EmbedBuilder()
    .setAuthor({ name: `${c.name}'s quest log`, iconURL: icon(c.class) ?? undefined })
    .setColor(CLASSES[c.class as ClassName] ?? COLOR.brand);
  const d = snapshotOf(c);
  if (!d) return embed.setDescription(`${e("note")} Not synced yet. Install the uwucrew Sync addon, then \`/uwu sync\` in game and \`/sync paste\` here.`);
  if (!d.log) return embed.setDescription(`${e("note")} This sync came from an older addon. Update **uwucrew Sync** to share your quest log.`);
  if (!d.log.length) return embed.setDescription(`${e("scroll")} Quest log is empty.`).setTimestamp(d.t * 1000);

  const others = othersOnQuests(c.id);
  const zones = Map.groupBy(d.log, (q) => q.z ?? "Other");
  // Detail levels, most to least: 3 objectives + guildmates + link, 2 guildmates + link, 1 link, 0 title only.
  const line = (q: Quest, detail: number) => {
    const mates = others.get(q.id);
    const also = mates && detail >= 2 ? ` · *also: ${mates.slice(0, 3).join(", ")}${mates.length > 3 ? ` +${mates.length - 3}` : ""}*` : "";
    const title = detail >= 1 ? `[${q.n}](https://www.wowhead.com/forever/quest=${q.id})` : q.n;
    const objectives = q.c || detail < 3 ? [] : q.o.map((o) => `↳ ${o.d ? `~~${o.t}~~` : o.t}`);
    return [`${e(q.c ? "done" : "scroll")} ${title}${q.l ? ` \`${q.l}\`` : ""}${also}`, ...objectives].join("\n");
  };
  // Pack each zone's lines into as many 1024-char fields as it needs (continuations get a blank name).
  const pack = (detail: number) => {
    const fields: { name: string; value: string }[] = [];
    for (const [zone, qs] of zones) {
      let value = "";
      let name = `${zone} · ${qs.length}`;
      for (const l of qs.map((q) => line(q, detail))) {
        if (value && value.length + l.length + 1 > 1024) {
          fields.push({ name, value });
          name = "\u200b"; // continuation of the same zone
          value = "";
        }
        value = value ? `${value}\n${l}` : l.slice(0, 1024);
      }
      fields.push({ name, value });
    }
    return fields;
  };
  const size = (fs: { name: string; value: string }[]) => fs.reduce((n, f) => n + f.name.length + f.value.length, 0);
  // Every quest (up to the game's 40) matters more than detail: shed detail until the whole log fits one embed.
  let fields = pack(3);
  for (let detail = 2; detail >= 0 && (size(fields) > 5500 || fields.length > 25); detail--) fields = pack(detail);
  // Safety net for logs that still don't fit: add fields until the embed is full.
  let total = 0;
  for (const f of fields.slice(0, 25)) {
    total += f.name.length + f.value.length;
    if (total > 5500) break;
    embed.addFields(f);
  }

  const ready = d.log.filter((q) => q.c).length;
  const more = d.logMore ? `\n${e("note")} ${d.logMore} more didn't fit in the paste code. The uwucrew-sync app syncs the full log.` : "";
  return embed
    .setDescription(`**${d.log.length + (d.logMore ?? 0)}** quests · ${e("done")} **${ready}** ready to turn in${more}`)
    .setFooter({ text: "Synced from the game" })
    .setTimestamp(d.t * 1000);
}

export async function quests(i: ChatInputCommandInteraction) {
  const name = i.options.getString("name");
  const c = name ? getChar(name) : userChars(i.user.id)[0];
  if (!c) return i.reply(notice("err", name ? "No character with that name. Pick one from the list." : "You don't have any characters yet. Link the uwucrew Sync addon with `/sync link`."));
  return i.reply({ embeds: [questsEmbed(c)] });
}
