# uwucrew bot

Discord bot for **uwucrew**, a World of Warcraft: Forever guild.

## Commands

| Command | What it does |
|---|---|
| `/help [post]` | In-Discord guide: quick start plus topic pages (characters, raids, LFG, loot, timezones, officer tools). `post:true` *(Manage Events)* posts the full guide in the current channel, one message per section. Rerun it to update the guide; it replaces its previous messages |
| `/char add/remove/main/prof/list/view` | Register characters by Forever's first + last name (e.g. *Asha Brightvale*), with class, race, role, level, main/alt and professions. `view` shows a synced profile: gear (linked to Wowhead), item level, professions, gold, played time, lockouts, reputation |
| `/sync paste/link/unlink` | Sync characters from the uwucrew Sync addon: paste the in-game code, or link the companion app for automatic syncs |
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

## uwucrew Sync addon

`addon/UwucrewSync` is a WoW Forever addon (interface `16001`) that records each character's level, XP, class, race, role, guild, gear and item level, professions, gold, time played, quests completed, dungeon/raid lockouts and top reputations.

WoW addons can't use the internet, so data reaches the bot one of two ways:

- **Paste:** `/uwu sync` in game shows a code; `/sync paste` in Discord takes it. Works with no setup.
- **Companion app:** `/sync link` gives a private link code. The `uwucrew-sync` app watches the addon's SavedVariables file (written on every logout and `/reload`) and uploads it. Needs `SYNC_PUBLIC_URL` pointing at the bot's sync port (`8787` inside the container) over HTTPS, e.g. through a reverse proxy or tunnel. With Docker, the bundled Cloudflare Tunnel (below) is the easiest way.

Synced characters are created or updated automatically; professions follow what the game reports; level-ups are announced in `PROGRESS_CHANNEL_ID` (or the channel used for `/sync paste`). Characters registered to another Discord user can't be overwritten.

Linking: `/sync link` in Discord gives a private code; `/uwu link <code>` in game ties that WoW account (all its characters) to the Discord user. The app reads the link from the addon's saved file, so it needs no setup, and several WoW accounts on one PC can each sync to a different person.

### Downloads and CI

GitHub Actions builds each part when its code changes, and pushes from `main` update the rolling **[latest release](../../releases/tag/latest)**:

| Workflow | Triggered by | Output |
|---|---|---|
| `addon.yml` | `addon/**` | Runs the addon against the fake WoW API, then `UwucrewSync.zip` |
| `companion.yml` | `companion/**`, `src/savedvars.ts` | `uwucrew-sync` for Windows, Mac (Apple Silicon + Intel, ad-hoc signed) and Linux, each smoke-tested on its own OS |
| `server.yml` | `src/**`, `Dockerfile`, deps | Typecheck + tests, then `ghcr.io/0xgingi/wow-forever-discord-bot` |

Set `COMPANION_URL` to the release page so `/sync link` shows players where to download. Players can only download if the repo (or a mirror of the release) is public.

Local builds: `bun run build:addon` and `bun run build:companion`. Cross-compiling needs a stable Bun; with a canary build, run it in Docker: `docker run --rm -v "$PWD":/app -w /app oven/bun:latest bun run build:companion`.

### Public URL (Cloudflare Tunnel)

`compose.yaml` includes an optional `cloudflared` service. Create a tunnel in Cloudflare Zero Trust, add a public hostname pointing at `http://bot:8787`, then set `COMPOSE_PROFILES=tunnel`, `CLOUDFLARE_TUNNEL_TOKEN` and `SYNC_PUBLIC_URL=https://<that hostname>` in `.env`. No ports are opened on the host.

## Setup

1. Create an app at https://discord.com/developers/applications, then add a bot and copy its token.
2. Invite it with the `bot` + `applications.commands` scopes and the **Manage Roles**, **Manage Channels**, **Create Events**, **Send Messages**, **Read Message History** and **Embed Links** permissions. Move its role above the member role.
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

`bun run test` runs the time-parsing, bench, slot-cap, migration and sync checks. The sync test runs the real addon against a fake WoW API (`addon/test/harness.lua`) when `luajit` is installed.
