import { describe, expect, it } from 'vitest';
import { resolveCliBin } from './bins';

describe('chat: executáveis das CLIs', () => {
  it('Windows: shim .cmd do npm vira o binário real', () => {
    const npm = 'C:\\Users\\u\\AppData\\Roaming\\npm';
    const files = new Set([`${npm}\\claude.cmd`, `${npm}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`, `${npm}\\codex.cmd`, `${npm}\\node_modules\\@openai\\codex\\bin\\codex.js`, 'C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe']);
    const env = { PATH: `${npm};C:\\Users\\u\\AppData\\Local\\agy\\bin`, PATHEXT: '.EXE;.CMD' };
    const has = (p: string) => files.has(p);
    expect(resolveCliBin('claude', env, 'win32', has)).toEqual({ file: `${npm}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`, prefix: [] });
    expect(resolveCliBin('codex', env, 'win32', has)).toEqual({ file: process.execPath, prefix: [`${npm}\\node_modules\\@openai\\codex\\bin\\codex.js`] });
    expect(resolveCliBin('antigravity', env, 'win32', has)).toEqual({ file: 'C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe', prefix: [] });
    expect(resolveCliBin('claude', { PATH: npm, PATHEXT: '.CMD' }, 'win32', (p) => p.endsWith('claude.cmd'))).toBeUndefined(); // .cmd sem alvo: indisponível
  });
  it('override de env vence o PATH', () => {
    expect(resolveCliBin('antigravity', { PATH: '', HABBLAUD_AGY_BIN: '/opt/agy/agy' }, 'linux', () => true)).toEqual({ file: '/opt/agy/agy', prefix: [] });
  });
});
