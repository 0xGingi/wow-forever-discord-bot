// Reads sync codes out of the addon's SavedVariables file (UwucrewSync.lua). No dependencies: the desktop app bundles this.
// WoW writes strings %q-style, so inside the file each code looks like "UWU1:{\"level\":30,...}".

export const PREFIX = "UWU1:";

/** One character as the uwucrew Sync addon reports it. Short keys keep the paste code small. */
export type Snapshot = {
  v: 1; t: number; first: string; last: string; level: number; xp?: number; xpMax?: number;
  class: string; race?: string; raceFile?: string; role?: string; guild?: string;
  money?: number; played?: number; ilvl?: number; quests?: number;
  gear: { s: number; id: number; n?: string; q?: number; l?: number }[];
  profs: { n: string; r: number; m: number }[];
  lockouts: { n: string; raid: boolean; k: number; of: number; reset: number }[];
  reps: { n: string; r: number; p: number; m: number }[];
  /** Current quest log (addon 1.1+). Objectives may be empty in paste codes, which trim them to fit. */
  log?: { id: number; n: string; l?: number; z?: string; c: boolean; o: { t: string; d: boolean }[] }[];
  /** Quests left out of a paste code to make it fit. */
  logMore?: number;
};

/** The Discord link code saved by `/uwu link`, if this WoW account is linked. */
export const extractLink = (savedVariables: string) => savedVariables.match(/\["link"\] = "(uwusync-[\w-]+)"/)?.[1] ?? null;

export function extractExports(savedVariables: string): string[] {
  const codes: string[] = [];
  for (const m of savedVariables.matchAll(/"(UWU1:(?:[^"\\]|\\.)*)"/g)) codes.push(m[1]!.replace(/\\(.)/g, "$1"));
  return codes;
}
