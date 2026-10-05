import { Client, Events, GatewayIntentBits } from "discord.js";
import { applyButton, applySubmit, autocomplete, commands, definitions, eventButton, roleButton } from "./commands.ts";
import { sendReminders, spawnRepeats } from "./events.ts";
import { notice, syncEmojis } from "./ui.ts";
import { cleanupGroups } from "./groups.ts";

const { DISCORD_TOKEN, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !GUILD_ID) throw new Error("Set DISCORD_TOKEN and GUILD_ID (see .env.example)");

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

client.once(Events.ClientReady, async (c) => {
  await syncEmojis(c).catch((err) => console.error("Emoji sync failed, continuing without icons:", err));
  await (await c.guilds.fetch(GUILD_ID)).commands.set(definitions);
  console.log(`Logged in as ${c.user.tag}, ${definitions.length} commands registered`);
  setInterval(() => {
    sendReminders(c).catch(console.error);
    spawnRepeats(c).catch(console.error);
    cleanupGroups(c).catch(console.error);
  }, 60_000);
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    if (i.isChatInputCommand()) await commands[i.commandName]?.(i);
    else if (i.isAutocomplete()) await autocomplete(i);
    else if (i.isModalSubmit() && i.customId === "apply") await applySubmit(i);
    else if (i.isButton()) {
      const [kind, id, action] = i.customId.split(":") as [string, string, string];
      if (kind === "ev") await eventButton(i, Number(id), action);
      if (kind === "app") await applyButton(i, id, action);
      if (kind === "role") await roleButton(i, id);
    }
  } catch (e) {
    console.error(e);
    if (i.isRepliable() && !i.replied && !i.deferred)
      await i.reply(notice("err", "Something broke. Tell an officer!")).catch(() => {});
  }
});

client.login(DISCORD_TOKEN);
