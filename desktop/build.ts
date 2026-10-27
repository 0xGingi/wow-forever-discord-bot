// Bundles the main process (with the shared addon parser from ../src) and gathers the UI into dist/, which is all the app ships.
import { cpSync, rmSync } from "node:fs";

process.chdir(import.meta.dir);
rmSync("dist", { recursive: true, force: true });
const out = await Bun.build({ entrypoints: ["main.ts"], outdir: "dist", target: "node", format: "esm", external: ["electron"] });
if (!out.success) throw new AggregateError(out.logs, "build failed");
cpSync("ui", "dist", { recursive: true });
cpSync("preload.cjs", "dist/preload.cjs");
cpSync("build/icon.png", "dist/icon.png");
cpSync("../assets/emoji", "dist/emoji", { recursive: true });
