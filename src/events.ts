import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel,
  type Client, type Guild,
} from "discord.js";
import { db, eventSignups, getEvent, type Event, type Signup } from "./db.ts";
import { CLASSES, ROLES, type Role } from "./game.ts";
import { createGroup } from "./groups.ts";
import { addDaysLocal } from "./time.ts";
import { clip, COLOR, e, emojiId, icon } from "./ui.ts";

const LFG_CAPS: Record<Role, number> = { Tank: 1, Healer: 1, DPS: 3 };
const RAID_HOURS = 3; // length shown on Discord's native event

/** LFG role caps: why `role` can't be taken, or null if it can. */
export function slotBlocked(ev: Pick<Event, "kind">, signups: Signup[], userId: string, role: Role): string | null {
  const taken = signups.filter((s) => s.status === "in" && s.user_id !== userId && s.role === role).length;
  return ev.kind === "lfg" && taken >= LFG_CAPS[role] ? `${role} slot is taken.` : null;
}

export const isFull = (ev: Pick<Event, "size">, signups: Signup[], userId: string) =>
  !!ev.size && signups.filter((s) => s.status === "in" && s.user_id !== userId).length >= ev.size;

/** Bench signups (oldest first) that fit into open spots. */
export function toPromote(ev: Pick<Event, "size">, signups: Signup[]) {
  if (!ev.size) return [];
  const open = ev.size - signups.filter((s) => s.status === "in").length;
  return signups.filter((s) => s.status === "bench").slice(0, Math.max(0, open));
}

const PLURAL: Record<Role, string> = { Tank: "Tanks", Healer: "Healers", DPS: "DPS" };

export function renderEvent(ev: Event, signups: Signup[]) {
  const going = signups.filter((s) => s.status === "in");
  const lfg = ev.kind === "lfg";
  const by = (st: Signup["status"]) => signups.filter((s) => s.status === st);
  // One per line with class icons; falls back to a plain comma list for big raids.
  const list = (xs: Signup[]) => {
    if (!xs.length) return "—";
    const rich = xs.map((s) => `${e(s.class ?? "")} ${s.char_name}`.trim()).join("\n");
    return rich.length <= 1024 ? rich : clip([xs.map((s) => s.char_name).join(", ")], 1024);
  };
  const full = lfg && going.length === 5;
  let color: number = lfg ? COLOR.rare : COLOR.epic;
  if (full) color = COLOR.uncommon;
  if (ev.cancelled) color = COLOR.gray;

  const embed = new EmbedBuilder()
    .setAuthor({ name: lfg ? "Looking for Group" : "Raid Signup", iconURL: icon(lfg ? "lfg" : "raid") ?? undefined })
    .setTitle(ev.cancelled ? `~~${ev.title.replace(/^LFG: /, "")}~~ · Cancelled` : ev.title.replace(/^LFG: /, ""))
    .setColor(color)
    .setDescription(
      [
        !lfg && `${e("clock")} <t:${ev.starts_at}:F> · <t:${ev.starts_at}:R>`,
        ev.repeat_days && `${e("repeat")} Repeats ${ev.repeat_days === 7 ? "weekly" : `every ${ev.repeat_days} days`}`,
        ev.text_channel_id && `${e("hearth")} <#${ev.text_channel_id}> · <#${ev.voice_channel_id}>`,
        full && `${e("done")} **Group full, go go go!**`,
        ev.description && `\n> ${ev.description.replace(/\n/g, "\n> ")}`,
      ].filter(Boolean).join("\n") || null,
    )
    .addFields(
      ROLES.map((r) => {
        const n = going.filter((s) => s.role === r).length;
        return { name: `${e(r)} ${PLURAL[r]} · ${n}${lfg ? `/${LFG_CAPS[r]}` : ""}`, value: list(going.filter((s) => s.role === r)), inline: true };
      }),
    )
    .setFooter({ text: `#${ev.id} · ${going.length}${ev.size ? `/${ev.size}` : ""} signed up${lfg ? "" : " · click again to withdraw"}` });

  if (!lfg) {
    const comp = Object.keys(CLASSES)
      .map((c) => [c, going.filter((s) => s.class === c).length] as const)
      .filter(([, n]) => n)
      .map(([c, n]) => `${e(c)} ${n}`)
      .join("   ");
    if (comp) embed.addFields({ name: "Composition", value: comp });
    embed.addFields(
      { name: `${e("bench")} Bench · ${by("bench").length}`, value: list(by("bench")), inline: true },
      { name: `${e("tentative")} Tentative · ${by("tentative").length}`, value: list(by("tentative")), inline: true },
      { name: `${e("absent")} Absent · ${by("absent").length}`, value: list(by("absent")), inline: true },
    );
    embed.setTimestamp(ev.starts_at * 1000);
  }

  const btn = (id: string, label: string, style: ButtonStyle) => {
    const b = new ButtonBuilder().setCustomId(`ev:${ev.id}:${id}`).setLabel(label).setStyle(style).setDisabled(!!ev.cancelled);
    const em = emojiId(id);
    return em ? b.setEmoji({ id: em }) : b;
  };
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(ROLES.map((r) => btn(r, r, ButtonStyle.Secondary)));
  if (lfg) row.addComponents(btn("leave", "Leave", ButtonStyle.Danger));
  else row.addComponents(btn("tentative", "Tentative", ButtonStyle.Secondary), btn("absent", "Absent", ButtonStyle.Secondary));
  return { embeds: [embed], components: [row] };
}

