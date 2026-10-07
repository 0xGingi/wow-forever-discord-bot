import {
  ActionRowBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, StringSelectMenuBuilder,
  type ApplicationCommand, type ChatInputCommandInteraction, type Collection, type StringSelectMenuInteraction,
} from "discord.js";
import { COLOR, e, emojiId, icon, notice } from "./ui.ts";

// Clickable </command:id> mentions once commands are registered; plain `/command` before that.
const commandIds = new Map<string, string>();
export function setCommandIds(registered: Collection<string, ApplicationCommand>) {
  for (const c of registered.values()) commandIds.set(c.name, c.id);
}
export const cmd = (name: string) => {
  const id = commandIds.get(name.split(" ")[0]!);
  return id ? `</${name}:${id}>` : `\`/${name}\``;
};

type Topic = { label: string; icon: string; blurb: string; body: () => string };

const TOPICS: Record<string, Topic> = {
  start: {
    label: "Getting started",
    icon: "hearth",
    blurb: "New here? Start with these four steps",
    body: () => [
      `**1.** ${e("clock")} ${cmd("timezone")} · tell the bot your timezone (search your city or your current time).`,
      `**2.** ${e("tabard")} ${cmd("char add")} · register your character with first + last name, class, race and role. Or let the uwucrew Sync addon do it (see *Syncing from the game*).`,
      `**3.** ${e("raid")} Click **Tank / Healer / DPS** on any raid post to sign up.`,
      `**4.** ${e("lfg")} ${cmd("lfg")} · find a group for any dungeon.`,
      "",
      `The details for everything are below, and ${cmd("help")} brings this up privately any time.`,
    ].join("\n"),
  },
  chars: {
    label: "Characters",
    icon: "tabard",
    blurb: "Register alts, professions, level-ups",
    body: () => [
      `${cmd("char add")} Register a character. Your first one becomes your main, and signups use your main's name.`,
      `${cmd("char main")} Switch which character is your main.`,
      `${cmd("char prof")} Set a profession and skill (\`0\` removes it).`,
      `${cmd("char list")} See your characters, or someone else's.`,
      `${cmd("char remove")} Delete a character.`,
      "",
      `${e("ding")} ${cmd("ding")} Announce a level up. The first to 60 gets crowned ${e("crown")}`,
      `${e("level60")} ${cmd("leaderboard")} The race to 60.`,
      `${e("tank")} ${cmd("roster")} Everyone by class and role.`,
      `${e("tailoring")} ${cmd("crafters")} Who can craft what, by skill.`,
    ].join("\n"),
  },
  sync: {
    label: "Syncing from the game",
    icon: "hearth",
    blurb: "The uwucrew Sync addon fills in your profile",
    body: () => [
      "Install the **uwucrew Sync** addon and your level, gear, professions, gold, lockouts and reputation sync from the game. Level-ups get announced automatically.",
      "",
      `**Quick way:** in game type \`/uwu sync\`, press Ctrl+C, then ${cmd("sync paste")} here and paste.`,
      `**Automatic way:** ${cmd("sync link")} gives you a code for the uwucrew-sync app. Leave the app running while you play and it syncs every time you log out or \`/reload\`.`,
      "",
      `${e("tabard")} ${cmd("char view")} shows anyone's full synced profile with gear links.`,
      `${e("scroll")} ${cmd("quests")} shows a quest log (up to 40 quests) with objectives, and who else in the guild is on each quest.`,
      "*The game only saves addon data on logout or /reload, so that's when syncs happen.*",
    ].join("\n"),
  },
  raids: {
    label: "Raids & events",
    icon: "raid",
    blurb: "Signing up, bench, reminders, soft reserves",
    body: () => [
      `**Sign up** with the buttons on a raid post: ${e("tank")} Tank, ${e("healer")} Healer, ${e("dps")} DPS, ${e("tentative")} Tentative or ${e("absent")} Absent.`,
      "Click the same button again to withdraw, or another one to switch.",
      "",
      `${e("bench")} **Bench:** if the raid is full you go on the bench, and you're moved in automatically (with a DM) when a spot opens.`,
      `${e("clock")} **Reminder:** everyone signed up gets pinged shortly before start.`,
      `${e("hearth")} **Group channels:** signing up unlocks the raid's private text + voice channels.`,
      `${e("calendar")} Raids also appear in Discord's **Events** tab, where you can click *Interested*.`,
      "",
      `${e("reserve")} ${cmd("sr reserve")} Soft reserve one item per raid. ${cmd("sr list")} shows everyone's.`,
      `${e("scroll")} ${cmd("attendance")} Signup rate over the last 10 raids.`,
    ].join("\n"),
  },
  lfg: {
    label: "Looking for group",
    icon: "lfg",
    blurb: "Find a 5-man for any dungeon",
    body: () => [
      `${cmd("lfg")} Pick a dungeon (every Classic and Forever dungeon is listed with levels), your role and an optional note.`,
      "",
      `${e("tank")} 1 Tank · ${e("healer")} 1 Healer · ${e("dps")} 3 DPS. Click a role on the post to join, or **Leave** to drop out.`,
      `${e("hearth")} Each group gets private text + voice channels that only its members can see.`,
      `${e("done")} Everyone gets pinged when the group is full. Channels clean up a few hours later, or as soon as everyone leaves.`,
    ].join("\n"),
  },
  loot: {
    label: "Loot",
    icon: "loot",
    blurb: "Soft reserves and the loot log",
    body: () => [
      `${e("reserve")} ${cmd("sr reserve")} One soft reserve per person per raid. Reserving again replaces it.`,
      `${e("reserve")} ${cmd("sr list")} See every reserve, with contested items counted.`,
      `${e("loot")} ${cmd("loot history")} Recent loot, or one character's loot.`,
      "",
      `Officers record drops with ${cmd("loot give")}.`,
    ].join("\n"),
  },
  time: {
    label: "Times & timezones",
    icon: "clock",
    blurb: "How times work for everyone",
    body: () => [
      `${e("clock")} Every time the bot posts shows in **your own** timezone automatically.`,
      "",
      `Set yours once with ${cmd("timezone")}. Search a city (\`london\`) or type what your clock says (\`8:15 pm\`).`,
      "",
      "When creating events, type times naturally:",
      "`friday 8pm` · `tomorrow 20:00` · `nov 10 7:30pm` · `in 2 hours` · `sat 9pm CET`",
      "The autocomplete shows exactly how the bot read it before you post.",
    ].join("\n"),
  },
  officers: {
    label: "Officer tools",
    icon: "accept",
    blurb: "Events, applications, roles, loot",
    body: () => [
      `${e("raid")} ${cmd("event create")} Pick a raid or dungeon, then a time (see *Times & timezones*). Size fills in automatically.`,
      `*Options: \`repeat\` weekly or every 2 weeks · \`channels:false\` skips group channels · \`description\` for notes.*`,
      `${e("absent")} ${cmd("event cancel")} Cancels and pings signups. \`series:true\` also stops repeats.`,
      `${e("loot")} ${cmd("loot give")} Record a drop.`,
      "",
      `${e("note")} **Applications** from ${cmd("apply")} arrive in the officer channel with ${e("accept")} Accept / ${e("decline")} Decline. Accepting gives the member role and DMs them.`,
      `${e("tabard")} ${cmd("rolepanel")} Post the Join + Tank/Healer/DPS role buttons in a channel.`,
      `${e("note")} ${cmd("help")} with \`post:true\` posts this whole guide in a channel. Rerun it after updates to replace the old copy.`,
      "",
      "*Officer = anyone with Manage Events.*",
    ].join("\n"),
  },
};

