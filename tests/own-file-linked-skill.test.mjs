import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isOwnFile } from "../src/core/policy/own-file.ts";

test("a linked skill owns its references without claiming the rest of the checkout (#1345)", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cm-skill-ref-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, "profile");
  const skills = join(config, "skills");
  const external = join(root, "external");
  const references = join(external, "references");
  const other = join(root, "other");
  for (const dir of [skills, references, other]) mkdirSync(dir, { recursive: true });
  for (const file of [join(references, "manual.md"), join(references, "log.jsonl"), join(other, "other.md")]) {
    writeFileSync(file, "fixture");
  }
  const skill = join(skills, "linked");
  symlinkSync(external, skill, "junction");
  symlinkSync(other, join(external, "unrelated"), "junction");
  const env = { HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: config };
  const own = (file) => isOwnFile("claude-code", file, env);
  assert.equal(own(join(skill, "references", "manual.md")), true);
  assert.equal(own(join(skill, "references", "log.jsonl")), false);
  assert.equal(own(join(skill, "unrelated", "other.md")), false);
  assert.equal(own(join(references, "manual.md")), false);
});
