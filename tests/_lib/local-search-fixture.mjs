// Executable sidecar fixture used by the ADR-0016 source-level regression tests.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export function searchFixture(dir) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "search.mjs");
  if (!existsSync(file)) {
    writeFileSync(file, `import ${JSON.stringify(new URL("../../src/entries/run.ts", import.meta.url).href)};\n`);
  }
  return dir;
}