export async function refreshEventMessage(client: Client, id: number) {
  const ev = getEvent(id);
  if (!ev?.channel_id || !ev.message_id) return;
  const ch = await client.channels.fetch(ev.channel_id).catch(() => null);
  if (!ch?.isTextBased()) return;
  const msg = await ch.messages.fetch(ev.message_id).catch(() => null);
  await msg?.edit(renderEvent(ev, eventSignups(id)));
}

type NewEvent = Pick<Event, "kind" | "title" | "description" | "starts_at" | "tz" | "size" | "creator_id" | "channel_id" | "channels" | "repeat_days">;

/** Insert, post the signup message, then add group channels + Discord event. Returns non-fatal problems. */
export async function postEvent(guild: Guild, e: NewEvent, signup?: Pick<Signup, "user_id" | "role" | "char_name">) {
  const ch = await guild.channels.fetch(e.channel_id!).catch(() => null);
  if (!ch?.isSendable()) throw new Error("I can't post in that channel.");
  const id = Number(db.run(
    "insert into events (kind, title, description, starts_at, tz, size, creator_id, channel_id, channels, repeat_days, reminded) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [e.kind, e.title, e.description, e.starts_at, e.tz, e.size, e.creator_id, e.channel_id, e.channels, e.repeat_days, e.kind === "lfg" ? 1 : 0],
  ).lastInsertRowid);
  if (signup) db.run("insert into signups (event_id, user_id, status, role, char_name) values (?, ?, 'in', ?, ?)", [id, signup.user_id, signup.role, signup.char_name]);
  const msg = await ch.send(renderEvent(getEvent(id)!, eventSignups(id)));
  db.run("update events set message_id = ? where id = ?", [msg.id, id]);

  const warnings: string[] = [];
  if (e.channels)
    await createGroup(guild, getEvent(id)!).catch((err) => warnings.push(`Couldn't create group channels (needs Manage Channels + Manage Roles): ${err.message}`));
  if (e.kind === "raid")
    await guild.scheduledEvents.create({
      name: e.title.slice(0, 100),
      scheduledStartTime: e.starts_at * 1000,
      scheduledEndTime: (e.starts_at + RAID_HOURS * 3600) * 1000,
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      entityType: GuildScheduledEventEntityType.External,
      entityMetadata: { location: `Sign up: #${"name" in ch ? ch.name : "raids"}`.slice(0, 100) },
      description: [e.description, msg.url].filter(Boolean).join("\n\n").slice(0, 1000),
    })
      .then((se) => db.run("update events set scheduled_event_id = ? where id = ?", [se.id, id]))
      .catch((err) => warnings.push(`Couldn't add it to Discord's Events tab (needs Create Events): ${err.message}`));
  await msg.edit(renderEvent(getEvent(id)!, eventSignups(id)));
  return { id, warnings };
}

const REMIND_MIN = Number(process.env.REMIND_MINUTES ?? 30);

export async function sendReminders(client: Client) {
  const due = db
    .query<Event, [number]>("select * from events where kind = 'raid' and cancelled = 0 and reminded = 0 and starts_at <= unixepoch() + ?")
    .all(REMIND_MIN * 60);
  for (const ev of due) {
    db.run("update events set reminded = 1 where id = ?", [ev.id]);
    const ch = ev.channel_id ? await client.channels.fetch(ev.channel_id).catch(() => null) : null;
    if (!ch?.isSendable()) continue;
    const pings = eventSignups(ev.id).filter((s) => s.status !== "absent").map((s) => `<@${s.user_id}>`);
    if (pings.length) await ch.send(`${e("clock")} **${ev.title}** starts <t:${ev.starts_at}:R>! Get your consumables ready. ${pings.join(" ")}`).catch(console.error);
  }
}

/** When a repeating raid starts (or would have, if cancelled), post the next one. */
export async function spawnRepeats(client: Client) {
  const due = db.query<Event, []>("select * from events where repeat_days is not null and starts_at <= unixepoch()").all();
  for (const ev of due) {
    db.run("update events set repeat_days = null where id = ?", [ev.id]); // the chain moves to the new event
    const ch = ev.channel_id ? await client.channels.fetch(ev.channel_id).catch(() => null) : null;
    if (!ch || !("guild" in ch)) continue;
    let next = ev.starts_at;
    while (next <= Date.now() / 1000) next = addDaysLocal(next, ev.repeat_days!, ev.tz); // bot was down for a while
    await postEvent(ch.guild, { ...ev, starts_at: next })
      .then((r) => r.warnings.forEach((w) => console.warn(`event #${r.id}: ${w}`)))
      .catch(console.error);
  }
}
