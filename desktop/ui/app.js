// The window: renders whatever state the app sends, and turns clicks into actions. Re-renders fully on each change.
const $app = document.getElementById("app");
let S = null; // latest state from the app
let tab = "chars";
let selected = localStorage.getItem("char");
let error = "";
let draft = ""; // link code being typed
let craftQuery = ""; // the Guild tab's "who can craft" search
let deferred = false;
let holding = false;
let lastView = "";
const flashed = new Map(); // character -> sync time already highlighted

// ---------- game data ----------

const CLASSES = {
  WARRIOR: ["Warrior", "#c69b6d"], PALADIN: ["Paladin", "#f48cba"], HUNTER: ["Hunter", "#aad372"],
  ROGUE: ["Rogue", "#fff468"], PRIEST: ["Priest", "#ffffff"], SHAMAN: ["Shaman", "#0070dd"],
  MAGE: ["Mage", "#3fc7eb"], WARLOCK: ["Warlock", "#8788ee"], DRUID: ["Druid", "#ff7c0a"],
};
const QUALITY = ["#9d9d9d", "#ffffff", "#1eff00", "#0070dd", "#a335ee", "#ff8000", "#e6cc80", "#00ccff"];
const STANDING = [null, ["Hated", "#cc2222"], ["Hostile", "#ff3b3b"], ["Unfriendly", "#ee6622"], ["Neutral", "#e8c547"],
  ["Friendly", "#3cc43c"], ["Honored", "#00c08a"], ["Revered", "#00c3c3"], ["Exalted", "#2fc5ff"]];
const SLOTS = { 1: "Head", 2: "Neck", 3: "Shoulder", 5: "Chest", 6: "Waist", 7: "Legs", 8: "Feet", 9: "Wrist", 10: "Hands",
  11: "Finger", 12: "Finger", 13: "Trinket", 14: "Trinket", 15: "Back", 16: "Main hand", 17: "Off hand", 18: "Ranged" };
const DOLL = { left: [1, 2, 3, 15, 5, 9], right: [10, 6, 7, 8, 11, 12, 13, 14], weapons: [16, 17, 18] }; // the in-game paper doll's order
const WOWHEAD = "https://www.wowhead.com/forever";
const ICON_URL = (name) => `https://wow.zamimg.com/images/wow/icons/medium/${name}.jpg`;

// Classic quest colours: red/orange above you, yellow around your level, green below, grey once it gives no XP.
// ponytail: grey uses Classic's mob grey-level formula; Forever's exact quest ranges aren't published.
function difficulty(questLevel, level) {
  const d = questLevel - level;
  if (d >= 5) return "#ff1a1a";
  if (d >= 3) return "#ff8040";
  if (d >= -2) return "#ffff00";
  return questLevel <= greyLevel(level) ? "#808080" : "#40c040";
}
function greyLevel(level) {
  if (level <= 5) return 0;
  if (level <= 39) return level - Math.floor(level / 10) - 5;
  if (level <= 59) return level - Math.floor(level / 5) - 1;
  return level - 9;
}

// ---------- helpers ----------

const LINKED = { game: "Linked in game", app: "Linked" };
const LINKED_DETAIL = { game: "Linked in game with /uwu link", app: "Uses the link above" };

