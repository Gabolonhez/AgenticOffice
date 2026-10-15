// O botão Mundo: só com `meta.world.scene.available` e pela página do próprio computador (o snapshot também vai ao
// celular, mas as rotas da cena não); no modo demonstração, sem as travas.
import { describe, expect, it } from 'vitest';
import type { WorldMeta, WorldSource } from '../../net/world';
import { citySceneAvailable } from './scene-switch';
import type { WorldGate } from './world-model';

const meta = (scene?: { available: boolean }): WorldMeta => ({ enabled: true, configured: true, state: 'approved', ...(scene ? { scene } : {}) });
const src = (m: WorldMeta | undefined, fake = false): WorldSource => ({ client: null, fake, meta: () => m });
const LOCAL: WorldGate = { remote: false, local: true, terminal: true, fake: false };

describe('citySceneAvailable', () => {
  it('com a cena disponível e a página do próprio computador', () => {
    expect(citySceneAvailable(src(meta({ available: true })), LOCAL)).toBe(true);
    expect(citySceneAvailable(src(meta({ available: false })), LOCAL)).toBe(false);
    expect(citySceneAvailable(src(meta()), LOCAL)).toBe(false);
    expect(citySceneAvailable(src(undefined), LOCAL)).toBe(false);
  });

  it('nunca pelo celular nem sem a trava do terminal; no modo demonstração, sem as travas', () => {
    const on = meta({ available: true });
    expect(citySceneAvailable(src(on), { ...LOCAL, remote: true })).toBe(false);
    expect(citySceneAvailable(src(on), { ...LOCAL, local: false })).toBe(false);
    expect(citySceneAvailable(src(on), { ...LOCAL, terminal: false })).toBe(false);
    expect(citySceneAvailable(src(on, true), { remote: false, local: false, terminal: false, fake: true })).toBe(true);
  });
});
