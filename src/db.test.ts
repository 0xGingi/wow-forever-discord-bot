import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, db, migrate } from "./db.ts";

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

test("daily backups: one readable copy per day, oldest deleted past the limit", () => {
  const dir = mkdtempSync(join(tmpdir(), "uwucrew-backups-"));
  db.run("insert into users values ('backup-user', 'UTC') on conflict do nothing");
  for (const day of ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-03"]) backup(dir, 2, new Date(`${day}T12:00:00Z`));
  expect(readdirSync(dir).sort()).toEqual(["uwucrew-2026-11-02.sqlite", "uwucrew-2026-11-03.sqlite"]);
  const copy = new Database(join(dir, "uwucrew-2026-11-03.sqlite"), { readonly: true });
  expect(copy.query("select tz from users where user_id = 'backup-user'").get()).toEqual({ tz: "UTC" });
  expect(existsSync(join(dir, "uwucrew-2026-11-01.sqlite"))).toBe(false);
});
