<img src="assets/icon.svg" width="64" height="64" alt="">

# uwucrew bot

Discord bot for **uwucrew**, a World of Warcraft: Forever guild.

## Commands

| Command | What it does |
|---|---|
| `/char add/remove/main/prof/list` | Register characters (class, race, role, level, main/alt, professions) |
| `/ding` | Update a character's level and announce it (with a special shout for the first to hit 60) |
| `/leaderboard` | Race to 60: highest levels, ties broken by who got there first |
| `/roster [class] [alts]` | Guild roster grouped by class, with role counts |
| `/crafters <profession>` | Who has a profession, by skill |
| `/event create/cancel` | *(Manage Events)* Raid post with Tank/Healer/DPS/Tentative/Absent buttons and a ping reminder before start. Also shows in Discord's **Events** tab. Can repeat weekly or every 2 weeks (the next one is posted when the current one starts). `cancel series:true` stops the repeats |
| `/sr reserve/list` | One soft reserve per person per raid |
| `/lfg <dungeon> <role>` | 5-man group finder (1 tank / 1 healer / 3 DPS), pings everyone when full |
| `/loot give/history` | Loot log (giving is officer-only) |
| `/attendance` | Signup rate over the last 10 raids |
| `/rolepanel` | *(Manage Roles)* Posts a panel in the current channel: **Join uwucrew** (gives the member role) and toggles for the Tank/Healer/DPS Discord roles, which it creates if missing |
| `/apply` | Application form → officer channel with Accept/Decline (accept grants the member role + DMs them) |
| `/timezone` | Set your timezone once. Search by city (`london`) or by what your clock says right now (`8:15 pm`) |
| `/forever` | Beta end / launch / raid dates, new dungeons and raids |

**Group channels:** `/lfg` and `/event create` each get a private text channel and voice channel (turn off with `channels:false`). Only the organizer and people signed up can see them, and access updates as people join or leave. The channels are deleted `GROUP_TTL_HOURS` after the start time, once voice is empty. They're deleted right away if the event is cancelled or everyone leaves an LFG group. Set `GROUP_CATEGORY_ID` to keep them under one category.

**Bench:** if a raid has a size and it's full, role signups go on the bench. When a spot opens, the oldest bench signup is moved in and DM'd.

**Times:** type them naturally in `/event create when:`, e.g. `friday 8pm`, `tomorrow 20:00`, `nov 10 7:30pm` or `in 2 hours`. They're read in your `/timezone`, or you can name a zone (`sat 9pm CET`). As you type, the autocomplete shows exactly how it was read. Leave it empty to pick from the next week's 8 PM slots. Event posts use Discord timestamps, so everyone sees times in their own timezone.

Click a signup button again to withdraw. Signups use your main character's name. Edit `src/game.ts` as Forever info firms up.

## Setup

1. Create an app at https://discord.com/developers/applications, then add a bot and copy its token.
2. Invite it with the `bot` + `applications.commands` scopes and the **Manage Roles**, **Manage Channels**, **Create Events**, **Send Messages**, and **Embed Links** permissions. Move its role above the member role.
3. `cp .env.example .env` and fill it in (Bun loads `.env` automatically).
4. `bun install && bun start`

### Docker

```sh
docker compose up -d --build        # add --pull to pick up the newest oven/bun:latest
docker compose logs -f
```

The database lives in the `data` volume at `/data/uwucrew.sqlite`. Back it up with `docker compose cp bot:/data/uwucrew.sqlite .`.

Commands register to `GUILD_ID` on startup. On first start the bot uploads the WoW icons in `assets/emoji/` as **application emojis**, which takes about a minute and only happens once. They're owned by the bot, so they work in any server or DM and use none of your server's emoji slots. To add an icon, drop a 56×56 `.jpg` named after a class, race, role or profession (Wowhead's `https://wow.zamimg.com/images/wow/icons/large/<icon>.jpg` works) into that folder and restart. Data lives in a single SQLite file (`DB_PATH`), so back that file up.

Officer = anyone with **Manage Events**. Change who sees `/event` under Server Settings → Integrations.

`bun test` runs the time-parsing, bench and slot-cap checks.
