import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, ModalBuilder, PermissionFlagsBits,
  SlashCommandBuilder, TextInputBuilder, TextInputStyle,
  type AutocompleteInteraction, type ButtonInteraction, type ChatInputCommandInteraction, type ModalSubmitInteraction,
} from "discord.js";
import { db, eventSignups, getChar, getEvent, getTz, setTz, upcomingEvents, userChars, type Char } from "./db.ts";
import { isFull, postEvent, refreshEventMessage, renderEvent, slotBlocked, toPromote } from "./events.ts";
import { fmtTime, parseWhen, whenChoices, ZONES, zoneChoices } from "./time.ts";
import { syncGroup } from "./groups.ts";
import { BETA_END, formatCharName, CLASSES, DUNGEONS, findInstance, instanceLabel, LAUNCH, PROFESSIONS, RACES, RAIDS, RAIDS_OPEN, ROLES, type ClassName, type Role } from "./game.ts";
import { bar, clip, COLOR, e, emojiId, icon, notice } from "./ui.ts";
import { cmd, definition as helpDefinition, help } from "./help.ts";
import { announceLevelUp, isFirstTo60, levelUpEmbed, PROGRESS_CHANNEL_ID } from "./progress.ts";
import { profileEmbed, sync, definition as syncDefinition } from "./sync.ts";

const OFFICER_CHANNEL_ID = process.env.OFFICER_CHANNEL_ID;
const MEMBER_ROLE_ID = process.env.MEMBER_ROLE_ID;
const choices = (xs: readonly string[]) => xs.map((x) => ({ name: x, value: x }));
type Cmd = ChatInputCommandInteraction;

const isOfficer = (i: { memberPermissions: Readonly<{ has(p: bigint): boolean }> | null }) =>
  !!i.memberPermissions?.has(PermissionFlagsBits.ManageEvents);
const classColor = (c: string) => CLASSES[c as ClassName] ?? COLOR.brand;
const fmtChar = (c: Char) => `${e(c.class)} **${c.name}** · ${c.level} ${c.race} ${c.class} ${e(c.role)}`;
const dm = (text: string) => ({ embeds: [new EmbedBuilder().setColor(COLOR.brand).setAuthor({ name: "uwucrew", iconURL: icon("tabard") ?? undefined }).setDescription(text)] });
const withEmoji = (b: ButtonBuilder, name: string) => (emojiId(name) ? b.setEmoji({ id: emojiId(name)! }) : b);

// ---------- definitions ----------

const charName = (o: any, desc = "Character name") => o.setName("name").setDescription(desc).setRequired(true).setAutocomplete(true);

