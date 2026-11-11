/** Gemini's `extensions list` identifies extensions on their own header lines. A source
 * path or diagnostic containing our package name does not establish installation. */
function withoutColor(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\x1b" && text[i + 1] === "[") {
      let end = i + 2;
      while (end < text.length && ((text[end] >= "0" && text[end] <= "9") || text[end] === ";")) end++;
      if (text[end] === "m") { i = end; continue; }
    }
    out += text[i];
  }
  return out;
}

export function geminiListsExtension(text: string, name: string): boolean {
  for (const line of text.split("\n")) {
    const plain = withoutColor(line);
    if (plain.trimStart() !== plain) continue; // indented names belong to another extension's metadata/MCP servers
    let header = plain.trim();
    if (header.length > 0 && "✓✔✗✘".includes(header[0])) header = header.slice(1).trimStart();
    if (header === name) return true; // older hosts/test doubles print the bare name
    if (!header.startsWith(name) || ![" ", "\t"].includes(header[name.length])) continue;
    const suffix = header.slice(name.length).trim();
    if (!suffix.startsWith("(") || !suffix.endsWith(")")) continue;
    const version = suffix.slice(1, -1);
    if (version.trim() !== "" && !version.includes("(") && !version.includes(")")) return true;
  }
  return false;
}
