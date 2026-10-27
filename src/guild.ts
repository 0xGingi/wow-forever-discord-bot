// Guild-wide views built from everyone's synced characters: who can craft what, and what the desktop app shows.
import type { Client } from "discord.js";
import { db, eventSignups, getEvent, upcomingEvents, userChars, type Char, type Event } from "./db.ts";
import { dmPromoted, refreshEventMessage, signUp } from "./events.ts";
import { RAIDS_OPEN, ROLES } from "./game.ts";
import { syncGroup } from "./groups.ts";
import { raidProgress } from "./progress.ts";
import type { Snapshot } from "./savedvars.ts";

type Crafter = { name: string; class: string; user_id: string; prof: string };

/** Recipe name -> characters who know it, from synced recipe lists. */
export function crafterIndex() {
  const index = new Map<string, Crafter[]>();
  // ponytail: parses every synced snapshot per call (autocomplete calls it per keystroke); cache if it ever gets slow.
  const rows = db.query<{ name: string; class: string; user_id: string; data: string }, []>(
    "select c.name, c.class, c.user_id, s.data from synced s join chars c on c.id = s.char_id order by c.level desc, c.name",
  ).all();
  for (const r of rows) {
    for (const [prof, recipes] of Object.entries((JSON.parse(r.data) as Snapshot).recipes ?? {})) {
      for (const recipe of recipes) index.set(recipe, [...(index.get(recipe) ?? []), { name: r.name, class: r.class, user_id: r.user_id, prof }]);
    }
  }
  return index;
}

/** Everything the desktop app's Guild and Raids tabs show, as seen by `userId`. No Discord IDs leave the server. */
export function guildData(userId: string) {
  const rows = db.query<Char & { data: string | null; synced_at: number | null }, []>(
    "select c.*, s.data, s.synced_at from chars c left join synced s on s.char_id = c.id order by c.level desc, c.level_at, c.name",
  ).all();
  const profs = Map.groupBy(db.query<{ char_id: number; prof: string; skill: number }, []>("select * from profs").all(), (p) => p.char_id);
  const owner = new Map<string, string>(); // user -> main's name, so alts read as "Asha's alt"
  for (const r of rows) if (r.is_main || !owner.has(r.user_id)) owner.set(r.user_id, r.name);

  const chars = rows.map((r) => {
    const d = r.data ? (JSON.parse(r.data) as Snapshot) : null;
    return {
      name: r.name, class: r.class, race: r.race, role: r.role, level: r.level, levelAt: r.level_at,
      main: !!r.is_main, mine: r.user_id === userId, owner: owner.get(r.user_id)!, ilvl: d?.ilvl ?? null,
      profs: (profs.get(r.id) ?? []).map((p) => ({ n: p.prof, r: p.skill })),
      syncedAt: r.synced_at, hc: !!d?.hc, diedAt: r.died_at, quests: d?.log?.map((q) => q.id) ?? [],
    };
  });

  const events = upcomingEvents().map((ev) => {
    const signups = eventSignups(ev.id);
    const going = signups.filter((s) => s.status === "in");
    const mine = signups.find((s) => s.user_id === userId);
    return {
      id: ev.id, title: ev.title, description: ev.description, startsAt: ev.starts_at, size: ev.size,
      going: going.length, bench: signups.filter((s) => s.status === "bench").length,
      roles: Object.fromEntries(ROLES.map((r) => [r, going.filter((s) => s.role === r).length])),
      names: going.map((s) => s.char_name),
      mine: mine ? { status: mine.status, role: mine.role } : null,
    };
  });

  const recipes = Object.fromEntries([...crafterIndex()].map(([recipe, who]) => [recipe, who.map((c) => c.name)]));
  return { chars, events, progress: raidProgress(), recipes, raidsOpen: RAIDS_OPEN };
}

const ACTIONS = [...ROLES, "tentative", "absent", "leave"] as string[];

/** Sign up from the app, then update the Discord post just like a button press would. */
export async function appSignup(client: Client, userId: string, eventId: number, action: string) {
  const ev = getEvent(eventId);
  if (!ev || ev.cancelled || ev.kind !== "raid") return { ok: false, message: "That raid isn't open for signups anymore." };
  if (!ACTIONS.includes(action)) return { ok: false, message: "Unknown signup choice." };
  const name = userChars(userId)[0]?.name ?? (await client.users.fetch(userId).catch(() => null))?.displayName ?? "Unknown";
  const r = signUp(ev, userId, action, name);
  if ("error" in r) return { ok: false, message: r.error };
  await refreshEventMessage(client, eventId).catch(console.error);
  await syncGroup(client, eventId).catch(console.error);
  await dmPromoted(client, ev, r.promoted);
  const mine = r.signups.find((s) => s.user_id === userId);
  return { ok: true, message: signupMessage(ev, mine) };
}

function signupMessage(ev: Event, mine?: { status: string; role: string | null }) {
  if (!mine) return `Withdrawn from ${ev.title}.`;
  if (mine.status === "bench") return `${ev.title} is full, so you're on the bench as ${mine.role}. You'll be moved in if a spot opens.`;
  if (mine.status === "in") return `You're in for ${ev.title} as ${mine.role}.`;
  return `Marked ${mine.status} for ${ev.title}.`;
}
