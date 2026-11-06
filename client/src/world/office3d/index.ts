// Escritório 3D: os agentes viram funcionários do pacote 3D (importado em Configurações) sentados nos postos do
// escritório. Carregado sob demanda por app.ts (import()), como a cidade; three só entra no bundle desta cena.
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { tr } from '../../../../shared/i18n';
import type { AgentInfo } from '../../../../shared/types';
import type { OfficeStore } from '../../net/store';
import { h } from '../../ui/dom';
import { STATUS_LABEL } from '../../ui/model';
import type { Selection } from '../api';
import {
  assignSeats,
  employeeFile,
  employeeModelFor,
  moodFor,
  pickOffice,
  placementFor,
  type ClipName,
  type OfficeEntry,
  type Seat,
} from './office3d-model';

export interface Office3dOptions {
  canvas: HTMLCanvasElement;
  /** Onde entram o painel, as etiquetas e os avisos (o #ui, com os estilos da interface). */
  uiRoot: HTMLElement;
  store: OfficeStore;
  selection: () => Selection;
  /** Seleção mudou fora daqui (lista, gaveta, 2D). */
  onSelection: (cb: () => void) => () => void;
  /** Clique num funcionário (id) ou no vazio (null): mesmo efeito de selecionar o agente no 2D. */
  pick: (agentId: string | null) => void;
  openSettings: () => void;
}

export interface Office3dScene {
  readonly visible: boolean;
  show(): Promise<void>;
  hide(): void;
  zoomBy(factor: number): void;
  recenter(): void;
  destroy(): void;
}

interface Person {
  agentId: string;
  obj: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  gltf: GLTF;
  action: THREE.AnimationAction | null;
  clip: ClipName | '';
  standing: boolean;
  seat: Seat;
  born: number;
  label: HTMLElement;
  nameEl: HTMLElement;
  stateEl: HTMLElement;
  lx: number;
  ly: number;
}

interface Loaded {
  entry: OfficeEntry;
  obj: THREE.Object3D;
  floors: Map<number, THREE.Object3D>;
  seats: Seat[];
}

const PREF_KEY = 'habblaud.office3d';
const assetUrl = (rel: string): string => `/api/assets3d/file/${rel.split('/').map(encodeURIComponent).join('/')}`;
const SUN = new THREE.Vector3(-0.62, 0.34, 0.65).normalize();
const VIEW = new THREE.Vector3(0.95, 1.05, 1.25).normalize();
const SEAT_POSES = new Set(['type', 'laptop', 'rest', 'lounge', 'stand']);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function readPref(): string {
  try {
    return localStorage.getItem(PREF_KEY) ?? 'auto';
  } catch {
    return 'auto';
  }
}
function writePref(v: string): void {
  try {
    localStorage.setItem(PREF_KEY, v);
  } catch {
    /* sem armazenamento: a escolha vale só até recarregar */
  }
}

function parseSeats(raw: unknown): Seat[] {
  if (!Array.isArray(raw)) return [];
  const out: Seat[] = [];
  for (const s of raw as Record<string, unknown>[]) {
    if (s && typeof s.pose === 'string' && SEAT_POSES.has(s.pose) && num(s.x) && num(s.y) && num(s.z) && num(s.yaw) && num(s.altura)) {
      out.push({
        id: String(s.id),
        andar: num(s.andar) ? s.andar : 0,
        x: s.x,
        y: s.y,
        z: s.z,
        yaw: s.yaw,
        altura: s.altura,
        pose: s.pose as Seat['pose'],
        trabalho: s.trabalho === true,
        sala: typeof s.sala === 'string' ? s.sala : '',
      });
    }
  }
  return out;
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
      mat.dispose();
    }
  });
}

function skyTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  // fim de tarde: azul-arroxeado no alto, pêssego e dourado no horizonte
  grad.addColorStop(0, '#4b5389');
  grad.addColorStop(0.45, '#c98a9a');
  grad.addColorStop(0.78, '#f6b98c');
  grad.addColorStop(1, '#ffdcae');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createOffice3dScene(o: Office3dOptions): Office3dScene {
  const small = matchMedia('(max-width: 760px)').matches;
  const reducedMq = matchMedia('(prefers-reduced-motion: reduce)');
  const loader = new GLTFLoader();

  // ---- interface (painel, etiquetas, mensagens) ----
  const labels = h('div', { class: 'ui-o3d-labels', attrs: { 'aria-hidden': 'true' } });
  const officeSel = h('select', { class: 'ui-o3d-select', attrs: { 'aria-label': tr('Escritório 3D') } }) as HTMLSelectElement;
  const floorBox = h('div', { class: 'ui-seg ui-o3d-floors', role: 'radiogroup', attrs: { 'aria-label': tr('Andar') } });
  const note = h('p', { class: 'ui-o3d-note', hidden: true });
  const panel = h(
    'div',
    { class: 'ui-o3d-panel', hidden: true },
    h('label', { class: 'ui-o3d-field' }, h('span', { text: tr('Escritório 3D') }), officeSel),
    floorBox,
    note,
    h('p', { class: 'ui-o3d-hint', text: tr('Arraste para girar, role para aproximar, clique num funcionário para abrir o agente.') }),
  );
  const msgTitle = h('h2');
  const msgBody = h('p');
  const msgExtra = h('p', { class: 'ui-o3d-link' });
  const msgBtn = h('button', { class: 'ui-btn', type: 'button', text: tr('Abrir configurações'), on: { click: () => o.openSettings() } });
  const msg = h('div', { class: 'ui-o3d-msg', hidden: true, role: 'status' }, h('div', { class: 'ui-o3d-msg__card' }, msgTitle, msgBody, msgExtra, msgBtn));
  const root = h('div', { class: 'ui-o3d', hidden: true }, labels, panel, msg);
  o.uiRoot.append(root);

  function showMsg(kind: 'loading' | 'empty' | 'error' | null, text = ''): void {
    msg.hidden = kind === null;
    if (!kind) return;
    msg.classList.toggle('is-loading', kind === 'loading');
    msgTitle.textContent = kind === 'empty' ? tr('Escritório 3D') : kind === 'error' ? tr('Não deu para abrir o 3D') : text;
    msgBody.textContent =
      kind === 'empty'
        ? tr('Seus agentes viram funcionários num escritório em 3D, com as animações de digitar, acenar e apresentar. O pacote 3D tem licença própria e não vem junto com o Habblaud: baixe o zip e importe nas configurações.')
        : kind === 'error'
          ? text
          : '';
    msgExtra.textContent = kind === 'empty' ? tr('Download do pacote: {0}', ['https://iacom.com.br/buildoffice']) : '';
    msgBtn.hidden = kind !== 'empty';
    msgBody.hidden = kind === 'loading';
  }

  // ---- WebGL ----
  let renderer: THREE.WebGLRenderer | null = null;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 3000);
  let controls: OrbitControls | null = null;
  const sun = new THREE.DirectionalLight('#ffc48f', 2.8);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(1, 64), new THREE.MeshStandardMaterial({ color: '#cdb8a2', roughness: 1 }));
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.46, 0.58, 40), new THREE.MeshBasicMaterial({ color: '#7cc8ff', transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthTest: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.renderOrder = 10;
  ring.visible = false;
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;

  function ensureGL(): boolean {
    if (renderer) return true;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: o.canvas, antialias: true, powerPreference: 'high-performance' });
    } catch {
      return false;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, small ? 1.5 : 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = !small;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    scene.background = skyTexture();
    const env = new THREE.PMREMGenerator(renderer);
    scene.environment = env.fromScene(new RoomEnvironment(), 0.04).texture;
    env.dispose();
    scene.environmentIntensity = 0.5;
    scene.add(new THREE.HemisphereLight('#ffd9b8', '#6d5b47', 0.85), sun, sun.target, ground, ring);
    sun.castShadow = renderer.shadowMap.enabled;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.03;
    controls = new OrbitControls(camera, o.canvas);
    controls.enableDamping = !reducedMq.matches;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.47;
    controls.minPolarAngle = Math.PI * 0.08;
    controls.screenSpacePanning = false;
    controls.addEventListener('change', () => {
      clampTarget();
      dirty = true;
    });
    return true;
  }

  // ---- estado ----
  let visible = false;
  let raf = 0;
  let token = 0;
  let dirty = true;
  let last = 0;
  let syncDue = false;
  let entries: OfficeEntry[] = [];
  let loaded: Loaded | null = null;
  let floor: number | 'all' = 'all';
  let box = new THREE.Box3();
  let sphere = new THREE.Sphere();
  let fly: { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; t: number } | null = null;
  const people = new Map<string, Person>();
  const pending = new Set<string>();
  const gltfs = new Map<number, Promise<GLTF>>();
  const offs: (() => void)[] = [];
  let selectedId: string | null = null;

  function clampTarget(): void {
    if (!controls || box.isEmpty()) return;
    const pad = Math.max(2, sphere.radius * 0.15);
    controls.target.x = THREE.MathUtils.clamp(controls.target.x, box.min.x - pad, box.max.x + pad);
    controls.target.y = THREE.MathUtils.clamp(controls.target.y, box.min.y - pad, box.max.y + pad);
    controls.target.z = THREE.MathUtils.clamp(controls.target.z, box.min.z - pad, box.max.z + pad);
  }

  function visibleBox(): THREE.Box3 {
    const b = new THREE.Box3();
    if (!loaded) return b;
    loaded.obj.updateMatrixWorld(true);
    loaded.obj.traverse((x) => {
      const m = x as THREE.Mesh;
      if (!m.isMesh || x.name.startsWith('terreno')) return;
      for (let p: THREE.Object3D | null = x; p; p = p.parent) if (!p.visible) return;
      b.expandByObject(x);
    });
    return b;
  }

  function frameCamera(smooth: boolean): void {
    if (!controls || !loaded) return;
    box = visibleBox();
    if (box.isEmpty()) box.set(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 3, 5));
    box.getBoundingSphere(sphere);
    const fovV = THREE.MathUtils.degToRad(camera.fov);
    const fovH = 2 * Math.atan(Math.tan(fovV / 2) * camera.aspect);
    const d = (sphere.radius / Math.sin(Math.min(fovV, fovH) / 2)) * (small ? 1.15 : 0.95);
    const target = sphere.center.clone();
    const pos = target.clone().addScaledVector(VIEW, d);
    if (smooth && !reducedMq.matches) fly = { from: camera.position.clone(), to: pos, tFrom: controls.target.clone(), tTo: target, t: 0 };
    else {
      camera.position.copy(pos);
      controls.target.copy(target);
    }
    controls.minDistance = Math.max(1.5, sphere.radius * 0.1);
    controls.maxDistance = sphere.radius * 4;
    camera.near = Math.max(0.05, sphere.radius * 0.004);
    camera.far = sphere.radius * 30;
    applyInsets();
    scene.fog = new THREE.Fog('#f1c3a0', sphere.radius * 3.2, sphere.radius * 14);
    sun.target.position.copy(sphere.center);
    sun.position.copy(sphere.center).addScaledVector(SUN, sphere.radius * 3);
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -sphere.radius * 1.1;
    sc.right = sc.top = sphere.radius * 1.1;
    sc.near = 0.1;
    sc.far = sphere.radius * 6;
    sc.updateProjectionMatrix();
    ground.scale.setScalar(sphere.radius * 6);
    ground.position.set(sphere.center.x, box.min.y - 0.03, sphere.center.z);
    dirty = true;
  }

  function resize(): void {
    if (!renderer) return;
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    applyInsets();
    dirty = true;
  }

  /** Empurra o centro da imagem para a área livre (fora da lista da esquerda e da barra do topo). */
  function applyInsets(): void {
    const bar = o.uiRoot.querySelector('.ui-topbar')?.getBoundingClientRect().bottom ?? 0;
    const side = o.uiRoot.querySelector('.ui-sidebar')?.getBoundingClientRect();
    const left = side && side.width > 0 && side.left < 40 ? side.right : 0;
    camera.setViewOffset(innerWidth, innerHeight, -left / 2, -bar / 2, innerWidth, innerHeight);
    camera.updateProjectionMatrix();
  }

  // ---- pacote e escritório ----
  async function getJson<T>(rel: string): Promise<T> {
    const r = await fetch(assetUrl(rel));
    if (!r.ok) throw new Error(`${rel}: ${r.status}`);
    return (await r.json()) as T;
  }

  function disposeOffice(): void {
    for (const p of [...people.values()]) removePerson(p);
    pending.clear();
    if (loaded) {
      scene.remove(loaded.obj);
      disposeTree(loaded.obj);
      loaded = null;
    }
    ring.visible = false;
  }

  function disposeAll(): void {
    token++;
    disposeOffice();
    for (const p of gltfs.values()) void p.then((g) => disposeTree(g.scene)).catch(() => undefined);
    gltfs.clear();
  }

  function employeeGltf(n: number): Promise<GLTF> {
    let p = gltfs.get(n);
    if (!p) {
      p = loader.loadAsync(assetUrl(employeeFile(n)));
      gltfs.set(n, p);
      p.catch(() => gltfs.delete(n));
    }
    return p;
  }

  function applyFloor(): void {
    if (!loaded) return;
    for (const [n, g] of loaded.floors) g.visible = floor === 'all' || n <= floor;
    // teto e andares de cima saem da frente: a câmera olha de cima para dentro
    loaded.obj.traverse((x) => {
      if (x.userData?.teto) x.visible = false;
    });
    frameCamera(true);
  }

  function buildFloorButtons(): void {
    floorBox.replaceChildren();
    const f = loaded?.floors;
    floorBox.hidden = !f || f.size < 2;
    if (!f || f.size < 2) return;
    const mk = (value: number | 'all', text: string) => {
      const b = h('button', { class: 'ui-seg__opt', type: 'button', role: 'radio', text, attrs: { 'aria-checked': String(floor === value) } });
      b.addEventListener('click', () => {
        floor = value;
        floorBox.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
        applyFloor();
        syncLabels(true);
      });
      floorBox.append(b);
    };
    mk('all', tr('Tudo'));
    for (const n of [...f.keys()].sort((a, b) => a - b)) mk(n, n === 0 ? tr('Térreo') : tr('{0}º andar', [n]));
  }

  async function openOffice(entry: OfficeEntry): Promise<void> {
    const mine = ++token;
    showMsg('loading', tr('Carregando {0}…', [entry.nome]));
    try {
      const [gltf, data] = await Promise.all([
        loader.loadAsync(assetUrl(entry.arquivo), (ev) => {
          if (mine === token && ev.total) showMsg('loading', tr('Carregando {0}… {1}%', [entry.nome, Math.round((ev.loaded / ev.total) * 100)]));
        }),
        getJson<{ assentos?: unknown }>(entry.dados),
      ]);
      if (mine !== token) return void disposeTree(gltf.scene);
      disposeOffice();
      gltf.scene.traverse((x) => {
        const m = x as THREE.Mesh;
        if (!m.isMesh) return;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        m.castShadow = !mats.some((q) => q.transparent);
        m.receiveShadow = true;
      });
      const floors = new Map<number, THREE.Object3D>();
      gltf.scene.traverse((x) => {
        const m = /^andar_(\d+)$/.exec(x.name);
        if (m) floors.set(Number(m[1]), x);
      });
      loaded = { entry, obj: gltf.scene, floors, seats: parseSeats(data.assentos) };
      scene.add(gltf.scene);
      floor = 'all';
      // vários andares: começa no mais alto onde há gente (quem está embaixo continua à vista)
      if (floors.size > 1) {
        const top = Math.max(0, ...[...plan().seats.values()].map((q) => q.andar));
        floor = Math.min(top, Math.max(...floors.keys()));
      }
      buildFloorButtons();
      applyFloor();
      syncPeople();
      showMsg(null);
      syncLabels(true);
    } catch (err) {
      console.error('[office3d]', err);
      if (mine === token) showMsg('error', tr('Não consegui abrir {0}. Importe o pacote de novo nas configurações.', [entry.nome]));
    }
  }

  function chosenEntry(): OfficeEntry | null {
    const pref = readPref();
    const fixed = pref !== 'auto' ? entries.find((e) => e.id === pref) : undefined;
    if (fixed) return fixed;
    const snap = o.store.snapshot;
    return pickOffice(entries, snap?.agents.length ?? 0, snap?.rooms.length ?? 0);
  }

  function fillOfficeSelect(): void {
    officeSel.replaceChildren(new Option(tr('Automático (pelo número de projetos)'), 'auto'));
    for (const e of [...entries].sort((a, b) => a.postos_de_trabalho - b.postos_de_trabalho || a.id.localeCompare(b.id))) {
      officeSel.append(new Option(`${e.nome} · ${tr('{0} postos', [e.postos_de_trabalho])}`, e.id));
    }
    const pref = readPref();
    officeSel.value = entries.some((e) => e.id === pref) ? pref : 'auto';
  }

  async function start(): Promise<void> {
    const mine = ++token;
    showMsg('loading', tr('Abrindo o escritório 3D…'));
    panel.hidden = true;
    let status: { installed: boolean };
    try {
      const r = await fetch('/api/assets3d');
      status = r.ok ? ((await r.json()) as { installed: boolean }) : { installed: false };
    } catch {
      status = { installed: false };
    }
    if (mine !== token) return;
    if (!status.installed) return void showMsg('empty');
    try {
      entries = (await getJson<{ escritorios: OfficeEntry[] }>('escritorios/indice.json')).escritorios;
    } catch {
      return void showMsg('error', tr('Não consegui ler o pacote 3D. Importe o zip de novo nas configurações.'));
    }
    if (mine !== token) return;
    fillOfficeSelect();
    panel.hidden = false;
    const entry = chosenEntry();
    if (!entry) return void showMsg('empty');
    await openOffice(entry);
  }

  // ---- funcionários ----
  function makeLabel(agent: AgentInfo): { label: HTMLElement; nameEl: HTMLElement; stateEl: HTMLElement } {
    const nameEl = h('b', { text: agent.name });
    const stateEl = h('span');
    const label = h('button', { class: 'ui-o3d-label', type: 'button', hidden: true }, h('i'), nameEl, stateEl);
    label.addEventListener('click', () => o.pick(label.dataset.agent ?? null));
    label.dataset.agent = agent.id;
    labels.append(label);
    return { label, nameEl, stateEl };
  }

  function removePerson(p: Person): void {
    p.mixer.stopAllAction();
    p.mixer.uncacheRoot(p.obj);
    p.obj.removeFromParent();
    p.label.remove();
    people.delete(p.agentId);
  }

  function setMood(p: Person, agent: AgentInfo, snapNow: number): void {
    const mood = moodFor(agent.status, p.seat.pose, snapNow - agent.statusSince);
    if (mood.clip === p.clip && mood.standing === p.standing) return;
    const clip = THREE.AnimationClip.findByName(p.gltf.animations, mood.clip) ?? p.gltf.animations[0];
    const next = clip ? p.mixer.clipAction(clip) : null;
    if (next && next !== p.action) {
      next.reset().play();
      if (p.action) next.crossFadeFrom(p.action, reducedMq.matches ? 0 : 0.3, false);
      else next.time = (p.agentId.length * 0.37) % clip.duration;
      p.action = next;
      if (reducedMq.matches) p.mixer.update(0.4);
    }
    p.clip = mood.clip;
    p.standing = mood.standing;
    const pl = placementFor(p.seat, mood.standing);
    p.obj.position.set(pl.x, pl.y, pl.z);
    p.obj.rotation.y = pl.yaw;
    dirty = true;
  }

  /** Quem senta onde, no escritório aberto, mantendo quem já está sentado. */
  function plan(): ReturnType<typeof assignSeats> {
    const snap = o.store.snapshot;
    return assignSeats(
      (snap?.agents ?? []).map((a) => ({ id: a.id, roomId: a.roomId, startedAt: a.startedAt })),
      (snap?.rooms ?? []).map((r) => ({ id: r.id, name: r.name, slot: r.slot })),
      loaded?.seats ?? [],
      new Map([...people].map(([id, p]) => [id, p.seat.id])),
    );
  }

  function syncPeople(): void {
    if (!loaded) return;
    const snap = o.store.snapshot;
    const agents = snap?.agents ?? [];
    const plan_ = plan();
    const ids = new Set(agents.map((a) => a.id));
    for (const p of [...people.values()]) if (!ids.has(p.agentId) || !plan_.seats.has(p.agentId)) removePerson(p);
    labels.classList.toggle('is-crowded', agents.length > 10);
    note.hidden = plan_.missing.length === 0;
    if (plan_.missing.length) note.textContent = tr('{0} agentes sem lugar neste escritório. Escolha um maior.', [plan_.missing.length]);
    const now = snap?.serverTime ?? Date.now();
    for (const a of agents) {
      const seat = plan_.seats.get(a.id);
      if (!seat) continue;
      const have = people.get(a.id);
      if (have) {
        if (have.seat.id !== seat.id) {
          have.seat = seat;
          have.clip = '';
          (loaded.floors.get(seat.andar) ?? loaded.obj).add(have.obj);
        }
        have.nameEl.textContent = a.name;
        have.stateEl.textContent = a.status === 'waiting' && a.waitingFor ? a.waitingFor : STATUS_LABEL[a.status];
        have.label.className = `ui-o3d-label is-${a.status}`;
        setMood(have, a, now);
      } else if (!pending.has(a.id)) {
        pending.add(a.id);
        const target = loaded;
        void employeeGltf(employeeModelFor(a.id)).then(
          (g) => {
            pending.delete(a.id);
            if (loaded !== target || people.has(a.id)) return;
            const cur = o.store.agent(a.id);
            if (!cur) return;
            const obj = g.scene.clone(true);
            obj.userData.agentId = cur.id;
            obj.traverse((x) => {
              const m = x as THREE.Mesh;
              if (m.isMesh) {
                m.castShadow = true;
                m.receiveShadow = true;
              }
            });
            const parts = makeLabel(cur);
            const p: Person = { agentId: cur.id, obj, mixer: new THREE.AnimationMixer(obj), gltf: g, action: null, clip: '', standing: false, seat, born: reducedMq.matches ? 1 : 0, ...parts, lx: -1, ly: -1 };
            obj.scale.setScalar(p.born ? 1 : 0.001);
            (target.floors.get(seat.andar) ?? target.obj).add(obj);
            people.set(cur.id, p);
            syncPeople();
            syncLabels(true);
          },
          () => pending.delete(a.id),
        );
      }
    }
    dirty = true;
  }

  const tmp = new THREE.Vector3();
  function syncLabels(force = false): void {
    const w = innerWidth;
    const hgt = innerHeight;
    for (const p of people.values()) {
      const shown = p.obj.parent?.visible !== false;
      p.obj.getWorldPosition(tmp);
      tmp.y += 1.95;
      tmp.project(camera);
      const on = shown && tmp.z < 1 && Math.abs(tmp.x) < 1.1 && Math.abs(tmp.y) < 1.1;
      if (p.label.hidden === on) p.label.hidden = !on;
      if (!on) continue;
      const x = Math.round(((tmp.x + 1) / 2) * w);
      const y = Math.round(((1 - tmp.y) / 2) * hgt);
      if (force || x !== p.lx || y !== p.ly) {
        p.lx = x;
        p.ly = y;
        p.label.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
      }
      p.label.classList.toggle('is-selected', p.agentId === selectedId);
    }
  }

  function syncSelection(): void {
    const sel = o.selection();
    selectedId = sel?.type === 'agent' ? sel.id : null;
    dirty = true;
  }

  // ---- laço ----
  function frame(ts: number): void {
    raf = requestAnimationFrame(frame);
    if (document.hidden || !renderer || !controls) return;
    const dt = Math.min((ts - last) / 1000, 0.05) || 0;
    last = ts;
    if (syncDue) {
      syncDue = false;
      syncPeople();
    }
    if (fly) {
      fly.t = Math.min(1, fly.t + dt * 1.6);
      const k = 1 - Math.pow(1 - fly.t, 3);
      camera.position.lerpVectors(fly.from, fly.to, k);
      controls.target.lerpVectors(fly.tFrom, fly.tTo, k);
      if (fly.t >= 1) fly = null;
      dirty = true;
    }
    if (controls.update()) dirty = true;
    const still = reducedMq.matches;
    const sel = selectedId ? people.get(selectedId) : undefined;
    for (const p of people.values()) {
      if (!still) p.mixer.update(dt);
      if (p.born < 1) {
        p.born = Math.min(1, p.born + dt * 3.5);
        p.obj.scale.setScalar(Math.max(0.001, 1 - Math.pow(1 - p.born, 3)));
        dirty = true;
      }
    }
    ring.visible = !!sel && sel.obj.parent?.visible !== false;
    if (ring.visible && sel) {
      sel.obj.getWorldPosition(ring.position);
      ring.position.y += 0.03;
      ring.scale.setScalar(still ? 1 : 1 + 0.06 * Math.sin(ts / 260));
    }
    if (!still || dirty) {
      renderer.render(scene, camera);
      syncLabels();
      dirty = false;
    }
  }

  // clique curto num funcionário = selecionar o agente (como no 2D)
  const ray = new THREE.Raycaster();
  let down: { x: number; y: number; t: number } | null = null;
  const onDown = (e: PointerEvent) => void (down = { x: e.clientX, y: e.clientY, t: performance.now() });
  const onUp = (e: PointerEvent) => {
    const d = down;
    down = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || performance.now() - d.t > 450) return;
    ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
    const roots = [...people.values()].filter((p) => p.obj.parent?.visible !== false).map((p) => p.obj);
    const hit = ray.intersectObjects(roots, true)[0];
    let node: THREE.Object3D | null = hit?.object ?? null;
    while (node && !node.userData.agentId) node = node.parent;
    if (node) o.pick(node.userData.agentId as string);
    else if (selectedId) o.pick(null);
  };

  const onResize = () => resize();
  const onVisibility = () => void (dirty = true);
  const onImported = () => {
    if (visible) void start();
  };
  const clock = setInterval(() => void (visible && (syncDue = true)), 30_000);

  function onSnapshot(): void {
    syncDue = true;
  }

  return {
    get visible() {
      return visible;
    },
    async show() {
      if (visible) return;
      if (!ensureGL()) {
        root.hidden = false;
        panel.hidden = true;
        showMsg('error', tr('Este navegador não abriu o 3D. Tente outro navegador ou o computador.'));
        visible = true;
        return;
      }
      visible = true;
      o.canvas.hidden = false;
      root.hidden = false;
      resize();
      addEventListener('resize', onResize);
      document.addEventListener('visibilitychange', onVisibility);
      addEventListener('habblaud:3d-imported', onImported);
      o.canvas.addEventListener('pointerdown', onDown);
      o.canvas.addEventListener('pointerup', onUp);
      offs.push(o.store.on('snapshot', onSnapshot), o.onSelection(syncSelection));
      officeSel.onchange = () => {
        writePref(officeSel.value);
        const e = chosenEntry();
        if (e) void openOffice(e);
      };
      syncSelection();
      last = performance.now();
      raf = requestAnimationFrame(frame);
      await start();
    },
    hide() {
      if (!visible) return;
      visible = false;
      cancelAnimationFrame(raf);
      removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      removeEventListener('habblaud:3d-imported', onImported);
      o.canvas.removeEventListener('pointerdown', onDown);
      o.canvas.removeEventListener('pointerup', onUp);
      offs.splice(0).forEach((f) => f());
      // sai da memória da placa de vídeo; o pacote volta do cache do navegador (304) na próxima vez
      disposeAll();
      root.hidden = true;
      o.canvas.hidden = true;
      fly = null;
    },
    zoomBy(factor) {
      if (!controls) return;
      const off = camera.position.clone().sub(controls.target);
      off.setLength(THREE.MathUtils.clamp(off.length() / factor, controls.minDistance, controls.maxDistance));
      camera.position.copy(controls.target).add(off);
      dirty = true;
    },
    recenter() {
      frameCamera(true);
    },
    destroy() {
      this.hide();
      clearInterval(clock);
      root.remove();
      controls?.dispose();
      renderer?.dispose();
      renderer = null;
    },
  };
}