export const definitions = [
  new SlashCommandBuilder().setName("char").setDescription("Manage your characters")
    .addSubcommand((s) => s.setName("add").setDescription("Register a character")
      .addStringOption((o) => o.setName("first_name").setDescription("First name, e.g. Asha").setRequired(true).setMinLength(2).setMaxLength(24))
      .addStringOption((o) => o.setName("last_name").setDescription("Second name, e.g. Brightvale").setRequired(true).setMinLength(2).setMaxLength(24))
      .addStringOption((o) => o.setName("class").setDescription("Class").setRequired(true).addChoices(...choices(Object.keys(CLASSES))))
      .addStringOption((o) => o.setName("race").setDescription("Race").setRequired(true).addChoices(...choices(RACES)))
      .addStringOption((o) => o.setName("role").setDescription("Main role").setRequired(true).addChoices(...choices(ROLES)))
      .addIntegerOption((o) => o.setName("level").setDescription("Level").setMinValue(1).setMaxValue(60))
      .addBooleanOption((o) => o.setName("main").setDescription("Is this your main?")))
    .addSubcommand((s) => s.setName("remove").setDescription("Remove a character").addStringOption((o) => charName(o)))
    .addSubcommand((s) => s.setName("main").setDescription("Set your main character").addStringOption((o) => charName(o)))
    .addSubcommand((s) => s.setName("prof").setDescription("Set a profession skill (0 removes it)")
      .addStringOption((o) => charName(o))
      .addStringOption((o) => o.setName("profession").setDescription("Profession").setRequired(true).addChoices(...choices(PROFESSIONS)))
      .addIntegerOption((o) => o.setName("skill").setDescription("Skill level").setRequired(true).setMinValue(0).setMaxValue(500)))
    .addSubcommand((s) => s.setName("view").setDescription("Full profile: gear, professions, lockouts, reputation (synced from the game)")
      .addStringOption((o) => charName(o)))
    .addSubcommand((s) => s.setName("list").setDescription("Show someone's characters")
      .addUserOption((o) => o.setName("user").setDescription("Defaults to you"))),

  new SlashCommandBuilder().setName("ding").setDescription("Announce a level up")
    .addStringOption((o) => charName(o))
    .addIntegerOption((o) => o.setName("level").setDescription("New level").setRequired(true).setMinValue(1).setMaxValue(60)),

  new SlashCommandBuilder().setName("leaderboard").setDescription("Race to 60"),

  new SlashCommandBuilder().setName("roster").setDescription("Guild roster")
    .addStringOption((o) => o.setName("class").setDescription("Filter by class").addChoices(...choices(Object.keys(CLASSES))))
    .addBooleanOption((o) => o.setName("alts").setDescription("Include alts")),

  new SlashCommandBuilder().setName("crafters").setDescription("Who has a profession")
    .addStringOption((o) => o.setName("profession").setDescription("Profession").setRequired(true).addChoices(...choices(PROFESSIONS))),

  new SlashCommandBuilder().setName("event").setDescription("Raid / event scheduling (officers)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageEvents)
    .addSubcommand((s) => s.setName("create").setDescription("Post a raid or event with signups")
      .addStringOption((o) => o.setName("title").setDescription("Raid or dungeon (or anything, e.g. 'Guild meeting')").setRequired(true).setAutocomplete(true).setMaxLength(100))
      .addStringOption((o) => o.setName("when").setDescription("In your timezone: friday 8pm, tomorrow 20:00, nov 10 7:30pm…").setRequired(true).setAutocomplete(true))
      .addIntegerOption((o) => o.setName("size").setDescription("Max signups (defaults to the raid/dungeon size)").setMinValue(1).setMaxValue(80))
      .addStringOption((o) => o.setName("description").setDescription("Notes, requirements…").setMaxLength(1000))
      .addBooleanOption((o) => o.setName("channels").setDescription("Create private text + voice channels for signups (default: yes)"))
      .addIntegerOption((o) => o.setName("repeat").setDescription("Post the next one automatically").addChoices({ name: "weekly", value: 7 }, { name: "every 2 weeks", value: 14 })))
    .addSubcommand((s) => s.setName("cancel").setDescription("Cancel an event")
      .addIntegerOption((o) => o.setName("event").setDescription("Event").setRequired(true).setAutocomplete(true))
      .addBooleanOption((o) => o.setName("series").setDescription("Also stop future repeats (default: just this one)"))),

  new SlashCommandBuilder().setName("lfg").setDescription("Looking for group")
    .addStringOption((o) => o.setName("dungeon").setDescription("Dungeon").setRequired(true).setAutocomplete(true).setMaxLength(100))
    .addStringOption((o) => o.setName("role").setDescription("Your role").setRequired(true).addChoices(...choices(ROLES)))
    .addStringOption((o) => o.setName("note").setDescription("e.g. 'quest run, need Thanes key'").setMaxLength(200)),

  new SlashCommandBuilder().setName("sr").setDescription("Soft reserves")
    .addSubcommand((s) => s.setName("reserve").setDescription("Soft reserve an item for a raid")
      .addIntegerOption((o) => o.setName("event").setDescription("Raid").setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName("item").setDescription("Item name").setRequired(true).setMaxLength(100)))
    .addSubcommand((s) => s.setName("list").setDescription("Show soft reserves for a raid")
      .addIntegerOption((o) => o.setName("event").setDescription("Raid").setRequired(true).setAutocomplete(true))),

  new SlashCommandBuilder().setName("loot").setDescription("Loot log")
    .addSubcommand((s) => s.setName("give").setDescription("Record loot (officers)")
      .addStringOption((o) => charName(o, "Recipient"))
      .addStringOption((o) => o.setName("item").setDescription("Item name").setRequired(true).setMaxLength(100))
      .addIntegerOption((o) => o.setName("event").setDescription("Raid it dropped in").setAutocomplete(true)))
    .addSubcommand((s) => s.setName("history").setDescription("Recent loot")
      .addStringOption((o) => o.setName("name").setDescription("Character").setAutocomplete(true))),

  new SlashCommandBuilder().setName("attendance").setDescription("Raid signup attendance over the last 10 raids"),
  new SlashCommandBuilder().setName("apply").setDescription("Apply to join uwucrew"),
  new SlashCommandBuilder().setName("rolepanel").setDescription("Post the join + Tank/Healer/DPS role buttons in this channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
  new SlashCommandBuilder().setName("timezone").setDescription("Set your timezone so times you type are read correctly")
    .addStringOption((o) => o.setName("zone").setDescription("Search a city or your current time, e.g. 'new york' or '8:15 pm'").setAutocomplete(true)),
  new SlashCommandBuilder().setName("forever").setDescription("WoW Forever dates, dungeons and raids"),
  helpDefinition,
  syncDefinition,
].map((c) => c.toJSON());

// ---------- slash command handlers ----------

async function char(i: Cmd) {
  const sub = i.options.getSubcommand();
  if (sub === "list") {
    const user = i.options.getUser("user") ?? i.user;
    const chars = userChars(user.id);
    if (!chars.length) return i.reply(notice("info", `${user} has no characters yet. Use \`/char add\` to register one.`));
    const profs = db.query<{ char_id: number; prof: string; skill: number }, []>("select * from profs order by skill desc").all();
    const blocks = chars.map((c) => {
      const p = profs.filter((x) => x.char_id === c.id).map((x) => `${e(x.prof)} ${x.prof} \`${x.skill}\``).join("  ");
      return [
        `${e(c.class)} **${c.name}** ${c.is_main ? "`main`" : "`alt`"}`,
        `Level ${c.level} ${c.race} ${c.class} · ${e(c.role)} ${c.role}`,
        p,
      ].filter(Boolean).join("\n");
    });
    const main = chars[0]!;
    return i.reply({
      embeds: [new EmbedBuilder()
        .setAuthor({ name: `${user.displayName}'s characters`, iconURL: user.displayAvatarURL() })
        .setColor(classColor(main.class))
        .setThumbnail(icon(main.class))
        .setDescription(clip(blocks.map((b) => `${b}\n`), 4000))],
    });
  }

  if (sub === "add") {
    const name = formatCharName(i.options.getString("first_name", true), i.options.getString("last_name", true));
    if (!name) return i.reply(notice("err", "First and last names are 2–24 letters each, no spaces or symbols."));
    const existing = getChar(name);
    if (existing) return i.reply(notice("err", `**${existing.name}** is already registered to <@${existing.user_id}>.`));
    const main = i.options.getBoolean("main") ?? userChars(i.user.id).length === 0;
    db.transaction(() => {
      if (main) db.run("update chars set is_main = 0 where user_id = ?", [i.user.id]);
      db.run("insert into chars (user_id, name, class, race, role, level, is_main) values (?, ?, ?, ?, ?, ?, ?)", [
        i.user.id, name, i.options.getString("class", true), i.options.getString("race", true),
        i.options.getString("role", true), i.options.getInteger("level") ?? 1, main ? 1 : 0,
      ]);
    })();
    return i.reply(notice("ok", `Registered ${fmtChar(getChar(name)!)}${main ? " as your main" : ""}.`));
  }

  if (sub === "view") {
    const c = getChar(i.options.getString("name", true));
    return i.reply(c ? { embeds: [profileEmbed(c)] } : notice("err", "No character with that name. Pick one from the list."));
  }

  const c = getChar(i.options.getString("name", true));
  if (!c || (c.user_id !== i.user.id && !isOfficer(i))) return i.reply(notice("err", "That's not one of your characters."));

  if (sub === "remove") {
    db.run("delete from chars where id = ?", [c.id]);
    return i.reply(notice("ok", `Removed ${e(c.class)} **${c.name}**.`));
  }
  if (sub === "main") {
    db.transaction(() => {
      db.run("update chars set is_main = 0 where user_id = ?", [c.user_id]);
      db.run("update chars set is_main = 1 where id = ?", [c.id]);
    })();
    return i.reply(notice("ok", `${e(c.class)} **${c.name}** is now the main.`));
  }
  if (sub === "prof") {
    const prof = i.options.getString("profession", true);
    const skill = i.options.getInteger("skill", true);
    if (skill === 0) db.run("delete from profs where char_id = ? and prof = ?", [c.id, prof]);
    else db.run("insert into profs values (?, ?, ?) on conflict do update set skill = excluded.skill", [c.id, prof, skill]);
    return i.reply(notice("ok", skill ? `${e(prof)} **${c.name}**: ${prof} \`${skill}\`` : `Removed ${e(prof)} ${prof} from **${c.name}**.`));
  }
}

async function ding(i: Cmd) {
  const c = getChar(i.options.getString("name", true));
  if (!c || c.user_id !== i.user.id) return i.reply(notice("err", "That's not one of your characters."));
  const level = i.options.getInteger("level", true);
  const first60 = isFirstTo60(level, c.level);
  db.run("update chars set level = ?, level_at = unixepoch() where id = ?", [level, c.id]);
  const embed = levelUpEmbed(c, level, `${i.user}`, first60);
  if (!PROGRESS_CHANNEL_ID || PROGRESS_CHANNEL_ID === i.channelId) return i.reply({ embeds: [embed] });
  const posted = await announceLevelUp(i.client, embed);
  return i.reply(posted ? notice("ok", `Level ${level} saved and announced in <#${posted}>.`) : { embeds: [embed] });
}

async function leaderboard(i: Cmd) {
  const chars = db.query<Char, []>("select * from chars order by level desc, level_at asc limit 15").all();
  const rank = (n: number) => e(["gold", "silver", "copper"][n] ?? "") || `\`#${n + 1}\``;
  const lines = chars.map((c, n) =>
    `${rank(n)} ${e(c.class)} **${c.name}** \`${String(c.level).padStart(2)}\` ${bar(c.level / 60, 8)}${c.level === 60 ? ` · hit 60 <t:${c.level_at}:R>` : ""}`);
  return i.reply({
    embeds: [new EmbedBuilder()
      .setAuthor({ name: "Race to 60", iconURL: icon("level60") ?? undefined })
      .setColor(COLOR.legendary)
      .setDescription(lines.join("\n") || "Nobody yet. Register with `/char add`, then `/ding` as you level!")
      .setFooter({ text: "Ties go to whoever got there first" })],
  });
}

async function roster(i: Cmd) {
  const cls = i.options.getString("class");
  const alts = i.options.getBoolean("alts") ?? false;
  const chars = db.query<Char, []>("select * from chars order by level desc, name").all()
    .filter((c) => (alts || c.is_main) && (!cls || c.class === cls));
  const byRole = ROLES.map((r) => `${e(r)} **${chars.filter((c) => c.role === r).length}** ${r}`).join("   ");
  const classes = Object.keys(CLASSES).filter((k) => chars.some((c) => c.class === k));
  const embed = new EmbedBuilder()
    .setAuthor({ name: `uwucrew roster${cls ? ` · ${cls}` : ""}`, iconURL: icon(cls ?? "tabard") ?? undefined })
    .setColor(cls ? classColor(cls) : COLOR.brand)
    .setDescription(`**${chars.length}** ${alts ? "characters" : "mains"}\n${byRole}`);
  const budget = Math.min(1000, Math.floor(5000 / Math.max(1, classes.length)));
  for (const k of classes) {
    const xs = chars.filter((c) => c.class === k);
    embed.addFields({ name: `${e(k)} ${k} · ${xs.length}`, value: clip(xs.map((c) => `${e(c.role)} ${c.name} \`${c.level}\``), budget), inline: true });
  }
  return i.reply({ embeds: [embed] });
}

async function crafters(i: Cmd) {
  const prof = i.options.getString("profession", true);
  const rows = db.query<{ name: string; class: string; user_id: string; skill: number }, [string]>(
    "select c.name, c.class, c.user_id, p.skill from profs p join chars c on c.id = p.char_id where p.prof = ? order by p.skill desc",
  ).all(prof);
  return i.reply({
    embeds: [new EmbedBuilder()
      .setAuthor({ name: `${prof} · ${rows.length} crafter${rows.length === 1 ? "" : "s"}`, iconURL: icon(prof) ?? undefined })
      .setColor(COLOR.rare)
      .setDescription(rows.length
        ? clip(rows.map((r) => `${e(r.class)} **${r.name}** \`${String(r.skill).padStart(3)}\` ${bar(r.skill / 300, 6)} <@${r.user_id}>`), 4000)
        : `Nobody has ${prof} yet. Add yours with \`/char prof\`.`)],
  });
}

async function event(i: Cmd) {
  if (i.options.getSubcommand() === "cancel") {
    const ev = getEvent(i.options.getInteger("event", true));
    if (!ev) return i.reply(notice("err", "No such event."));
    const series = i.options.getBoolean("series") ?? false;
    db.run(`update events set cancelled = 1${series ? ", repeat_days = null" : ""} where id = ?`, [ev.id]);
    await refreshEventMessage(i.client, ev.id);
    if (ev.scheduled_event_id) await i.guild!.scheduledEvents.delete(ev.scheduled_event_id).catch(() => {});
    const pings = eventSignups(ev.id).filter((s) => s.status !== "absent").map((s) => `<@${s.user_id}>`).join(" ");
    const more = ev.repeat_days && !series ? " The next one will still be posted as usual." : "";
    return i.reply(`${e("absent")} **${ev.title}** (<t:${ev.starts_at}:F>) is cancelled.${more} ${pings}`);
  }
  const title = i.options.getString("title", true);
  const tz = getTz(i.user.id);
  const when = parseWhen(i.options.getString("when", true), tz);
  if ("error" in when) return i.reply(notice("err", when.error));
  const startsAt = when.at;
  if (startsAt < Date.now() / 1000) return i.reply(notice("err", `That's in the past (${fmtTime(startsAt, tz ?? "UTC")}).`));
  const size = i.options.getInteger("size") ?? findInstance(title)?.size ?? null;
  await i.deferReply({ flags: MessageFlags.Ephemeral }); // channel + Discord event creation can exceed the 3s reply deadline
  const { warnings } = await postEvent(i.guild!, {
    kind: "raid", title, description: i.options.getString("description"), starts_at: startsAt, tz: tz ?? "UTC", size, creator_id: i.user.id,
    channel_id: i.channelId, channels: i.options.getBoolean("channels") === false ? 0 : 1, repeat_days: i.options.getInteger("repeat"),
  });
  return i.editReply({ embeds: notice(warnings.length ? "warn" : "ok", `Posted **${title}** for <t:${startsAt}:F> (<t:${startsAt}:R>).`, ...warnings).embeds });
}

async function lfg(i: Cmd) {
  const dungeon = i.options.getString("dungeon", true);
  const role = i.options.getString("role", true);
  const lv = findInstance(dungeon)?.levels;
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const { warnings } = await postEvent(
    i.guild!,
    {
      kind: "lfg", title: `LFG: ${dungeon}${lv ? ` (${lv})` : ""}`, description: i.options.getString("note"), starts_at: Math.floor(Date.now() / 1000), tz: "UTC",
      size: 5, creator_id: i.user.id, channel_id: i.channelId, channels: 1, repeat_days: null,
    },
    { user_id: i.user.id, role, char_name: displayChar(i) },
  );
  return i.editReply({ embeds: notice(warnings.length ? "warn" : "ok", `Group posted for **${dungeon}**. You're in as ${e(role)} ${role}.`, ...warnings).embeds });
}

async function sr(i: Cmd) {
  const ev = getEvent(i.options.getInteger("event", true));
  if (!ev || ev.kind !== "raid") return i.reply(notice("err", "No such raid."));
  if (i.options.getSubcommand() === "list") {
    const rows = db.query<{ user_id: string; item: string }, [number]>("select user_id, item from reserves where event_id = ? order by item").all(ev.id);
    const items = Map.groupBy(rows, (r) => r.item.toLowerCase());
    const lines = [...items.values()]
      .sort((a, b) => b.length - a.length)
      .map((rs) => `**[${rs[0]!.item}]**${rs.length > 1 ? ` ×${rs.length}` : ""} · ${rs.map((r) => `<@${r.user_id}>`).join(" ")}`);
    return i.reply({
      embeds: [new EmbedBuilder()
        .setAuthor({ name: `Soft reserves · ${ev.title}`, iconURL: icon("reserve") ?? undefined })
        .setColor(COLOR.epic)
        .setDescription(lines.length ? clip(lines, 4000) : "No reserves yet. Use `/sr reserve`.")
        .setFooter({ text: `${rows.length} reserve${rows.length === 1 ? "" : "s"} · one per person` })
        .setTimestamp(ev.starts_at * 1000)],
    });
  }
  if (ev.cancelled || ev.starts_at < Date.now() / 1000) return i.reply(notice("err", "Reserves are closed for that raid."));
  const item = i.options.getString("item", true);
  db.run("insert into reserves values (?, ?, ?) on conflict do update set item = excluded.item", [ev.id, i.user.id, item]);
  return i.reply(notice("ok", `Soft reserved **[${item}]** for **${ev.title}**.`, "One per raid. Reserving again replaces it."));
}

async function loot(i: Cmd) {
  if (i.options.getSubcommand() === "history") {
    const name = i.options.getString("name");
    const rows = db.query<{ char_name: string; class: string | null; item: string; at: number; title: string | null }, [string | null, string | null]>(
      `select l.char_name, c.class, l.item, l.at, e.title from loot l
       left join events e on e.id = l.event_id left join chars c on c.name = l.char_name
       where ? is null or l.char_name = ? collate nocase order by l.at desc limit 25`,
    ).all(name, name);
    return i.reply({
      embeds: [new EmbedBuilder()
        .setAuthor({ name: `Loot history${name ? ` · ${name}` : ""}`, iconURL: icon("loot") ?? undefined })
        .setColor(COLOR.epic)
        .setDescription(rows.length
          ? clip(rows.map((r) => `<t:${r.at}:d> ${e(r.class ?? "")} **${r.char_name}** · **[${r.item}]**${r.title ? ` *(${r.title})*` : ""}`), 4000)
          : "No loot recorded yet.")],
    });
  }
  if (!isOfficer(i)) return i.reply(notice("err", "Only officers can record loot."));
  const c = getChar(i.options.getString("name", true));
  if (!c) return i.reply(notice("err", "Unknown character."));
  const item = i.options.getString("item", true);
  const ev = i.options.getInteger("event");
  db.run("insert into loot (char_name, item, event_id, given_by) values (?, ?, ?, ?)", [c.name, item, ev, i.user.id]);
  return i.reply({
    embeds: [new EmbedBuilder()
      .setAuthor({ name: c.name, iconURL: icon(c.class) ?? undefined })
      .setColor(COLOR.epic)
      .setThumbnail(icon("loot"))
      .setDescription(`${e(c.class)} **${c.name}** receives\n### [${item}]${ev ? `\n*${getEvent(ev)?.title ?? ""}*` : ""}`)],
  });
}

async function attendance(i: Cmd) {
  // ponytail: counts signups, not who actually showed; add a /event attended roll-call if officers want real attendance.
  const raids = db.query<{ id: number }, []>(
    "select id from events where kind = 'raid' and cancelled = 0 and starts_at < unixepoch() order by starts_at desc limit 10",
  ).all();
  if (!raids.length) return i.reply(notice("info", "No past raids yet."));
  const rows = db.query<{ user_id: string; n: number }, []>(
    `select user_id, count(*) n from signups where status = 'in' and event_id in (${raids.map((r) => r.id).join(",")}) group by user_id order by n desc`,
  ).all();
  return i.reply({
    embeds: [new EmbedBuilder()
      .setAuthor({ name: `Attendance · last ${raids.length} raid${raids.length === 1 ? "" : "s"}`, iconURL: icon("calendar") ?? undefined })
      .setColor(COLOR.rare)
      .setDescription(clip(rows.map((r) => `${bar(r.n / raids.length)} \`${String(Math.round((100 * r.n) / raids.length)).padStart(3)}%\` <@${r.user_id}>`), 4000))
      .setFooter({ text: "Based on raid signups" })],
  });
}

async function apply(i: Cmd) {
  const input = (id: string, label: string, style = TextInputStyle.Short, required = true) =>
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(style === TextInputStyle.Short ? 100 : 1000),
    );
  return i.showModal(new ModalBuilder().setCustomId("apply").setTitle("Apply to uwucrew").addComponents(
    input("char", "Character name (first and last)"),
    input("class", "Race / class / spec"),
    input("level", "Current level"),
    input("exp", "WoW experience (classic, raids, etc.)", TextInputStyle.Paragraph),
    input("why", "Why uwucrew? When can you play?", TextInputStyle.Paragraph),
  ));
}

const ROLE_BLURB: Record<Role, string> = { Tank: "Hold aggro, lead pulls", Healer: "Keep everyone standing", DPS: "Make the numbers big" };

// ponytail: role buttons find roles by name; renaming "Tank" etc. in Discord breaks them until /rolepanel recreates them.
async function rolepanel(i: Cmd) {
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  for (const r of ROLES)
    if (!i.guild!.roles.cache.some((x) => x.name === r)) await i.guild!.roles.create({ name: r, mentionable: true, reason: "uwucrew role panel" });
  const btn = (id: string, label: string, style: ButtonStyle) => withEmoji(new ButtonBuilder().setCustomId(`role:${id}`).setLabel(label).setStyle(style), id);
  const rows = [new ActionRowBuilder<ButtonBuilder>().addComponents(ROLES.map((r) => btn(r, r, ButtonStyle.Secondary)))];
  if (MEMBER_ROLE_ID) rows.unshift(new ActionRowBuilder<ButtonBuilder>().addComponents(withEmoji(btn("member", "Join uwucrew", ButtonStyle.Success), "tabard")));
  const ch = i.channel;
  if (!ch?.isSendable()) return i.editReply({ embeds: notice("err", "I can't post in this channel.").embeds });
  await ch.send({
    embeds: [new EmbedBuilder()
      .setAuthor({ name: "uwucrew", iconURL: icon("tabard") ?? undefined })
      .setTitle("Welcome to uwucrew")
      .setColor(COLOR.brand)
      .setThumbnail(i.guild!.iconURL() ?? icon("hearth"))
      .setDescription([
        MEMBER_ROLE_ID && `${e("tabard")} **Join uwucrew** to get the member role and unlock the server.`,
        `${e("note")} Then pick the roles you play. Click again to remove one, and raid leaders can ping them.`,
        `${e("hearth")} New here? ${cmd("help")} shows how everything works.`,
      ].filter(Boolean).join("\n\n"))
      .addFields(ROLES.map((r) => ({ name: `${e(r)} ${r}`, value: ROLE_BLURB[r], inline: true })))],
    components: rows,
  });
  return i.editReply({ embeds: notice(MEMBER_ROLE_ID ? "ok" : "warn", "Role panel posted.", ...(MEMBER_ROLE_ID ? [] : ["MEMBER_ROLE_ID isn't set, so there's no Join button."])).embeds });
}

export async function roleButton(i: ButtonInteraction, which: string) {
  const member = await i.guild!.members.fetch(i.user.id);
  const role = which === "member" ? MEMBER_ROLE_ID && i.guild!.roles.cache.get(MEMBER_ROLE_ID) : i.guild!.roles.cache.find((r) => r.name === which);
  if (!role) return i.reply(notice("err", "That role doesn't exist anymore. Ask an officer to rerun `/rolepanel`."));
  const has = member.roles.cache.has(role.id);
  if (which === "member" && has) return i.reply(notice("info", "You're already a member of uwucrew."));
  const ok = await (has ? member.roles.remove(role) : member.roles.add(role)).then(() => true, () => false);
  if (!ok) return i.reply(notice("err", `I can't manage ${role}. An admin needs to drag my role above it in Server Settings → Roles.`));
  return i.reply(which === "member"
    ? notice("ok", `Welcome to **uwucrew**! Register your characters with ${cmd("char add")}, and see ${cmd("help")} for everything else.`)
    : notice("ok", `${has ? "Removed" : "Added"} ${e(which)} ${role}.`));
}

async function timezone(i: Cmd) {
  const zone = i.options.getString("zone");
  if (!zone) {
    const tz = getTz(i.user.id);
    return i.reply(tz
      ? notice("info", `Your timezone is **${tz.replace(/_/g, " ")}**. It's ${fmtTime(Math.floor(Date.now() / 1000), tz)} there.`)
      : notice("info", "You haven't set a timezone yet. Use `/timezone zone:` and search for your city or current time."));
  }
  if (!ZONES.includes(zone)) return i.reply(notice("err", "Pick a timezone from the list. Search by city (`london`) or by your current time (`8:15 pm`)."));
  setTz(i.user.id, zone);
  return i.reply(notice("ok", `Timezone set to **${zone.replace(/_/g, " ")}**. It's ${fmtTime(Math.floor(Date.now() / 1000), zone)} there.`));
}

async function forever(i: Cmd) {
  const ts = (ms: number) => `<t:${ms / 1000}:D> · <t:${ms / 1000}:R>`;
  return i.reply({
    embeds: [new EmbedBuilder()
      .setAuthor({ name: "World of Warcraft: Forever", iconURL: icon("hearth") ?? undefined })
      .setColor(COLOR.legendary)
      .setThumbnail(icon("raid"))
      .addFields(
        { name: `${e("clock")} Key dates`, value: [`**Beta ends** ${ts(BETA_END)}`, `**Launch** ${ts(LAUNCH)}`, `**Raids open** ${ts(RAIDS_OPEN)}`].join("\n") },
        { name: `${e("dungeon")} New dungeons`, value: DUNGEONS.filter((d) => d.isNew).map((d) => `\`${d.levels}\` ${d.name}`).join("\n"), inline: true },
        { name: `${e("raid")} Raids`, value: RAIDS.map((r) => `\`${String(r.size).padStart(2)}\` ${r.name}${r.isNew ? " *(new)*" : ""} · ${r.opens}`).join("\n"), inline: true },
        { name: `${e("dungeon")} Classic dungeons`, value: `${DUNGEONS.filter((d) => !d.isNew).length} more, retuned for Forever. Use \`/lfg\` to browse them.` },
      )],
  });
}

export const commands: Record<string, (i: Cmd) => Promise<unknown>> = { char, ding, leaderboard, roster, crafters, event, lfg, sr, loot, attendance, apply, rolepanel, timezone, forever, help, sync };

// ---------- autocomplete ----------

export async function autocomplete(i: AutocompleteInteraction) {
  const f = i.options.getFocused(true);
  const q = f.value.toLowerCase();
  const match = (xs: { name: string; value: string | number }[]) => i.respond(xs.filter((x) => x.name.toLowerCase().includes(q)).slice(0, 25));

  if (f.name === "when") return i.respond(whenChoices(f.value, getTz(i.user.id)));
  if (f.name === "zone") return i.respond(zoneChoices(f.value));
  const tz = getTz(i.user.id) ?? "UTC";
  if (f.name === "event") return match(upcomingEvents().map((e) => ({ name: `#${e.id} ${e.title} · ${fmtTime(e.starts_at, tz)}`.slice(0, 100), value: e.id })));
  if (f.name === "dungeon") return match(DUNGEONS.map((d) => ({ name: instanceLabel(d), value: d.name })));
  if (f.name === "title") return match([...RAIDS, ...DUNGEONS].map((x) => ({ name: instanceLabel(x).slice(0, 100), value: x.name })));
  if (f.name === "name") {
    const all = i.commandName === "loot" || i.options.getSubcommand(false) === "view" || isOfficer(i);
    const chars = all ? db.query<Char, []>("select * from chars order by name").all() : userChars(i.user.id);
    return match(chars.map((c) => ({ name: `${c.name} (${c.level} ${c.class})`, value: c.name })));
  }
  return i.respond([]);
}

// ---------- buttons & modals ----------

const displayChar = (i: { user: { id: string; displayName: string }; member: unknown }) =>
  userChars(i.user.id)[0]?.name ?? ((i.member as { displayName?: string } | null)?.displayName ?? i.user.displayName);

export async function eventButton(i: ButtonInteraction, id: number, action: string) {
  const ev = getEvent(id);
  if (!ev || ev.cancelled) return i.reply(notice("err", "This event is no longer active."));
  const before = eventSignups(id);
  const mine = before.find((s) => s.user_id === i.user.id);
  const isRole = (ROLES as readonly string[]).includes(action);
  const role = isRole ? action : null;
  const same = mine && (isRole ? mine.role === role && ["in", "bench"].includes(mine.status) : mine.status === action);
  let benched = false;

  if (action === "leave" || same) {
    db.run("delete from signups where event_id = ? and user_id = ?", [id, i.user.id]);
  } else {
    const blocked = isRole && slotBlocked(ev, before, i.user.id, action as Role);
    if (blocked) return i.reply(notice("err", blocked));
    benched = isRole && isFull(ev, before, i.user.id);
    let status = action;
    if (isRole) status = benched ? "bench" : "in";
    db.run(
      `insert into signups (event_id, user_id, status, role, char_name) values (?, ?, ?, ?, ?)
       on conflict do update set status = excluded.status, role = excluded.role, char_name = excluded.char_name, at = unixepoch()`,
      [id, i.user.id, status, role, displayChar(i)],
    );
  }
  const promoted = toPromote(ev, eventSignups(id));
  for (const s of promoted) db.run("update signups set status = 'in' where event_id = ? and user_id = ?", [id, s.user_id]);
  const signups = eventSignups(id);
  if (ev.kind === "lfg" && !signups.length) db.run("update events set cancelled = 1 where id = ?", [id]); // last one out; cleanup deletes channels
  await i.update(renderEvent(getEvent(id)!, signups));
  await syncGroup(i.client, id).catch(console.error);
  if (benched) await i.followUp(notice("info", `The raid is full, so you're on the ${e("bench")} **bench** as ${e(role!)} ${role}.`, "You'll be moved in and DM'd if a spot opens."));
  for (const s of promoted)
    await i.client.users.send(s.user_id, dm(`${e("done")} A spot opened in **${ev.title}** (<t:${ev.starts_at}:F>).\nYou're in as ${e(s.role ?? "")} **${s.role}**!`)).catch(() => {});
  const going = signups.filter((s) => s.status === "in");
  if (ev.kind === "lfg" && going.length === 5 && isRole)
    await i.followUp(`${e("lfg")} **Group ready for ${ev.title.replace("LFG: ", "")}!** ${going.map((s) => `<@${s.user_id}>`).join(" ")}`);
}

export async function applySubmit(i: ModalSubmitInteraction) {
  if (!OFFICER_CHANNEL_ID) return i.reply(notice("err", "Applications aren't set up yet. Ping an officer!"));
  const ch = await i.client.channels.fetch(OFFICER_CHANNEL_ID);
  if (!ch?.isSendable()) return i.reply(notice("err", "Couldn't reach the officer channel. Ping an officer!"));
  const v = (id: string) => i.fields.getTextInputValue(id);
  const btn = (id: string, label: string, style: ButtonStyle) =>
    withEmoji(new ButtonBuilder().setCustomId(`app:${i.user.id}:${id}`).setLabel(label).setStyle(style), id);
  await ch.send({
    embeds: [new EmbedBuilder()
      .setAuthor({ name: `${i.user.displayName} applied`, iconURL: i.user.displayAvatarURL() })
      .setTitle(v("char"))
      .setColor(COLOR.brand)
      .setThumbnail(icon("note"))
      .setDescription(`${i.user} · \`${i.user.tag}\``)
      .addFields(
        { name: "Race / class / spec", value: v("class"), inline: true },
        { name: "Level", value: v("level"), inline: true },
        { name: "Experience", value: v("exp") },
        { name: "Why uwucrew / availability", value: v("why") },
      )
      .setTimestamp()],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(btn("accept", "Accept", ButtonStyle.Success), btn("decline", "Decline", ButtonStyle.Danger))],
  });
  return i.reply(notice("ok", "Application sent! An officer will get back to you soon."));
}

export async function applyButton(i: ButtonInteraction, userId: string, action: string) {
  if (!isOfficer(i)) return i.reply(notice("err", "Only officers can review applications."));
  const accepted = action === "accept";
  const member = await i.guild?.members.fetch(userId).catch(() => null);
  let note = "";
  if (accepted && MEMBER_ROLE_ID) await member?.roles.add(MEMBER_ROLE_ID).catch((err) => (note = ` (couldn't add role: ${err.message})`));
  await member?.send(dm(accepted
    ? `${e("tabard")} **Welcome to uwucrew!** Your application was accepted.\nRegister your characters with \`/char add\`.`
    : `Thanks for applying to **uwucrew**. Unfortunately we can't take you right now. Good luck out there!`)).catch(() => (note += " (DMs closed)"));
  const embed = EmbedBuilder.from(i.message.embeds[0]!)
    .setColor(accepted ? COLOR.uncommon : COLOR.red)
    .addFields({ name: `${e(action)} ${accepted ? "Accepted" : "Declined"}`, value: `by ${i.user}${member ? "" : " (user left the server)"}${note}` });
  return i.update({ embeds: [embed], components: [] });
}
