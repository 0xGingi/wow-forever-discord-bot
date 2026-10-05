// WoW Forever reference data. Beta info is still shifting: edit freely, nothing else hardcodes these lists.

export const LAUNCH = Date.parse("2026-11-04T23:00:00Z"); // 3pm PST
export const BETA_END = Date.parse("2026-10-21T23:00:00Z");
export const RAIDS_OPEN = Date.parse("2026-12-09T23:00:00Z");

export const CLASSES = {
  Warrior: 0xc69b6d,
  Paladin: 0xf48cba,
  Hunter: 0xaad372,
  Rogue: 0xfff468,
  Priest: 0xffffff,
  Shaman: 0x0070dd,
  Mage: 0x3fc7eb,
  Warlock: 0x8788ee,
  Druid: 0xff7c0a,
} as const;
export type ClassName = keyof typeof CLASSES;

export const RACES = ["Human", "Dwarf", "Night Elf", "Gnome", "Orc", "Undead", "Tauren", "Troll", "Skyborne"];
export const ROLES = ["Tank", "Healer", "DPS"] as const;
export type Role = (typeof ROLES)[number];

export const PROFESSIONS = [
  "Alchemy", "Blacksmithing", "Enchanting", "Engineering", "Herbalism", "Leatherworking",
  "Mining", "Skinning", "Tailoring", "Cooking", "First Aid", "Fishing",
];

export type Instance = {
  name: string;
  kind: "dungeon" | "raid";
  size: number;
  levels: string; // new dungeons: Blizzard's range; classic dungeons: Forever group finder's recommended level
  zone?: string;
  isNew?: boolean; // added in Forever
  opens?: string;
};

const d = (name: string, levels: string, zone: string, extra: Partial<Instance> = {}): Instance => ({ name, kind: "dungeon", size: 5, levels, zone, ...extra });
const r = (name: string, size: number, zone: string | undefined, extra: Partial<Instance> = {}): Instance => ({ name, kind: "raid", size, levels: "60", zone, ...extra });

// Sources (Oct 2026, beta): Blizzard's Forever dungeon announcements, plus the in-game group finder levels as listed by
// zockify.com/forever/dungeons and wowforevertalents.com/dungeons, which agree. Forever retuned classic dungeons,
// so classic wiki ranges are wrong here (e.g. Uldaman opens at 30).
export const INSTANCES: Instance[] = [
  d("Ragefire Chasm", "13+", "Orgrimmar"),
  d("Hall of Thanes", "13-18", "Ironforge", { isNew: true }),
  d("Ruins of Lordaeron", "15-20", "Tirisfal Glades", { isNew: true }),
  d("The Deadmines", "16+", "Westfall"),
  d("Wailing Caverns", "17+", "The Barrens"),
  d("Shadowfang Keep", "18+", "Silverpine Forest"),
  d("Blackfathom Deeps", "22+", "Ashenvale"),
  d("The Stockade", "23+", "Stormwind City"),
  d("Razorfen Kraul", "24+", "The Barrens"),
  d("Gnomeregan", "25+", "Dun Morogh"),
  d("Excavation Site: Wetlands", "26-31", "Wetlands", { isNew: true }),
  d("City of Dalaran", "28-33", "Alterac Mountains", { isNew: true }),
  ...["Graveyard", "Library", "Armory", "Cathedral"].map((w) => d(`Scarlet Monastery: ${w}`, "30+", "Tirisfal Glades")),
  d("Razorfen Downs", "34+", "The Barrens"),
  d("Uldaman", "35+", "Badlands"),
  d("The Drowned City", "35-40", "Stranglethorn Vale", { isNew: true }),
  d("Krol'dok Stronghold", "40-45", "Riverglades", { isNew: true }),
  d("Zul'Farrak", "42+", "Tanaris"),
  d("Maraudon", "42+", "Desolace"),
  d("Sunken Temple", "45+", "Swamp of Sorrows"),
  d("Alcaz Prison", "48-53", "Dustwallow Marsh", { isNew: true }),
  d("Blackrock Depths", "48+", "Blackrock Mountain"),
  d("Lower Blackrock Spire", "53+", "Blackrock Mountain"),
  d("Upper Blackrock Spire", "53+", "Blackrock Mountain", { size: 10 }),
  ...["East", "West", "North"].map((w) => d(`Dire Maul: ${w}`, "54+", "Feralas")),
  d("Blackmaw Hold", "55-60", "Azshara", { isNew: true }),
  d("Stratholme: Live", "55+", "Eastern Plaguelands"),
  d("Stratholme: Undead", "55+", "Eastern Plaguelands"),
  d("Scholomance", "57+", "Western Plaguelands"),
  d("Shaper's Terrace", "58-60", "Un'Goro Crater", { isNew: true }),

  // Barrow Deeps, Hyjal Summit and Onyxia unlock Dec 9. The group finder lists the classic raids, but Blizzard only says "more in 2027".
  r("Barrow Deeps", 10, undefined, { isNew: true, opens: "Dec 9" }),
  r("Hyjal Summit", 20, "Mount Hyjal", { isNew: true, opens: "Dec 9" }),
  r("Onyxia's Lair", 40, "Dustwallow Marsh", { opens: "Dec 9" }),
  r("Zul'Gurub", 20, "Stranglethorn Vale", { opens: "later" }),
  r("Molten Core", 40, "Blackrock Mountain", { opens: "later" }),
  r("Blackwing Lair", 40, "Blackrock Mountain", { opens: "later" }),
  r("Ruins of Ahn'Qiraj", 20, "Silithus", { opens: "later" }),
  r("Temple of Ahn'Qiraj", 40, "Silithus", { opens: "later" }),
  r("Naxxramas", 40, "Eastern Plaguelands", { opens: "later" }),
];
export const DUNGEONS = INSTANCES.filter((x) => x.kind === "dungeon");
export const RAIDS = INSTANCES.filter((x) => x.kind === "raid");
export const findInstance = (name: string) => INSTANCES.find((x) => x.name.toLowerCase() === name.toLowerCase());

/** Autocomplete label, e.g. "Hyjal Summit · 20-player raid · Mount Hyjal · New · opens Dec 9". */
export const instanceLabel = (x: Instance) =>
  [x.name, x.kind === "raid" ? `${x.size}-player raid` : `Lv ${x.levels}`, x.zone, x.isNew && "New", x.opens && `opens ${x.opens}`].filter(Boolean).join(" · ");
