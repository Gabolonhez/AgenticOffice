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
