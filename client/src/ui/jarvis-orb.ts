// O orb do Jarvis em tela cheia, estilo HUD: núcleo de luz, anéis finos girando e um movimento por estado (respira
// parado, ondas ao ouvir, cometas ao pensar, anel em forma de onda ao falar). Canvas 2D na resolução da tela; a cor
// desliza de um estado ao outro. Movimento reduzido: nada gira nem se espalha; só o brilho acompanha o nível.
import type { VoicePhase } from './jarvis-model';

/** Cor de cada estado (os mesmos tons do escritório: ouvir = azul, pensar = âmbar, falar = verde, erro = vermelho). */
const HUE: Record<VoicePhase, [number, number, number]> = {
  off: [150, 170, 205],
  connecting: [150, 170, 205],
  listening: [92, 200, 255],
  thinking: [255, 181, 71],
  speaking: [79, 220, 150],
  error: [255, 107, 107],
};

interface Ripple { born: number; strength: number }

export class HudOrb {
  private color: [number, number, number] = [...HUE.off];
  private ripples: Ripple[] = [];
  private lastRipple = 0;
  private w = 0;
  private dpr = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  /** Um quadro. `t` em ms (0 = parado, movimento reduzido); `level` 0..1 (microfone ou fala). */
  draw(t: number, level: number, phase: VoicePhase): void {
    const g = this.canvas.getContext('2d');
    if (!g) return;
    this.fit();
    const target = HUE[phase];
    for (let i = 0; i < 3; i++) this.color[i] += (target[i] - this.color[i]) * 0.08;
    const [r, gr, b] = this.color.map(Math.round);
    const col = (a: number) => `rgba(${r},${gr},${b},${a})`;
    const s = this.w;
    const c = s / 2;
    const R0 = s * 0.15;
    const still = t === 0;
    const dim = phase === 'off' || phase === 'connecting' || phase === 'error' ? 0.6 : 1;
    const breathe = still ? 0 : Math.sin(t / 1400) * 0.035;
    const R = R0 * (1 + breathe + level * 0.22);

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, s, s);
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';

    // Halo: a luz do núcleo espalhada no ar.
    const halo = g.createRadialGradient(c, c, R * 0.6, c, c, R0 * 3.3);
    halo.addColorStop(0, col(0.32 * dim + level * 0.2));
    halo.addColorStop(1, col(0));
    g.fillStyle = halo;
    g.fillRect(0, 0, s, s);

    // Núcleo: esfera de luz com o ponto quente em cima à esquerda.
    const core = g.createRadialGradient(c - R * 0.3, c - R * 0.35, R * 0.05, c, c, R);
    core.addColorStop(0, `rgba(255,255,255,${0.85 * dim})`);
    core.addColorStop(0.35, col(0.75 * dim));
    core.addColorStop(1, col(0.1));
    g.fillStyle = core;
    g.beginPath();
    g.arc(c, c, R, 0, Math.PI * 2);
    g.fill();

    const ring = (radius: number, alpha: number, width: number, from = 0, to = Math.PI * 2) => {
      g.strokeStyle = col(alpha);
      g.lineWidth = width * this.dpr;
      g.beginPath();
      g.arc(c, c, radius, from, to);
      g.stroke();
    };
    const spin = (period: number) => (still ? 0 : (t / period) * Math.PI * 2);

    // Anel 1: fio contínuo + três arcos girando (acelera ao pensar e ao conectar).
    const r1 = R0 * 1.55;
    ring(r1, 0.18 * dim, 1);
    const fast = phase === 'thinking' || phase === 'connecting';
    const a1 = spin(fast ? 2600 : 9000);
    for (let i = 0; i < 3; i++) ring(r1, 0.6 * dim, 1.6, a1 + (i * Math.PI * 2) / 3, a1 + (i * Math.PI * 2) / 3 + 0.9);

    // Anel 2: marcas de régua, girando ao contrário.
    const r2 = R0 * 1.95;
    const a2 = -spin(30000);
    g.strokeStyle = col(0.35 * dim);
    g.lineWidth = this.dpr;
    g.beginPath();
    for (let i = 0; i < 90; i++) {
      const a = a2 + (i / 90) * Math.PI * 2;
      const len = i % 6 === 0 ? R0 * 0.09 : R0 * 0.035;
      g.moveTo(c + Math.cos(a) * r2, c + Math.sin(a) * r2);
      g.lineTo(c + Math.cos(a) * (r2 + len), c + Math.sin(a) * (r2 + len));
    }
    g.stroke();