const h = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = (v) => Number(v ?? 0).toLocaleString();
const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z]/g, "");
const img = (name, cls = "") => `<img class="${cls}" src="emoji/${slug(name)}.jpg" alt="">`;
const charName = (c) => [c.first, c.last].filter(Boolean).join(" ");
const classOf = (c) => CLASSES[String(c.class).toUpperCase()] ?? [String(c.class ?? "").replace(/^./, (x) => x.toUpperCase()), "#c9cbe0"];
const raceIcon = (c) => ({ scourge: "undead" })[slug(c.raceFile)] ?? slug(c.raceFile ?? c.race);
const gameName = (g) => g.replace(/^_|_$/g, "").replace(/_/g, " ").replace(/^./, (x) => x.toUpperCase());
const host = (url) => new URL(url).host;
const check = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function rel(ms) {
  const s = (ms - Date.now()) / 1000, a = Math.abs(s);
  if (a < 45) return "just now";
  if (a < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (a < 86400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
}
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function money(copper) {
  const parts = [[Math.floor(copper / 10000), "gold"], [Math.floor(copper / 100) % 100, "silver"], [copper % 100, "copper"]].filter(([v]) => v);
  return (parts.length ? parts : [[0, "copper"]]).map(([v, coin]) => `<span class="coin">${num(v)}${img(coin)}</span>`).join(" ");
}
function played(s) {
  const d = Math.floor(s / 86400), hr = Math.floor(s / 3600) % 24, m = Math.floor(s / 60) % 60;
  if (d) return `${d}d ${hr}h`;
  if (hr) return `${hr}h ${m}m`;
  return `${m}m`;
}

const panel = (title, body, aside = "") =>
  `<section class="panel"><header><h2>${title}</h2>${aside ? `<span class="panel-aside">${aside}</span>` : ""}</header>${body}</section>`;
const bar = (label, value, frac, color) =>
  `<li><div class="bar-label"><span>${label}</span><span class="bar-value">${value}</span></div>` +
  `<div class="bar" style="--bar:${color}"><div style="width:${Math.max(0, Math.min(1, frac || 0)) * 100}%"></div></div></li>`;
const toggle = (act, on, title, hint) =>
  `<label class="toggle"><input type="checkbox" role="switch" data-act="${act}" ${on ? "checked" : ""}><span><span class="row-title">${title}</span><span class="muted">${hint}</span></span></label>`;
const linkForm = () =>
  `<form class="link-form"><input type="text" value="${h(draft)}" placeholder="uwusync-…" spellcheck="false" autocomplete="off" aria-label="Link code from /sync link"><button class="btn primary">Save link</button></form>`;
const errorLine = () => (error ? `<p class="error" role="alert">${h(error)}</p>` : "");

// ---------- top bar and roster ----------

function addonStatus() {
  const ad = S.addon;
  if (!S.wowFound) return "WoW not found";
  if (ad.busy) return "Checking the addon…";
  if (!ad.installed) return "Addon not installed";
  if (ad.outdated) return `Addon ${ad.installed}, update ready`;
  return `Addon ${ad.installed}`;
}

function syncStatus(problem, last) {
  if (problem) return "Sync needs attention";
  if (last) return `Synced ${rel(last)}`;
  return "Waiting for a logout or /reload";
}

function topbar() {
  const addonOk = S.wowFound && S.addon.installed && !S.addon.outdated;
  const problem = S.accounts.some((a) => a.status && !a.status.ok);
  const last = Math.max(0, ...S.accounts.map((a) => (a.status?.ok ? a.status.at : 0)));
  return `<header class="top">
    <div class="brand"><span class="mark">uwu</span><span class="brand-name">uwucrew Sync</span></div>
    <nav class="tabs" role="tablist">
      ${[["chars", "Characters"], ["guild", "Guild"], ["raids", "Raids"], ["settings", "Settings"]]
        .map(([id, label]) => `<button role="tab" aria-selected="${tab === id}" data-tab="${id}">${label}</button>`).join("")}
    </nav>
    <div class="status">
      <span class="state ${addonOk ? "" : "warn"}">${h(addonStatus())}</span>
      <span class="state ${problem || !last ? "warn" : ""}">${h(syncStatus(problem, last))}</span>
      ${S.updateReady ? `<button class="btn primary" data-act="installUpdate" title="Version ${h(S.updateReady)} is downloaded">Restart to update</button>` : ""}
      <button class="btn" data-act="syncNow" ${S.accounts.length ? "" : "disabled"}>Sync now</button>
    </div>
  </header>`;
}

function roster(all, current) {
  if (!S.accounts.length) return `<aside class="roster"><p class="roster-foot">Your characters show up here after you log out of WoW or type /reload.</p></aside>`;
  const games = new Set(S.accounts.map((a) => a.game)).size > 1;
  const accounts = S.accounts.map((a) => {
    const rows = all.filter((x) => x.a === a).map(({ c, key, sync }) => {
      const [cls, color] = classOf(c);
      const fresh = sync?.ok && sync.at > (flashed.get(key) ?? 0) && Date.now() - sync.at < 5000;
      if (sync) flashed.set(key, sync.at);
      return `<button class="char ${current?.key === key ? "on" : ""} ${fresh ? "fresh" : ""}" data-char="${h(key)}" style="--cls:${color}">
        ${img(c.class, "char-icon")}
        <span class="char-text"><span class="char-name">${h(charName(c))}</span><span class="char-sub">${h(c.race)} ${h(cls)}</span></span>
        <span class="char-level" title="Level">${num(c.level)}</span>
        ${sync && !sync.ok ? `<span class="char-warn" title="${h(sync.message)}">Not synced</span>` : ""}
      </button>`;
    });
    return `<section class="account">
      <header><span>${h(a.name)}${games ? ` <span class="faint">${h(gameName(a.game))}</span>` : ""}</span><span class="${a.linkedBy ? "" : "warn"}">${LINKED[a.linkedBy] ?? "Not linked"}</span></header>
      ${rows.join("")}
    </section>`;
  });
  return `<aside class="roster">${accounts.join("")}<p class="roster-foot">Syncs each time you log out or type /reload.</p></aside>`;
}

// ---------- character sheet ----------

function sheet({ a, c, sync }) {
  const [cls, color] = classOf(c);
  let banner = "";
  if (!a.linkedBy) banner = `<div class="banner"><p>This WoW account isn't linked to Discord, so ${h(c.first)} isn't syncing.</p><button class="btn primary" data-tab="settings">Link it</button></div>`;
  else if (a.status && !a.status.ok) banner = `<div class="banner"><p>${h(a.status.text)}</p></div>`;
  const xp = c.level < 60 && c.xpMax
    ? `<div class="xp" role="progressbar" aria-label="Experience" aria-valuemin="0" aria-valuemax="${c.xpMax}" aria-valuenow="${c.xp ?? 0}">
        <div class="xp-fill" style="width:${Math.min(1, (c.xp ?? 0) / c.xpMax) * 100}%"></div><span>${num(c.xp)} / ${num(c.xpMax)} XP to level ${c.level + 1}</span></div>`
    : "";
  return `${banner}
    <section class="hero" style="--cls:${color}">
      <div class="portrait">${img(raceIcon(c) || c.class, "face")}${img(c.class, "badge")}</div>
      <div>
        <h1>${h(charName(c))}</h1>
        <p class="hero-line">Level ${num(c.level)} ${h(c.race)} <span class="cls">${h(cls)}</span>${c.role ? `<span class="role">${img(c.role)}${h(c.role)}</span>` : ""}${c.hc ? `<span class="hc">Hardcore</span>` : ""}</p>
        ${c.guild ? `<p class="guild">&lt;${h(c.guild)}&gt;</p>` : ""}
        ${c.died ? `<p class="died">Fell at level ${num(c.died.l)}${c.died.z ? ` in ${h(c.died.z)}` : ""}, ${rel(c.died.t * 1000)}.</p>` : ""}
      </div>
      <p class="hero-sync ${sync && !sync.ok ? "warn" : ""}">${syncLine(sync)}<br><span class="faint">Saved in game ${rel(c.t * 1000)}</span></p>
    </section>
    ${xp}
    <div class="columns">
      <div class="col">${gear(c)}${questLog(c)}</div>
      <div class="col">${stats(c)}${professions(c)}${reputation(c)}${lockouts(c)}</div>
    </div>`;
}

function syncLine(sync) {
  if (!sync) return "Not synced from this computer yet";
  if (sync.ok) return `Synced to Discord ${rel(sync.at)}`;
  return `Didn't sync: ${h(sync.message)}`;
}

function gear(c) {
  const bySlot = new Map((c.gear ?? []).map((g) => [g.s, g]));
  const slot = (s) => {
    const g = bySlot.get(s);
    if (!g) return `<div class="item empty"><span class="item-icon"></span><span class="item-name">Empty</span><span class="item-slot">${SLOTS[s]}</span></div>`;
    const icon = S.icons?.[g.id];
    return `<a class="item" href="${WOWHEAD}/item=${Number(g.id)}" style="--q:${QUALITY[g.q ?? 1] ?? QUALITY[1]}">
      ${icon ? `<img class="item-icon" src="${ICON_URL(icon)}" alt="">` : `<span class="item-icon"></span>`}
      <span class="item-name" title="${h(g.n)}">${h(g.n ?? `Item ${g.id}`)}</span><span class="item-slot">${SLOTS[s]}</span>${g.l ? `<span class="item-level" title="Item level">${num(g.l)}</span>` : ""}</a>`;
  };
  const col = (slots) => `<div>${slots.map(slot).join("")}</div>`;
  return panel("Equipment", `<div class="doll">${col(DOLL.left)}${col(DOLL.right)}</div><div class="weapons">${DOLL.weapons.map(slot).join("")}</div>`,
    c.ilvl ? `Item level ${num(c.ilvl)}` : "");
}

function stats(c) {
  const rows = [
    c.money != null && ["Gold", money(c.money)],
    c.played != null && ["Time played", played(c.played)],
    c.quests != null && ["Quests completed", num(c.quests)],
    c.ilvl != null && ["Item level", num(c.ilvl)],
  ].filter(Boolean);
  return rows.length ? panel("Character", `<dl class="stats">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`) : "";
}

function professions(c) {
  if (!c.profs?.length) return "";
  return panel("Professions", `<ul class="bars">${c.profs.map((p) => bar(`${img(p.n)}${h(p.n)}`, `${num(p.r)} / ${num(p.m)}`, p.m && p.r / p.m, "var(--skill)")).join("")}</ul>`);
}

function reputation(c) {
  if (!c.reps?.length) return "";
  return panel("Reputation", `<ul class="bars">${c.reps.map((r) => {
    const [standing, color] = STANDING[r.r] ?? ["", "#8a8fa8"];
    return bar(`${h(r.n)}<span class="standing" style="color:${color}">${standing}</span>`, r.m ? `${num(r.p)} / ${num(r.m)}` : "", r.m ? r.p / r.m : 1, color);
  }).join("")}</ul>`);
}

function lockouts(c) {
  const list = (c.lockouts ?? []).filter((l) => l.reset * 1000 > Date.now());
  if (!list.length) return "";
  return panel("Saved instances", `<ul class="locks">${list.map((l) => `<li>${img(l.raid ? "raid" : "dungeon")}
    <span class="lock-name">${h(l.n)}</span><span class="lock-progress">${num(l.k)} of ${num(l.of)} bosses${l.b?.length ? `: ${l.b.map(h).join(", ")}` : ""}</span><span class="lock-reset">Resets ${rel(l.reset * 1000)}</span></li>`).join("")}</ul>`);
}

function questLog(c) {
  if (!c.log) return "";
  if (!c.log.length) return panel("Quest log", `<p class="muted">No quests right now.</p>`);
  const zones = Map.groupBy(c.log, (q) => q.z || "Other");
  const mates = (id) => (S.guild?.chars ?? []).filter((m) => m.name !== charName(c) && m.quests.includes(id)).map((m) => m.name);
  const quest = (q) => `<li class="quest">
    <a href="${WOWHEAD}/quest=${Number(q.id)}" style="color:${difficulty(q.l || c.level, c.level)}">${q.l ? `[${num(q.l)}] ` : ""}${h(q.n)}</a>${q.c ? `<span class="complete">Complete</span>` : ""}
    ${q.o?.length ? `<ul class="objectives">${q.o.map((o) => `<li class="${o.d ? "met" : ""}">${o.d ? check : ""}${h(o.t)}</li>`).join("")}</ul>` : ""}
    ${mates(q.id).length ? `<p class="mates">Also on this quest: ${mates(q.id).map(h).join(", ")}</p>` : ""}</li>`;
  return panel("Quest log", [...zones].map(([zone, quests]) => `<div class="zone"><h3>${h(zone)}</h3><ul>${quests.map(quest).join("")}</ul></div>`).join(""),
    `${c.log.length} quest${c.log.length === 1 ? "" : "s"}`);
}

// ---------- guild and raids (from the bot) ----------

function noGuild() {
  if (S.guildError) return `<div class="banner"><p>Couldn't load the guild: ${h(S.guildError)}</p><button class="btn" data-act="refreshGuild">Try again</button></div>`;
  return `<section class="setup"><h1>Link your Discord account</h1>
    <p class="lede">The Guild and Raids tabs come from the uwucrew bot. Run /sync link in Discord, then paste the code here.</p>${linkForm()}${errorLine()}</section>`;
}

const fullDate = (sec) => new Date(sec * 1000).toLocaleDateString([], { month: "short", day: "numeric" });
const classColor = (cls) => classOf({ class: cls })[1];

function guildTab() {
  if (!S.guild) return noGuild();
  return `<section class="guild-view">
    <h1>uwucrew</h1>
    <div class="columns">
      <div class="col">${progressPanel(S.guild)}${craftPanel()}</div>
      <div class="col">${racePanel(S.guild)}</div>
    </div>
    ${rosterPanel(S.guild)}
  </section>`;
}

function progressPanel(g) {
  if (!g.progress.length) return panel("Raid progress", `<p class="muted">Raids open ${fullDate(g.raidsOpen / 1000)} (${rel(g.raidsOpen)}). Boss kills show up here as people sync.</p>`);
  return panel("Raid progress", g.progress.map((r) => {
    const down = Math.max(r.kills.length, r.week); // older addons report counts but not boss names
    const of = Math.max(r.of, down);
    return `<div class="raid-progress">
      <ul class="bars">${bar(h(r.raid), `${down} / ${of || "?"} bosses`, of ? down / of : 0, "var(--gold)")}</ul>
      <ul class="kills">${r.kills.map((k) => `<li><span>${h(k.boss)}</span><span class="faint">${fullDate(k.at)}, ${h(k.char_name)}</span></li>`).join("")}</ul>
      <p class="faint">Best this week: ${r.week} / ${of || "?"}</p></div>`;
  }).join(""));
}

function racePanel(g) {
  const top = g.chars.filter((c) => !c.diedAt).slice(0, 10);
  if (!top.length) return panel("Race to 60", `<p class="muted">Nobody has synced a character yet.</p>`);
  return panel("Race to 60", `<ol class="race">${top.map((c) => `<li style="--cls:${classColor(c.class)}">
    ${img(c.class)}<span class="race-name">${h(c.name)}</span><span class="race-level">${c.level}</span>
    <div class="bar"><div style="width:${(c.level / 60) * 100}%"></div></div></li>`).join("")}</ol>`);
}

function craftResults() {
  const recipes = S.guild?.recipes ?? {};
  const q = craftQuery.trim().toLowerCase();
  if (!q) return `<p class="faint">${Object.keys(recipes).length} recipes known across the guild. Recipes sync when someone opens their profession window in game.</p>`;
  const hits = Object.keys(recipes).filter((r) => r.toLowerCase().includes(q)).sort().slice(0, 12);
  if (!hits.length) return `<p class="muted">Nobody has synced a recipe matching "${h(craftQuery)}".</p>`;
  return `<ul class="crafts">${hits.map((r) => `<li><span class="craft-name">${h(r)}</span><span class="faint">${recipes[r].map(h).join(", ")}</span></li>`).join("")}</ul>`;
}

const craftPanel = () => panel("Who can craft it?",
  `<input type="text" class="craft-search" value="${h(craftQuery)}" placeholder="Search recipes, e.g. Runecloth Bag" aria-label="Search recipes" spellcheck="false">
   <div class="craft-results">${craftResults()}</div>`);

function rosterPanel(g) {
  const rows = g.chars.map((c) => `<tr class="${c.diedAt ? "dead" : ""}" style="--cls:${classColor(c.class)}">
    <td><div class="who">${img(c.class)}<span><span class="roster-name">${h(c.name)}${c.diedAt ? " 💀" : ""}</span>${c.main ? "" : `<span class="faint">${h(c.owner)}'s alt</span>`}</span></div></td>
    <td class="num">${c.level}</td>
    <td>${c.role ? `${img(c.role)}${h(c.role)}` : ""}</td>
    <td class="num">${c.ilvl ?? ""}</td>
    <td class="profs">${c.profs.map((p) => `<span title="${h(p.n)} ${p.r}">${img(p.n)}${p.r}</span>`).join("")}</td>
    <td class="faint">${c.syncedAt ? rel(c.syncedAt * 1000) : "never synced"}</td></tr>`).join("");
  return panel("Roster", `<table class="roster-table"><thead><tr><th>Character</th><th>Level</th><th>Role</th><th>Item level</th><th>Professions</th><th>Last synced</th></tr></thead><tbody>${rows}</tbody></table>`,
    `${g.chars.length} characters`);
}

const SIGNUP_LABELS = { in: "You're in", bench: "On the bench", tentative: "Tentative", absent: "Absent" };

function raidsTab() {
  if (!S.guild) return noGuild();
  const events = S.guild.events;
  return `<section class="raids">
    <h1>Raids</h1>
    ${errorLine()}
    ${events.length ? events.map(raidCard).join("") : `<p class="muted">No raids scheduled. Officers post them with /event create in Discord, and they show up here.</p>`}
  </section>`;
}

function raidCard(ev) {
  const mine = ev.mine;
  const chosen = (action) => !!mine && ((mine.role === action && ["in", "bench"].includes(mine.status)) || mine.status === action);
  const button = (action, label) => `<button class="btn signup-btn ${chosen(action) ? "chosen" : ""}" aria-pressed="${chosen(action)}"
    data-act="signup" data-event="${ev.id}" data-arg="${action}">${img(action)}${label}</button>`;
  let status = "Not signed up";
  if (mine) status = `${SIGNUP_LABELS[mine.status] ?? mine.status}${mine.role ? ` as ${h(mine.role)}` : ""}`;
  const when = new Date(ev.startsAt * 1000).toLocaleString([], { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `<article class="panel raid">
    <header><div><h2>${h(ev.title)}</h2><p class="muted">${when} (${rel(ev.startsAt * 1000)})</p></div>
      <p class="raid-count"><strong>${ev.going}</strong>${ev.size ? ` / ${ev.size}` : ""} going</p></header>
    ${ev.description ? `<p class="raid-desc">${h(ev.description)}</p>` : ""}
    <p class="raid-roles">${["Tank", "Healer", "DPS"].map((r) => `<span>${img(r)}${ev.roles[r] ?? 0} ${r}</span>`).join("")}${ev.bench ? `<span>${img("bench")}${ev.bench} on the bench</span>` : ""}</p>
    ${ev.names.length ? `<p class="faint raid-names">${ev.names.map(h).join(", ")}</p>` : ""}
    <footer><span class="my-status ${mine ? "" : "warn"}">${status}</span>
      <span class="signup-buttons">${button("Tank", "Tank")}${button("Healer", "Healer")}${button("DPS", "DPS")}${button("tentative", "Tentative")}${button("absent", "Absent")}</span></footer>
  </article>`;
}

// ---------- setup and settings ----------

function wowStepText() {
  if (S.wowFound) return `Found it in ${h(S.wowDir)}.`;
  if (S.wowDir) return `There's no game folder in ${h(S.wowDir)}. Choose the folder that contains _forever_.`;
  return "Choose the folder World of Warcraft is installed in.";
}

function addonStepText() {
  const ad = S.addon;
  if (ad.installed) return `Version ${h(ad.installed)} is installed${S.autoUpdate ? " and kept up to date" : ""}.`;
  if (ad.busy) return "Installing…";
  if (ad.error) return h(ad.error);
  return "The app puts it in your AddOns folder and keeps it updated.";
}

function linkStepText(linked) {
  if (!linked) return "In Discord, run /sync link, then paste the code here.";
  if (S.linkServer) return `Linked to ${h(host(S.linkServer))}.`;
  return "Linked in game.";
}

function setup() {
  const ad = S.addon;
  const linked = !!S.linkServer || S.accounts.some((a) => a.linkedBy);
  const steps = [
    {
      done: S.wowFound, title: "Find World of Warcraft",
      body: wowStepText(),
      action: `<button class="btn ${S.wowFound ? "" : "primary"}" data-act="pickWowDir">${S.wowFound ? "Change folder" : "Choose folder"}</button>`,
    },
    {
      done: !!ad.installed, title: "Install the uwucrew Sync addon",
      body: addonStepText(),
      action: ad.installed ? "" : `<button class="btn primary" data-act="installAddon" ${!S.wowFound || ad.busy ? "disabled" : ""}>Install addon</button>`,
    },
    {
      done: linked, title: "Link your Discord account",
      body: linkStepText(linked),
      action: linked ? "" : linkForm(),
    },
    { done: S.accounts.length > 0, title: "Play", body: "Log in to WoW, then log out or type /reload. Your characters show up here and sync to Discord.", action: "" },
  ];
  const next = steps.findIndex((s) => !s.done);
  return `<section class="setup">
    <h1>Set up syncing</h1>
    <p class="lede">uwucrew Sync sends your characters to the guild Discord every time WoW saves them, and keeps the addon up to date.</p>
    <ol class="steps">${steps.map((s, i) => `<li class="step ${s.done ? "done" : ""} ${i === next ? "next" : ""}">
      <span class="step-mark">${s.done ? check : i + 1}</span><div><h2>${s.title}</h2><p>${s.body}</p>${s.action}</div></li>`).join("")}</ol>
    ${errorLine()}
  </section>`;
}

function addonDetail() {
  const ad = S.addon;
  if (ad.busy) return "Checking for updates…";
  if (ad.error) return h(ad.error);
  if (!ad.installed) return S.wowFound ? "The app can install it for you." : "Choose your WoW folder first.";
  if (ad.outdated) return `Version ${h(ad.latest)} is available.`;
  if (ad.checkedAt) return `Up to date. Checked ${rel(ad.checkedAt)}.`;
  return "";
}

function addonButton() {
  const ad = S.addon;
  if (!ad.installed) return `<button class="btn primary" data-act="installAddon" ${S.wowFound && !ad.busy ? "" : "disabled"}>Install addon</button>`;
  if (ad.outdated) return `<button class="btn primary" data-act="installAddon" ${ad.busy ? "disabled" : ""}>Update addon</button>`;
  return `<button class="btn" data-act="checkAddon" ${ad.busy ? "disabled" : ""}>Check for updates</button>`;
}

function settings() {
  const ad = S.addon;
  const addonTitle = ad.installed ? `Version ${h(ad.installed)} installed` : "Not installed";
  const accounts = S.accounts.map((a) => `<li><span>${h(a.name)}</span><span class="${a.linkedBy ? "" : "warn"}">${LINKED_DETAIL[a.linkedBy] ?? "Not linked"}</span></li>`).join("");
  const activity = S.activity.map((e) => `<li class="${e.ok ? "" : "bad"}"><time>${clock(e.at)}</time><span>${h(e.text)}</span></li>`).join("");
  const group = (title, body) => `<section class="group"><h2>${title}</h2>${body}</section>`;
  return `<section class="settings">
    <h1>Settings</h1>
    ${errorLine()}
    ${group("World of Warcraft", `
      <div class="row"><div><p class="row-title">Game folder</p><p class="muted path">${h(S.wowDir ?? "Not chosen yet")}</p></div><button class="btn" data-act="pickWowDir">Change folder</button></div>
      ${S.games.length > 1 ? `<div class="row"><label class="row-title" for="game">Install the addon for</label>
        <select id="game" data-act="setGame">${S.games.map((g) => `<option value="${h(g)}" ${g === S.game ? "selected" : ""}>${h(gameName(g))}</option>`).join("")}</select></div>` : ""}`)}
    ${group("Addon", `
      <div class="row"><div><p class="row-title">${addonTitle}</p><p class="muted">${addonDetail()}</p></div>
        <div class="row-actions">${S.wowFound ? `<button class="btn" data-act="openAddonFolder">Open folder</button>` : ""}${addonButton()}</div></div>
      ${toggle("setAutoUpdate", S.autoUpdate, "Keep the addon installed and up to date", "Checks for a new version every few hours. Type /reload in game after an update.")}`)}
    ${group("Discord link", `
      <p class="muted">Run /sync link in Discord and paste the code here. It's used for every WoW account that isn't linked in game.</p>
      <div class="row"><p class="row-title">${S.linkServer ? `Linked to ${h(host(S.linkServer))}` : "No link saved"}</p>${S.linkServer ? `<button class="btn" data-act="setLink" data-arg="">Remove link</button>` : ""}</div>
      ${linkForm()}
      ${accounts ? `<ul class="accounts">${accounts}</ul>` : ""}`)}
    ${S.canOpenAtLogin ? group("Startup", toggle("setOpenAtLogin", S.openAtLogin, "Open when my computer starts", "It starts in the tray, so every play session gets synced.")) : ""}
    ${group("Activity", activity ? `<ul class="activity">${activity}</ul>` : `<p class="muted">Nothing yet.</p>`)}
    <p class="version">uwucrew Sync ${h(S.version)}${S.updateReady ? `. Version ${h(S.updateReady)} installs when you restart the app.` : ""}</p>
  </section>`;
}

// ---------- render and events ----------

function render() {
  if (!S) return;
  if (holding || document.activeElement?.matches("input[type=text]")) return void (deferred = true);
  deferred = false;
  const byLevel = (x, y) => y.level - x.level || charName(x).localeCompare(charName(y));
  const all = S.accounts.flatMap((a) => [...a.chars].sort(byLevel).map((c) => ({ a, c, key: `${a.file}::${charName(c)}`, sync: a.synced[charName(c)] })));
  const current = all.find((x) => x.key === selected) ?? all[0];
  const viewKey = `${tab}:${current?.key}`;
  const scroll = viewKey === lastView ? (document.querySelector(".sheet")?.scrollTop ?? 0) : 0;
  lastView = viewKey;
  let body = setup();
  if (tab === "settings") body = settings();
  else if (tab === "guild") body = guildTab();
  else if (tab === "raids") body = raidsTab();
  else if (current) body = sheet(current);
  $app.innerHTML = `${topbar()}<div class="shell">${roster(all, current)}<main class="sheet">${body}</main></div>`;
  document.querySelector(".sheet").scrollTop = scroll;
}

async function act(name, arg) {
  error = (await window.uwu.act(name, arg)) ?? "";
  render();
  return !error;
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("a[href], [data-act], [data-char], [data-tab]");
  if (!t || t.matches("input, select")) return; // inputs act on change
  e.preventDefault();
  if (t.matches("a[href]")) return void window.uwu.act("openExternal", t.href);
  if (t.dataset.tab) return (tab = t.dataset.tab), (error = ""), render();
  if (t.dataset.char) return localStorage.setItem("char", (selected = t.dataset.char)), (tab = "chars"), render();
  act(t.dataset.act, t.dataset.event ? { event: Number(t.dataset.event), action: t.dataset.arg } : t.dataset.arg);
});
document.addEventListener("change", (e) => e.target.dataset?.act && act(e.target.dataset.act, e.target.type === "checkbox" ? e.target.checked : e.target.value));
document.addEventListener("input", (e) => {
  if (e.target.closest(".link-form")) draft = e.target.value;
  if (e.target.matches(".craft-search")) {
    craftQuery = e.target.value;
    document.querySelector(".craft-results").innerHTML = craftResults(); // live results without a full re-render (and lost focus)
  }
});
document.addEventListener("submit", async (e) => {
  e.preventDefault();
  document.activeElement?.blur();
  if (await act("setLink", draft)) (draft = ""), render();
});
// Hold re-renders while a click or typing is in progress, so the element under the pointer isn't swapped out.
addEventListener("pointerdown", () => (holding = true), true);
const release = () => ((holding = false), deferred && setTimeout(render));
addEventListener("pointerup", release, true);
addEventListener("pointercancel", release, true);
addEventListener("blur", release); // the window losing focus; element blurs don't bubble here
addEventListener("focusout", () => deferred && setTimeout(render));
// Icons the game reports that we have no picture for (a new profession, say) just disappear.
addEventListener("error", (e) => e.target instanceof HTMLImageElement && (e.target.hidden = true), true);

window.uwu.onState((s) => ((S = s), render()));
window.uwu.state().then((s) => ((S = s), render()));
setInterval(render, 30_000); // keeps "5 minutes ago" honest
