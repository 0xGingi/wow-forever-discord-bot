import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrate } from "./db.ts";

test("migrate upgrades a db made by an older version without losing data", () => {
  const old = new Database(":memory:", { strict: true });
  old.run(`
    create table chars (id integer primary key, user_id text not null, name text not null unique collate nocase, class text not null,
      race text not null, role text not null, level integer not null default 1, is_main integer not null default 0);
    create table events (id integer primary key, kind text not null, title text not null, description text, starts_at integer not null,
      size integer, creator_id text not null, channel_id text, message_id text, reminded integer not null default 0, cancelled integer not null default 0);
    insert into chars (user_id, name, class, race, role) values ('u1', 'Gingi', 'Mage', 'Gnome', 'DPS');
    insert into events (kind, title, starts_at, creator_id) values ('raid', 'Onyxia', 1, 'u1');
  `);
  migrate(old);
  migrate(old); // idempotent

  const ev = old.query<Record<string, unknown>, []>("select * from events").get()!;
  expect(ev).toMatchObject({ title: "Onyxia", tz: "UTC", channels: 1, repeat_days: null, text_channel_id: null });
  const c = old.query<{ name: string; level_at: number }, []>("select name, level_at from chars").get()!;
  expect(c.name).toBe("Gingi");
  expect(c.level_at).toBeGreaterThan(1_700_000_000); // backfilled with unixepoch(), not 0
  expect(old.query("select name from sqlite_schema where name = 'users'").get()).toBeTruthy(); // new table created
});
