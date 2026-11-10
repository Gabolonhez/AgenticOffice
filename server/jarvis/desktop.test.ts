import { describe, expect, it } from 'vitest';
import { resolveTarget } from './desktop';

const apps = [
  { name: 'Spotify', path: 'C:\sm\Spotify.lnk' },
  { name: 'Google Chrome', path: 'C:\sm\Google Chrome.lnk' },
  { name: 'Chrome Remote Desktop', path: 'C:\sm\Chrome Remote Desktop.lnk' },
];

describe('pc_open: o que pode ser aberto', () => {
  it('links http(s); domínio sem esquema ganha https', () => {
    expect(resolveTarget('https://youtube.com/watch?v=1', apps)).toMatchObject({ kind: 'url', url: 'https://youtube.com/watch?v=1' });
    expect(resolveTarget('youtube.com', apps)).toMatchObject({ kind: 'url', url: 'https://youtube.com/' });
  });
  it('nunca outros esquemas, caminhos nem comandos', () => {
    for (const bad of ['file:///C:/Windows/System32/cmd.exe', 'C:\Windows\System32\cmd.exe', 'javascript:alert(1)', 'ms-settings:', 'cmd /c del', '']) {
      expect(resolveTarget(bad, apps)).toHaveProperty('error');
    }
  });
  it('apps do Menu Iniciar pelo nome: exato, parte única, ou pede para escolher', () => {
    expect(resolveTarget('spotify', apps)).toEqual({ kind: 'app', path: 'C:\sm\Spotify.lnk', label: 'Spotify' });
    expect(resolveTarget('Google Chrome', apps)).toMatchObject({ label: 'Google Chrome' });
    expect(resolveTarget('chrome', apps)).toHaveProperty('error');
    expect(resolveTarget('notion', apps)).toHaveProperty('error');
  });
});

describe('pc_open: apps bloqueados', () => {
  it('terminais e ferramentas de sistema ficam fora; apps comuns passam', async () => {
    const { BLOCKED_APP } = await import('./desktop');
    for (const n of ['Command Prompt', 'Windows PowerShell', 'Terminal', 'Registry Editor', 'Run', 'Git Bash', 'WSL', 'Task Scheduler', 'x64 Native Tools Command Prompt for VS']) expect(BLOCKED_APP.test(n), n).toBe(true);
    for (const n of ['Notepad', 'Calculator', 'Google Chrome', 'Spotify', 'WhatsApp Beta', 'Visual Studio Code', 'Settings']) expect(BLOCKED_APP.test(n), n).toBe(false);
  });
});
