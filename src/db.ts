import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const SCHEMA = `
create table if not exists users (
  user_id text primary key,
  tz text not null                -- IANA zone, e.g. America/New_York
);
create table if not exists chars (
  id integer primary key,
  user_id text not null,
  name text not null unique collate nocase,
  class text not null,
  race text not null,
  role text not null,
  level integer not null default 1,
  is_main integer not null default 0,
  level_at integer not null default (unixepoch()), -- when it reached its current level
  died_at integer                                  -- Hardcore death, as the addon reported it
);
create table if not exists profs (
  char_id integer not null references chars(id) on delete cascade,
  prof text not null,
  skill integer not null,
  primary key (char_id, prof)
);
create table if not exists events (
  id integer primary key,
  kind text not null,             -- 'raid' | 'lfg'
  title text not null,
  description text,
  starts_at integer not null,     -- unix seconds
  tz text not null default 'UTC', -- creator's zone, keeps repeats at the same local time
  size integer,
  creator_id text not null,
  channel_id text,
  message_id text,
  text_channel_id text,
  voice_channel_id text,
  channels integer not null default 1,  -- create group channels
  repeat_days integer,                  -- 7 = weekly; next occurrence is posted when this one starts
  scheduled_event_id text,              -- Discord's native event
  reminded integer not null default 0,
  cancelled integer not null default 0
);
create table if not exists signups (
  event_id integer not null references events(id) on delete cascade,
  user_id text not null,
  status text not null,           -- 'in' | 'bench' | 'tentative' | 'absent'
  role text,
  char_name text not null,
  at integer not null default (unixepoch()),
  primary key (event_id, user_id)
);
create table if not exists reserves (
  event_id integer not null references events(id) on delete cascade,
  user_id text not null,
  item text not null,
  primary key (event_id, user_id)
);
create table if not exists synced (
  char_id integer primary key references chars(id) on delete cascade,
  data text not null,             -- latest uwucrew Sync addon snapshot (JSON)
  synced_at integer not null
);
create table if not exists sync_tokens (
  user_id text primary key,
  hash text not null unique       -- sha256 of the companion app's token; the token itself is never stored
);
create table if not exists kills (
  raid text not null,
  boss text not null,
  at integer not null default (unixepoch()),
  char_name text not null,        -- whose sync showed the kill first
  primary key (raid, boss)
);
create table if not exists loot (
  id integer primary key,
  char_name text not null,
  item text not null,
  event_id integer references events(id) on delete set null,
  given_by text not null,
  at integer not null default (unixepoch())
);
`;

type Col = { name: string; type: string; notnull: number; dflt_value: string | null };

/** Create missing tables, then add any columns SCHEMA gained since this db file was made. */
export function migrate(target: Database) {
  target.run(SCHEMA);
  const want = new Database(":memory:");
  want.run(SCHEMA);
  for (const { name: table } of want.query<{ name: string }, []>("select name from sqlite_schema where type = 'table'").all()) {
    const have = new Set(target.query<Col, []>(`pragma table_info(${table})`).all().map((c) => c.name));
    for (const c of want.query<Col, []>(`pragma table_info(${table})`).all()) {
      if (have.has(c.name)) continue;
      // SQLite can't add a column with an expression default like (unixepoch()), so add it with 0 and backfill.
      // ponytail: assumes new columns are nullable or have a default; a bare NOT NULL column needs a hand-written step.
      const expr = c.dflt_value != null && !/^('.*'|-?\d+(\.\d+)?|null)$/i.test(c.dflt_value);
      let def = "";
      if (c.dflt_value != null) def = ` default ${expr ? 0 : c.dflt_value}`;
      target.run(`alter table ${table} add column ${c.name} ${c.type}${c.notnull ? " not null" : ""}${def}`);
      if (expr) target.run(`update ${table} set ${c.name} = (${c.dflt_value})`);
      console.log(`db: added column ${table}.${c.name}`);
    }
  }
  want.close();
}

const DB_PATH = process.env.DB_PATH ?? "uwucrew.sqlite";
export const db = new Database(DB_PATH, { create: true, strict: true });
db.run("pragma journal_mode = wal");
db.run("pragma foreign_keys = on");
migrate(db);

export type Char = { id: number; user_id: string; name: string; class: string; race: string; role: string; level: number; is_main: number; level_at: number; died_at: number | null };
export type Event = {
  id: number; kind: "raid" | "lfg"; title: string; description: string | null; starts_at: number; tz: string; size: number | null;
  creator_id: string; channel_id: string | null; message_id: string | null;
  text_channel_id: string | null; voice_channel_id: string | null;
  channels: number; repeat_days: number | null; scheduled_event_id: string | null; reminded: number; cancelled: number;
};
export type Signup = {
  event_id: number; user_id: string; status: "in" | "bench" | "tentative" | "absent"; role: string | null; char_name: string;
  class?: string | null; // joined from chars for icons
};

export const getTz = (userId: string) => db.query<{ tz: string }, [string]>("select tz from users where user_id = ?").get(userId)?.tz ?? null;
export const setTz = (userId: string, tz: string) =>
  db.run("insert into users values (?, ?) on conflict do update set tz = excluded.tz", [userId, tz]);
export const getChar = (name: string) => db.query<Char, [string]>("select * from chars where name = ?").get(name);
export const userChars = (userId: string) =>
  db.query<Char, [string]>("select * from chars where user_id = ? order by is_main desc, level desc").all(userId);
export const getEvent = (id: number) => db.query<Event, [number]>("select * from events where id = ?").get(id);
export const eventSignups = (id: number) =>
  db.query<Signup, [number]>("select s.*, c.class from signups s left join chars c on c.name = s.char_name where s.event_id = ? order by s.at").all(id);
export const upcomingEvents = () =>
  db.query<Event, []>("select * from events where cancelled = 0 and kind = 'raid' and starts_at > unixepoch() - 43200 order by starts_at").all();

/** Copy the database into `dir` once per day (uwucrew-YYYY-MM-DD.sqlite) and delete all but the newest `keep`. */
export function backup(dir: string, keep = 7, day = new Date()) {
  mkdirSync(dir, { recursive: true });
  const name = `uwucrew-${day.toISOString().slice(0, 10)}.sqlite`;
  const have = readdirSync(dir).filter((f) => /^uwucrew-\d{4}-\d\d-\d\d\.sqlite$/.test(f));
  if (!have.includes(name)) db.run("vacuum into ?", [join(dir, name)]); // a consistent copy, even while the bot writes
  for (const old of [...new Set([...have, name])].sort().slice(0, -keep)) rmSync(join(dir, old));
}

// ponytail: backups sit on the same disk/volume as the database; copy them elsewhere for real disaster recovery.
export function startBackups() {
  if (DB_PATH === ":memory:") return;
  const dir = join(dirname(DB_PATH), "backups");
  const run = () => {
    try {
      backup(dir);
    } catch (err) {
      console.error("Backup failed:", err);
    }
  };
  run();
  setInterval(run, 3600_000); // checks hourly, writes one file a day
}
