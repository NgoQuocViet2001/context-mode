import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, setupLegacy } from '../../src/entries/opencode.ts';
import { getAdapter, hasReplace } from '../../src/adapters/table.ts';
import { opencodeNativeRegistration } from '../../src/core/ops/opencode-install.ts';
import { checkHostConfig } from '../../src/core/ops/doctor-config.ts';
import { runDoctor, runSetup } from '../../src/setup/index.ts';
import { DatabaseSync } from 'node:sqlite';
const fixture = async (f) => {
    const root = mkdtempSync(join(tmpdir(), 'cm-opencode-regression-')), home = join(root, 'home'), cwd = join(root, 'project');
    mkdirSync(home);
    mkdirSync(cwd);
    const previous = { ...process.env };
    for (const k of ['CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR'])
        delete process.env[k];
    Object.assign(process.env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), CONTEXT_MODE_DATA_DIR: join(root, 'data') });
    try {
        await f({ root, home, cwd });
    }
    finally {
        for (const k of Object.keys(process.env))
            if (!(k in previous))
                delete process.env[k];
        Object.assign(process.env, previous);
        try {
            rmSync(root, { recursive: true, force: true });
        }
        catch {
        }
    }
};
async function host(cwd) {
    const hooks = {}, sessions = {}, tools = {};
    const stop = await setup({ location: { directory: cwd }, permission: { assert: async () => {
            } }, tool: { hook: async (n, f) => hooks[n] = f, transform: async (f) => f({ add: t => tools[t.name] = t }) }, session: { hook: async (n, f) => sessions[n] = f }, event: { subscribe: async function* () {
            } } });
    return { hooks, sessions, tools, stop };
}
const big = Array.from({ length: 6000 }, (_, i) => `ROW_${i} exact=${i * 17}`).join('\n');
const event = (id, extra = {}) => ({ tool: 'bash', sessionID: 's', agent: 'build', id, input: { command: 'synthetic fixture' }, status: 'completed', result: { content: [{ type: 'text', text: big }], metadata: { custom: 'preserved' } }, ...extra });