    // Anel 3: dois arcos longos e lentos, o contorno do HUD.
    const r3 = R0 * 2.45;
    const a3 = spin(fast ? 7000 : 22000);
    ring(r3, 0.28 * dim, 1, a3, a3 + 1.7);
    ring(r3, 0.28 * dim, 1, a3 + Math.PI, a3 + Math.PI + 1.1);

    if (phase === 'listening') this.listening(g, t, level, c, R, R0, col, still);
    else if (phase === 'thinking' && !still) this.thinking(g, t, c, r1, col);
    else if (phase === 'speaking') this.speaking(g, t, level, c, R, R0, col, still);
    g.globalCompositeOperation = 'source-over';
  }

  /** Ouvindo: raios finos que crescem com a voz e ondas que saem do núcleo nos picos. */
  private listening(g: CanvasRenderingContext2D, t: number, level: number, c: number, R: number, R0: number, col: (a: number) => string, still: boolean): void {
    g.strokeStyle = col(0.55);
    g.lineWidth = this.dpr;
    g.beginPath();
    const n = 120;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const wob = still ? 0.6 : 0.5 + 0.5 * Math.sin(t / 120 + i * 1.7) * Math.sin(t / 310 + i * 0.37);
      const len = R0 * 0.04 + level * R0 * 0.55 * wob;
      g.moveTo(c + Math.cos(a) * (R * 1.12), c + Math.sin(a) * (R * 1.12));
      g.lineTo(c + Math.cos(a) * (R * 1.12 + len), c + Math.sin(a) * (R * 1.12 + len));
    }
    g.stroke();
    if (still) return;
    if (level > 0.22 && t - this.lastRipple > 420) {
      this.ripples.push({ born: t, strength: Math.min(1, level * 1.4) });
      this.lastRipple = t;
    }
    this.ripples = this.ripples.filter((p) => t - p.born < 1600);
    for (const p of this.ripples) {
      const k = (t - p.born) / 1600;
      const ease = 1 - Math.pow(1 - k, 3);
      g.strokeStyle = col((1 - k) * 0.5 * p.strength);
      g.lineWidth = (1 + (1 - k) * 2) * this.dpr;
      g.beginPath();
      g.arc(c, c, R + ease * R0 * 1.6, 0, Math.PI * 2);
      g.stroke();
    }
  }

  /** Pensando: três cometas no anel de dentro, com rastro. */
  private thinking(g: CanvasRenderingContext2D, t: number, c: number, r1: number, col: (a: number) => string): void {
    for (let i = 0; i < 3; i++) {
      const head = (t / 900) * Math.PI * 2 * (1 + i * 0.12) + (i * Math.PI * 2) / 3;
      for (let k = 0; k < 14; k++) {
        const a = head - k * 0.045;
        g.fillStyle = col((1 - k / 14) * 0.9);
        g.beginPath();
        g.arc(c + Math.cos(a) * r1, c + Math.sin(a) * r1, (2.6 - k * 0.15) * this.dpr, 0, Math.PI * 2);
        g.fill();
      }
    }
  }

  /** Falando: um anel que vira forma de onda com a voz (três harmônicos em ritmos diferentes). */
  private speaking(g: CanvasRenderingContext2D, t: number, level: number, c: number, R: number, R0: number, col: (a: number) => string, still: boolean): void {
    for (const [alpha, k, shift] of [[0.7, 1, 0], [0.3, 0.6, 0.8]] as const) {
      g.strokeStyle = col(alpha);
      g.lineWidth = 1.4 * this.dpr;
      g.beginPath();
      for (let i = 0; i <= 180; i++) {
        const a = (i / 180) * Math.PI * 2;
        const w = still ? 0 : Math.sin(3 * a + t / 170 + shift) * 0.5 + Math.sin(5 * a - t / 260) * 0.3 + Math.sin(9 * a + t / 110) * 0.2;
        const rr = R * 1.22 + w * level * R0 * 0.32 * k;
        const x = c + Math.cos(a) * rr;
        const y = c + Math.sin(a) * rr;
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      }
      g.stroke();
    }
  }

  /** O canvas na resolução da tela (o tamanho vem do CSS). */
  private fit(): void {
    this.dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const w = Math.round((this.canvas.clientWidth || 320) * this.dpr);
    if (w !== this.w) {
      this.w = w;
      this.canvas.width = w;
      this.canvas.height = w;
    }
  }
}
