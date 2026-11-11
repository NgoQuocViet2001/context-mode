// OpenCode loads both config spellings and drop-in plugins. Discovery does not execute user code.
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseHostConfig } from "./host-config.ts";
import { OPENCODE_CONFIG_FILES, SERVER_KEY } from "../contracts/constants.ts";

function record(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v); }
function native(v: unknown, key: string): boolean {
  const spec = Array.isArray(v) ? v[0] : record(v) ? v.package : v;
  return typeof spec === "string" && ((spec.startsWith(SERVER_KEY + "@") && spec.length > SERVER_KEY.length + 1) || (key === "plugins" && spec === SERVER_KEY));
}
/** Config registration or a recognisable drop-in re-export. This is not proof of a live host load. */
export function opencodeNativeRegistration(dirs: readonly string[], ownPaths: readonly string[] = []): string | undefined {
  let found: string | undefined;
  let ownPathFound = false;
  for (const dir of new Set(dirs)) {
    for (const name of OPENCODE_CONFIG_FILES) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      const doc = parseHostConfig("opencode", file, readFileSync(file, "utf8"), "jsonc");
      if (record(doc)) {
        for (const key of ["plugin", "plugins"]) {
          const entries = Array.isArray(doc[key]) ? doc[key] as unknown[] : [];
          if (entries.some((e) => native(e, key))) found = file;
          if (entries.some((e) => typeof e === "string" && ownPaths.includes(e))) ownPathFound = true;
        }
      }
    }
    const plugins = join(dir, "plugins");
    if (!existsSync(plugins)) continue;
    const priority = (name: string) => name === SERVER_KEY || name.startsWith(SERVER_KEY + ".") || name.startsWith(SERVER_KEY + "-") ? 0 : 1;
    const names = readdirSync(plugins).sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
    for (const name of names.slice(0, 128)) {
      const path = join(plugins, name);
      let file: string;
      try {
        const st = lstatSync(path);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory() && name !== SERVER_KEY) continue;
        file = st.isDirectory() ? join(path, "index.js") : path;
      } catch { continue; }
      if (!file.endsWith(".js") && !file.endsWith(".ts") && !file.endsWith(".mjs")) continue;
      if (!existsSync(file)) continue;
      let text: string;
      try {
        const st = lstatSync(file);
        if (!st.isFile() || st.isSymbolicLink() || st.size > 16 * 1024) continue;
        text = readFileSync(file, "utf8");
      } catch { continue; }
      // Only exact module specifiers in a re-export count. A comment merely mentioning the package cannot pass.
      const statements = text.split(";").map((s) => s.trim());
      if (statements.some((s) => {
        const prefix = ["export { default } from ", "export {default} from "].find((p) => s.startsWith(p));
        if (prefix === undefined) return false;
        const quoted = s.slice(prefix.length).trim();
        if (quoted.length < 2 || !["\"", "'"].includes(quoted[0]) || quoted.at(-1) !== quoted[0]) return false;
        const spec = quoted.slice(1, -1);
        if (["context-mode", "context-mode/server"].includes(spec)) return true;
        if (!spec.startsWith(".") && !isAbsolute(spec)) return false;
        const target = resolve(dirname(file), spec).replaceAll("\\", "/");
        return target.endsWith("/context-mode/opencode/plugin.js") && existsSync(target);
      })) found = file;
    }
  }
  if (found !== undefined && ownPathFound) throw new Error("context-mode loads twice (native registration and local package entry); remove the duplicate local entry");
  return found;
}