export function registerOpenCodeRegressions() {
test('#1347 replaces OpenCode2 text, preserves metadata, indexes tail and exact journal bytes', () => fixture(async ({ cwd, root }) => {
    const h = await host(cwd), ev = event('replace');
    await h.hooks['execute.after'](ev);
    const text = ev.result.content[0].text;
    assert(Buffer.byteLength(text) < 4096);
    assert.equal(ev.result.metadata.custom, 'preserved');
    const hit = await h.tools.ctx_search.execute({ queries: ['ROW_5999'] }, { sessionID: 's' });
    assert(hit.content.includes('exact=101983'), hit.content);
    const { readdirSync } = await import('node:fs');
    const project = join(root, 'data/projects', readdirSync(join(root, 'data/projects'))[0], 'context.db');
    const db = new DatabaseSync(project, { readOnly: true });
    const row = db.prepare("select * from events where tool='Bash' order by seq desc limit 1").get();
    assert.equal(row.bytes, Buffer.byteLength(big));
    assert.equal(row.returned_bytes, Buffer.byteLength(text));
    db.close();
    h.stop();
}));
test('#1347 preserves ranged reads, non-text blocks, errors, and unavailable search output', () => fixture(async ({ cwd }) => {
    const h = await host(cwd);
    for (const ev of [event('range', { tool: 'read', input: { path: 'fake.txt', offset: 1, limit: 99999 } }), event('media', { result: { content: [{ type: 'text', text: big }, { type: 'image', data: 'synthetic' }] } }), event('error', { status: 'error', error: { message: big } })]) {
        const before = JSON.stringify(ev);
        await h.hooks['execute.after'](ev);
        assert.equal(JSON.stringify(ev), before);
    }
    await h.sessions.context({ sessionID: 's', agent: 'build', tools: { bash: {} }, system: [] });
    const ev = event('nosearch');
    await h.hooks['execute.after'](ev);
    assert.equal(ev.result.content[0].text, big);
    h.stop();
}));
test('#1347 legacy OpenCode remains deny-based and does not rewrite output', () => fixture(async ({ cwd }) => {
    const hooks = await setupLegacy({ directory: cwd, tool() {
        } }), out = { output: big };
    await hooks['tool.execute.after']({ tool: 'bash', sessionID: 's', callID: 'legacy', args: {} }, out);
    assert.equal(out.output, big);
    const row = getAdapter('opencode');
    assert.equal(hasReplace(row), false);
    assert.equal(hasReplace(row, { replaceSupported: true }), true);
    assert.equal(row.encode({ event: 'PostToolUse' }, { kind: 'replace', output: 'x' }).stdout, '');
    assert.equal(row.encode({ event: 'PostToolUse', replaceSupported: true }, { kind: 'replace', output: 'x' }).stdout, 'x');
}));
test('#1348 visible tools are scoped per agent, refreshed, and bounded read avoids unavailable alternative', () => fixture(async ({ cwd }) => {
    const h = await host(cwd), before = h.hooks['execute.before'];
    writeFileSync(join(cwd, 'big.txt'), big);
    const call = (agent, tool, input) => ({ agent, tool, input, sessionID: 's', id: 'c' });
    await h.sessions.context({ sessionID: 's', agent: 'limited', tools: { webfetch: {}, read: {} }, system: [] });
    await before(call('limited', 'webfetch', { url: 'https://example.com' }));
    await assert.rejects(before(call('limited', 'read', { path: join(cwd, 'big.txt') })), e => e.message.includes('offset and limit') && !e.message.includes('ctx_execute'));
    await before(call('limited', 'read', { path: join(cwd, 'big.txt'), offset: 1, limit: 2 }));
    await assert.rejects(before(call('other', 'webfetch', { url: 'https://example.com' })), /ctx_index/);
    await h.sessions.context({ sessionID: 's', agent: 'limited', tools: { ctx_index: {}, ctx_search: {}, ctx_execute: {} }, system: [] });
    await assert.rejects(before(call('limited', 'webfetch', { url: 'https://example.com' })), /ctx_index/);
    h.stop();
}));
test('#1344/#1349 native BOM+CRLF JSON/JSONC and exact drop-in detection, without touching configured data', () => fixture(async ({ home, cwd, root }) => {
    const cfg = join(home, '.config/opencode');
    mkdirSync(cfg, { recursive: true });
    const pkg = join(root, 'pkg');
    mkdirSync(pkg);
    writeFileSync(join(pkg, 'server.mjs'), '');
    writeFileSync(join(pkg, 'hook.mjs'), '');
    const env = { ...process.env, PATH: '', Path: '' };
    for (const [file, text] of [['opencode.json', '{"plugins":["context-mode"]}'], ['opencode.jsonc', '// comment\n{"plugins":["context-mode@2.1.7"]}']]) {
        const p = join(cfg, file);
        writeFileSync(p, '\ufeff' + text.replaceAll('\n', '\r\n'));
        assert.equal(opencodeNativeRegistration([cfg]), p);
        const before = readFileSync(p, 'utf8');
        const r = await runDoctor({ home, pkgDir: pkg, env, agents: ['opencode'] });
        assert.equal(r.exitCode, 0, JSON.stringify(r));
        assert.equal(r.agents[0].status, 'SKIPPED', 'registration is not proof of an absent host runtime');
        assert(r.agents[0].checks.some(c => c.warn && c.detail.includes('verify the loaded plugin')));
        await runSetup({ home, pkgDir: pkg, env, agents: ['opencode'], runId: 'native' });
        assert.equal(readFileSync(p, 'utf8'), before);
        rmSync(p);
    }
    const plugin = join(cfg, 'plugins/context-mode/index.js');
    mkdirSync(join(plugin, '..'), { recursive: true });
    writeFileSync(plugin, 'export { default } from "context-mode/server";');
    assert.equal(opencodeNativeRegistration([cfg]), plugin);
    assert.equal(checkHostConfig(getAdapter('opencode'), env, cwd).status, 'PASS');
    writeFileSync(plugin, '// export { default } from "context-mode/server";');
    assert.equal(opencodeNativeRegistration([cfg]), undefined);
}));
test('#1344 validates every sibling config and rejects duplicate own local registration', () => fixture(async ({ home }) => {
    const cfg = join(home, '.config/opencode');
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, 'opencode.jsonc'), '[invalid');
    writeFileSync(join(cfg, 'opencode.json'), '{"plugins":["context-mode"]}');
    assert.throws(() => opencodeNativeRegistration([cfg]));
    rmSync(join(cfg, 'opencode.jsonc'));
    writeFileSync(join(cfg, 'opencode.json'), JSON.stringify({ plugins: ['context-mode'], plugin: ['/own/package'] }));
    assert.throws(() => opencodeNativeRegistration([cfg], ['/own/package']), /loads twice/);
}));

test('#1349 ignores huge unrelated plugins and broken links, supports bounded local re-export', () => fixture(async ({home}) => {
  const cfg=join(home,'.config/opencode'),plugins=join(cfg,'plugins');mkdirSync(plugins,{recursive:true});
  writeFileSync(join(plugins,'unrelated.js'),'export { default } from "context-mode/server";'+'x'.repeat(17000));
  assert.equal(opencodeNativeRegistration([cfg]),undefined);
  const target=join(cfg,'node_modules/context-mode/opencode/plugin.js');mkdirSync(join(target,'..'),{recursive:true});writeFileSync(target,'export default {};');
  writeFileSync(join(plugins,'context-mode-auto.js'),'export { default } from "../node_modules/context-mode/opencode/plugin.js";');
  assert.equal(opencodeNativeRegistration([cfg]),join(plugins,'context-mode-auto.js'));
  const {symlinkSync}=await import('node:fs');try{symlinkSync(join(cfg,'absent'),join(plugins,'broken.js'));}catch{}
  assert.equal(opencodeNativeRegistration([cfg]),join(plugins,'context-mode-auto.js'));
}));

test('#1344 an empty npm selector is not a native install',()=>fixture(async({home})=>{const cfg=join(home,'.config/opencode');mkdirSync(cfg,{recursive:true});writeFileSync(join(cfg,'opencode.json'),'{"plugins":["context-mode@"]}');assert.equal(opencodeNativeRegistration([cfg]),undefined);}));

}
