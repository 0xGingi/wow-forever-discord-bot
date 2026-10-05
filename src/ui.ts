import { readdirSync } from "node:fs";
import { join } from "node:path";
import { EmbedBuilder, MessageFlags, type Client } from "discord.js";

// WoW icons from assets/emoji, uploaded as application emojis (bot-owned, work in any server or DM).
const DIR = join(import.meta.dir, "../assets/emoji");
const ids = new Map<string, string>();

// ponytail: matched by name only; to change an existing icon, delete it under the app's Emojis tab in the dev portal and restart.
export async function syncEmojis(client: Client<true>) {
  const existing = await client.application.emojis.fetch();
  for (const f of readdirSync(DIR)) {
    const name = f.replace(/\.\w+$/, "");
    const em = existing.find((x) => x.name === name) ?? (await client.application.emojis.create({ attachment: join(DIR, f), name }));
    ids.set(name, em.id);
  }
}

/** Icon key for a class / race / role / profession: "Night Elf" → "nightelf". */
export const key = (s: string) => s.toLowerCase().replace(/\s/g, "");
/** Inline emoji, or "" before sync / for unknown names. */
export const e = (name: string) => (ids.has(key(name)) ? `<:${key(name)}:${ids.get(key(name))}>` : "");
/** For button .setEmoji(). */
export const emojiId = (name: string) => ids.get(key(name));
/** Image URL for embed authors/thumbnails (titles can't render custom emoji). */
export const icon = (name: string) => (ids.has(key(name)) ? `https://cdn.discordapp.com/emojis/${ids.get(key(name))}.png?size=128` : null);

export const COLOR = { brand: 0xff69b4, epic: 0xa335ee, rare: 0x0070dd, uncommon: 0x1eff00, legendary: 0xff8000, gray: 0x6b6b6b, red: 0xc0392b };

const NOTICE = { ok: ["done", COLOR.uncommon], warn: ["warn", COLOR.legendary], err: ["absent", COLOR.red], info: ["note", COLOR.rare] } as const;
/** Small one-line embed for ephemeral feedback. Extra lines after the first are shown as warnings. */
export function notice(kind: keyof typeof NOTICE, text: string, ...warnings: string[]) {
  const [ic, color] = NOTICE[kind];
  const body = [`${e(ic)} ${text}`, ...warnings.map((w) => `${e("warn")} ${w}`)].join("\n");
  return { embeds: [new EmbedBuilder().setColor(color).setDescription(body)], flags: MessageFlags.Ephemeral as const };
}

/** Join lines up to `max` chars, then "… +N more". */
export function clip(lines: string[], max = 1000) {
  let out = "";
  for (const [n, l] of lines.entries()) {
    const more = `*… +${lines.length - n} more*`;
    if (out.length + l.length + 1 > max - more.length) return out + more;
    out += `${l}\n`;
  }
  return out.trim() || "—";
}

/** ▰▰▰▱▱ style bar. */
export const bar = (frac: number, width = 10) => "▰".repeat(Math.round(frac * width)) + "▱".repeat(width - Math.round(frac * width));