export const definition = new SlashCommandBuilder().setName("help").setDescription("How to use the uwucrew bot")
  .addBooleanOption((o) => o.setName("post").setDescription("Officers: post the guide publicly in this channel"));

const GUIDE_AUTHOR = "uwucrew guide";

function topicEmbed(key: string) {
  const t = TOPICS[key] ?? TOPICS.start!;
  return new EmbedBuilder()
    .setAuthor({ name: GUIDE_AUTHOR, iconURL: icon("tabard") ?? undefined })
    .setTitle(t.label)
    .setColor(COLOR.brand)
    .setThumbnail(icon(t.icon))
    .setDescription(t.body());
}

/** One topic plus a dropdown, for private /help. */
function page(key: string) {
  const menu = new StringSelectMenuBuilder().setCustomId("help").setPlaceholder("Pick a topic…").addOptions(
    Object.entries(TOPICS).map(([k, x]) => ({
      label: x.label, description: x.blurb, value: k, default: k === key, ...(emojiId(x.icon) ? { emoji: { id: emojiId(x.icon)! } } : {}),
    })),
  );
  return {
    embeds: [topicEmbed(key).setFooter({ text: "Pick another topic below" })],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
  };
}

export async function help(i: ChatInputCommandInteraction) {
  if (!i.options.getBoolean("post")) return i.reply({ ...page("start"), flags: MessageFlags.Ephemeral });
  if (!i.memberPermissions?.has(PermissionFlagsBits.ManageEvents)) return i.reply(notice("err", "Only officers can post the guide publicly."));
  const ch = i.channel;
  if (!ch?.isSendable() || !ch.isTextBased()) return i.reply(notice("err", "I can't post in this channel."));
  await i.deferReply({ flags: MessageFlags.Ephemeral });

  // Replace the previous guide so re-running updates the channel instead of stacking copies.
  const recent = await ch.messages.fetch({ limit: 50 }).catch(() => null);
  const old = recent?.filter((m) => m.author.id === i.client.user.id && m.embeds[0]?.author?.name === GUIDE_AUTHOR);
  for (const m of old?.values() ?? []) await m.delete().catch(() => {});

  // One message per section so the channel reads top to bottom, no clicking.
  for (const key of Object.keys(TOPICS)) await ch.send({ embeds: [topicEmbed(key)] });
  const replaced = old?.size ? ` Replaced the previous guide (${old.size} messages).` : "";
  const warn = recent ? [] : ["I couldn't read this channel's history (needs Read Message History), so an older guide wasn't removed."];
  return i.editReply({ embeds: notice(warn.length ? "warn" : "ok", `Guide posted: ${Object.keys(TOPICS).length} sections.${replaced}`, ...warn).embeds });
}

/** Private /help: flip pages in place. Public posted guide: answer privately so nobody changes it for everyone. */
export async function helpSelect(i: StringSelectMenuInteraction) {
  const p = page(i.values[0]!);
  return i.message.flags.has(MessageFlags.Ephemeral) ? i.update(p) : i.reply({ ...p, flags: MessageFlags.Ephemeral });
}
