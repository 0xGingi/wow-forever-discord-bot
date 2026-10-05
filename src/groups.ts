import { ChannelType, OverwriteType, PermissionFlagsBits as P, type Client, type Guild, type OverwriteResolvable } from "discord.js";
import { db, eventSignups, getEvent, type Event } from "./db.ts";
import { e } from "./ui.ts";

const CATEGORY_ID = process.env.GROUP_CATEGORY_ID || null;
const TTL_HOURS = Number(process.env.GROUP_TTL_HOURS ?? 4);
const MEMBER_PERMS = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.Connect, P.Speak, P.Stream];

/** Private to the creator + everyone not marked absent. */
function overwrites(guild: Guild, ev: Event): OverwriteResolvable[] {
  const users = new Set([ev.creator_id, ...eventSignups(ev.id).filter((s) => s.status !== "absent").map((s) => s.user_id)]);
  return [
    { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
    { id: guild.client.user.id, type: OverwriteType.Member, allow: [P.ViewChannel, P.ManageChannels, P.SendMessages, P.Connect] },
    ...[...users].map((id) => ({ id, type: OverwriteType.Member, allow: MEMBER_PERMS })),
  ];
}

export async function createGroup(guild: Guild, ev: Event) {
  const name = ev.title.replace(/^LFG: /, "");
  const base = { parent: CATEGORY_ID, permissionOverwrites: overwrites(guild, ev) };
  const text = await guild.channels.create({
    ...base,
    type: ChannelType.GuildText,
    name: `${name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 80)}-${ev.id}`,
    topic: ev.kind === "raid" ? `${name} — <t:${ev.starts_at}:F>` : name,
  });
  const voice = await guild.channels.create({
    ...base,
    type: ChannelType.GuildVoice,
    name: `${name} #${ev.id}`.slice(0, 100),
    userLimit: ev.kind === "lfg" ? 5 : 0,
  });
  db.run("update events set text_channel_id = ?, voice_channel_id = ? where id = ?", [text.id, voice.id, ev.id]);
  await text.send(`${e("hearth")} **${name}** group chat. Everyone who signs up gets access. These channels are removed ${TTL_HOURS}h after the start, once voice is empty.`);
}

export async function syncGroup(client: Client, id: number) {
  const ev = getEvent(id);
  for (const chId of [ev?.text_channel_id, ev?.voice_channel_id]) {
    const ch = chId ? await client.channels.fetch(chId).catch(() => null) : null;
    if (ch && "permissionOverwrites" in ch) await ch.permissionOverwrites.set(overwrites(ch.guild, ev!));
  }
}

export async function cleanupGroups(client: Client) {
  const due = db.query<Event, [number]>(
    "select * from events where coalesce(text_channel_id, voice_channel_id) is not null and (cancelled = 1 or starts_at + ? < unixepoch())",
  ).all(TTL_HOURS * 3600);
  for (const ev of due) {
    const voice = ev.voice_channel_id ? await client.channels.fetch(ev.voice_channel_id).catch(() => null) : null;
    if (!ev.cancelled && voice?.isVoiceBased() && voice.members.size) continue; // still running, check next minute
    for (const chId of [ev.text_channel_id, ev.voice_channel_id])
      if (chId) await client.channels.fetch(chId).then(async (c) => void (await c?.delete())).catch(() => {});
    db.run("update events set text_channel_id = null, voice_channel_id = null where id = ?", [ev.id]);
  }
}
