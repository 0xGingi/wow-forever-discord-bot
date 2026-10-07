// Reads sync codes out of the addon's SavedVariables file (UwucrewSync.lua). No dependencies: the companion app bundles this.
// WoW writes strings %q-style, so inside the file each code looks like "UWU1:{\"level\":30,...}".

export const PREFIX = "UWU1:";

/** The Discord link code saved by `/uwu link`, if this WoW account is linked. */
export const extractLink = (savedVariables: string) => savedVariables.match(/\["link"\] = "(uwusync-[\w-]+)"/)?.[1] ?? null;

export function extractExports(savedVariables: string): string[] {
  const codes: string[] = [];
  for (const m of savedVariables.matchAll(/"(UWU1:(?:[^"\\]|\\.)*)"/g)) codes.push(m[1]!.replace(/\\(.)/g, "$1"));
  return codes;
}
