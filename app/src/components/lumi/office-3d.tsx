"use client";

// Cảnh Văn phòng 3D (three.js): một căn phòng có sàn, hai vách thấp và các góc làm việc.
// Chỉ được tải động khi người dùng chọn 3D.
import { useEffect, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { colsFor, DX, DZ, layoutSpots, shortName } from "@/lib/lumi/office-layout";
import { Avatar } from "./avatar";

export interface Office3DMember {
  id: string;
  name: string;
  role: string;
  avatar: string;
  color: string;
  archived: boolean;
  busy: boolean;
  waiting: boolean;
}
export interface Office3DHandle {
  reset: () => void;
  zoom: (factor: number) => void;
}
interface Props {
  members: Office3DMember[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onUnsupported: (message: string) => void;
  handleRef: MutableRefObject<Office3DHandle | null>;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawLabel(canvas: HTMLCanvasElement, m: Office3DMember, selected: boolean) {
  const ctx = canvas.getContext("2d")!;
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  roundRect(ctx, 4, 4, W - 8, H - 8, H / 2 - 4);
  ctx.fillStyle = selected ? "rgba(40,30,8,0.95)" : "rgba(12,14,20,0.82)";
  ctx.fill();
  ctx.lineWidth = selected ? 7 : 3;
  ctx.strokeStyle = selected ? "#f5b84a" : "rgba(130,142,165,0.6)";
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = m.archived ? "#f09a9a" : "#ffffff";
  ctx.font = "700 64px system-ui, 'Segoe UI', Roboto, sans-serif";
  ctx.fillText(shortName(m.name), W / 2, H / 2 + 3);
}

function drawCoin(canvas: HTMLCanvasElement, color: string, svgMarkup: string | null, onDone: () => void) {
  const ctx = canvas.getContext("2d")!;
  const S = canvas.width;
  ctx.clearRect(0, 0, S, S);
  const g = ctx.createLinearGradient(0, 0, S, S);
  g.addColorStop(0, color);
  g.addColorStop(1, `${color}aa`);
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S / 2 - 6, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 9;
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.stroke();
  if (!svgMarkup) return;
  const img = new Image();
  img.onload = () => {
    const sz = S * 0.58;
    ctx.drawImage(img, (S - sz) / 2, (S - sz) / 2, sz, sz);
    onDone();
  };
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgMarkup)}`;
}

function plankTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#2b2a31";
  ctx.fillRect(0, 0, 512, 512);
  const tones = ["#2f2d36", "#2a2830", "#34313a", "#2c2b33"];
  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = tones[i % tones.length]!;
    ctx.fillRect(0, i * 64, 512, 62);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(0, i * 64 + 62, 512, 2);
    const off = (i * 173) % 512;
    ctx.fillRect(off, i * 64, 2, 62);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

class OfficeScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private room = new THREE.Group();
  private group = new THREE.Group();
  private sun: THREE.DirectionalLight;
  private hits: THREE.Object3D[] = [];
  private rings = new Map<string, THREE.Mesh>();
  private labels = new Map<string, { canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; m: Office3DMember; sprite: THREE.Sprite }>();
  private coins = new Map<string, THREE.Sprite>();
  private raf = 0;
  private ro: ResizeObserver;
  private down: { x: number; y: number; t: number } | null = null;
  private defaultPos = new THREE.Vector3(8, 8, 10);
  private defaultTarget = new THREE.Vector3(0, 1, 0);
  private selected: string | null = null;
  private disposed = false;
  private count = 0;
  private plank = plankTexture();

  constructor(private container: HTMLDivElement, private onPick: (id: string) => void, private onLost: () => void) {
    const probe = document.createElement("canvas");
    if (!(probe.getContext("webgl2") ?? probe.getContext("webgl"))) throw new Error("webgl-unavailable");
    const w = container.clientWidth || 600;
    const h = container.clientHeight || 400;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.setAttribute("aria-label", "Cảnh văn phòng 3D. Dùng danh sách thành viên bên dưới để chọn bằng bàn phím.");
    this.renderer.domElement.setAttribute("data-testid", "canvas-3d");
    container.prepend(this.renderer.domElement);
    this.renderer.domElement.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.onLost();
    });

    this.scene.background = new THREE.Color(0x0d0f15);
    this.camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 120);
    this.camera.position.copy(this.defaultPos);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 40;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.target.copy(this.defaultTarget);

    // Ánh sáng ấm: nền trời mờ, nắng xiên từ góc mở của căn phòng, đèn trần vàng nhạt.
    this.scene.add(new THREE.HemisphereLight(0xe6ecff, 0x39303a, 1.7));
    this.sun = new THREE.DirectionalLight(0xffe2b0, 2.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(this.room, this.group);

    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", this.onDown);
    el.addEventListener("pointerup", this.onUp);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.loop();
  }

  private resize() {
    if (this.disposed) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.scaleLabels();
  }

  /** Màn hình dọc (điện thoại) phóng nhãn lên một chút để vẫn đọc được tên. */
  private scaleLabels() {
    const k = this.camera.aspect < 1 ? 1.45 : 1;
    for (const l of this.labels.values()) l.sprite.scale.set(1.6 * k, 0.42 * k, 1);
  }

  private onDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY, t: performance.now() };
  };
  private onUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    if (!d) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || performance.now() - d.t > 700) return; // kéo xoay, không phải chạm
    const id = this.pick(e.clientX, e.clientY);
    if (id) this.onPick(id);
  };
  private pick(cx: number, cy: number): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObjects(this.hits, false)[0];
    return (hit?.object.userData.memberId as string | undefined) ?? null;
  }

  /** Dùng cho kiểm thử: chiếu vị trí một thành viên ra tọa độ trang. */
  screenPositionOf(id: string): { x: number; y: number } | null {
    const hit = this.hits.find((o) => o.userData.memberId === id);
    if (!hit) return null;
    const p = hit.getWorldPosition(new THREE.Vector3());
    p.y += 0.2;
    p.project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height };
  }

  /**
   * Góc nhìn mặc định: từ góc mở của căn phòng (phía trước, bên phải) nhìn vào hai vách.
   * Lùi camera dần cho tới khi mọi góc sàn, đỉnh vách và đầu người (kể cả hàng sát camera) nằm trong khung hình,
   * nên 3, 6 hay 9 thành viên, màn ngang hay dọc đều vừa khít.
   */
  private fit() {
    const n = Math.max(1, this.count);
    const cols = Math.min(colsFor(n), n);
    const rows = Math.ceil(n / colsFor(n));
    const W = (cols - 1) * DX + 5.4;
    const D = (rows - 1) * DZ + 5.4;
    const pts: THREE.Vector3[] = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [0, 1.7]) pts.push(new THREE.Vector3((sx * W) / 2, y, (sz * D) / 2));
    for (const sp of layoutSpots(n)) {
      pts.push(new THREE.Vector3(sp.x, 3.0, sp.z + 0.9), new THREE.Vector3(sp.x + 1.3, 0, sp.z + 1.9), new THREE.Vector3(sp.x - 1.3, 0, sp.z + 1.9));
    }
    const dir = new THREE.Vector3(0.62, 0.74, 0.78).normalize();
    const target = new THREE.Vector3(0, 0.9, 0.2);
    const cam = this.camera.clone();
    cam.aspect = Math.max(0.45, this.camera.aspect || 1.6);
    cam.updateProjectionMatrix();
    const tanV = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const tanH = tanV * cam.aspect;
    const measure = (d: number) => {
      cam.position.copy(target).addScaledVector(dir, d);
      cam.lookAt(target);
      cam.updateMatrixWorld(true);
      let minX = 9, maxX = -9, minY = 9, maxY = -9;
      for (const p of pts) {
        const q = p.clone().project(cam);
        minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
        minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
      }
      return { minX, maxX, minY, maxY, worst: Math.max(Math.abs(minX), Math.abs(maxX), Math.abs(minY), Math.abs(maxY)) };
    };
    let dist = 7;
    // Cân giữa khung hình (dịch tâm nhìn) rồi lùi vừa đủ; lặp vài lần cho hội tụ.
    for (let pass = 0; pass < 3; pass++) {
      dist = 6;
      while (dist < 70 && measure(dist).worst > 0.92) dist += 0.3;
      const m = measure(dist);
      const cx = (m.minX + m.maxX) / 2;
      const cy = (m.minY + m.maxY) / 2;
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
      target.addScaledVector(right, cx * dist * tanH).addScaledVector(up, cy * dist * tanV);
    }
    dist = 6;
    while (dist < 70 && measure(dist).worst > 0.92) dist += 0.3;
    this.defaultTarget.copy(target);
    this.defaultPos.copy(target).addScaledVector(dir, dist);
    this.controls.maxDistance = Math.max(30, dist * 2);
  }

  reset() {
    this.fit();
    this.camera.position.copy(this.defaultPos);
    this.controls.target.copy(this.defaultTarget);
    this.controls.update();
  }
  zoom(f: number) {
    const v = this.camera.position.clone().sub(this.controls.target).multiplyScalar(f);
    const len = Math.min(this.controls.maxDistance, Math.max(this.controls.minDistance, v.length()));
    v.setLength(len);
    this.camera.position.copy(this.controls.target).add(v);
    this.controls.update();
  }

  setSelected(id: string | null) {
    this.selected = id;
    for (const [mid, ring] of this.rings) ring.visible = mid === id;
    for (const [mid, l] of this.labels) {
      drawLabel(l.canvas, l.m, mid === id);
      l.tex.needsUpdate = true;
    }
  }

  private disposeGroup(g: THREE.Group) {
    g.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      for (const m of Array.isArray(mat) ? mat : mat ? [mat] : []) {
        const mm = m as THREE.MeshBasicMaterial;
        if (mm.map && mm.map !== this.plank) mm.map.dispose();
        m.dispose();
      }
    });
    g.clear();
  }

  setMembers(members: Office3DMember[], iconSvg: (avatar: string) => string | null) {
    this.disposeGroup(this.group);
    this.hits = [];
    this.rings.clear();
    this.labels.clear();
    this.coins.clear();
    this.count = members.length;
    const spots = layoutSpots(members.length);
    members.forEach((m, i) => this.group.add(this.buildDesk(m, spots[i]!.x, spots[i]!.z, iconSvg(m.avatar))));
    this.buildRoom();
    this.scaleLabels();
    this.reset();
    this.setSelected(this.selected);
  }

  /** Sàn, hai vách thấp (sau và trái), thảm, cửa sổ và cây cảnh; kích thước theo số hàng/cột. */
  private buildRoom() {
    this.disposeGroup(this.room);
    const n = Math.max(1, this.count);
    const cols = Math.min(colsFor(n), n);
    const rows = Math.ceil(n / colsFor(n));
    const W = (cols - 1) * DX + 5.4;
    const D = (rows - 1) * DZ + 5.4;
    const std = (color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...extra });

    const floorMat = std(0xffffff, { map: this.plank, roughness: 0.9 });
    this.plank.repeat.set(W / 3.2, D / 3.2);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.room.add(floor);
    // Nền ngoài phòng tối hơn để căn phòng nổi lên.
    const outer = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), std(0x0f1118));
    outer.rotation.x = -Math.PI / 2;
    outer.position.y = -0.02;
    outer.receiveShadow = true;
    this.room.add(outer);

    const H = 1.7;
    const wallMat = std(0x343b4d);
    const trimMat = new THREE.MeshStandardMaterial({ color: 0xf5b84a, emissive: 0xf5b84a, emissiveIntensity: 0.35, roughness: 0.5 });
    const back = new THREE.Mesh(new THREE.BoxGeometry(W + 0.3, H, 0.24), wallMat);
    back.position.set(0, H / 2, -D / 2 - 0.12);
    back.castShadow = back.receiveShadow = true;
    const left = new THREE.Mesh(new THREE.BoxGeometry(0.24, H, D + 0.3), wallMat);
    left.position.set(-W / 2 - 0.12, H / 2, 0);
    left.castShadow = left.receiveShadow = true;
    this.room.add(back, left);
    const trimB = new THREE.Mesh(new THREE.BoxGeometry(W + 0.34, 0.06, 0.3), trimMat);
    trimB.position.set(0, H + 0.03, -D / 2 - 0.12);
    const trimL = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.06, D + 0.34), trimMat);
    trimL.position.set(-W / 2 - 0.12, H + 0.03, 0);
    this.room.add(trimB, trimL);
    // Chân tường sáng hơn một chút.
    const base = new THREE.Mesh(new THREE.BoxGeometry(W + 0.3, 0.14, 0.3), std(0x232838));
    base.position.set(0, 0.07, -D / 2 - 0.1);
    this.room.add(base);

    // Cửa sổ trên vách sau: các ô sáng nhạt.
    const winMat = new THREE.MeshStandardMaterial({ color: 0x9ec3ff, emissive: 0x7aa7ff, emissiveIntensity: 0.55, roughness: 0.3 });
    const wins = Math.max(2, Math.round(W / 4.2));
    for (let i = 0; i < wins; i++) {
      const wx = -W / 2 + ((i + 0.5) * W) / wins;
      const win = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.7, 0.06), winMat);
      win.position.set(wx, 1.0, -D / 2 + 0.02);
      this.room.add(win);
    }
    // Cây cảnh ở góc trong.
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.22, 0.45, 16), std(0x4a3a2c));
    pot.position.set(-W / 2 + 0.55, 0.22, -D / 2 + 0.55);
    pot.castShadow = true;
    const leaves = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 12), std(0x2f7a52));
    leaves.position.set(-W / 2 + 0.55, 0.85, -D / 2 + 0.55);
    leaves.castShadow = true;
    this.room.add(pot, leaves);

    // Đèn trần: hai vùng sáng ấm.
    for (const [lx, lz] of [[-W * 0.2, -D * 0.2], [W * 0.22, D * 0.18]] as const) {
      const pl = new THREE.PointLight(0xffd9a0, 14, 16, 1.6);
      pl.position.set(lx, 4.2, lz);
      this.room.add(pl);
    }
    // Nắng: từ góc mở (phía trước, bên phải), bao phủ cả căn phòng.
    this.sun.position.set(W * 0.7, 9, D * 0.8);
    this.sun.target.position.set(0, 0, 0);
    const sc = this.sun.shadow.camera;
    const ext = Math.max(W, D) * 0.9;
    sc.left = -ext;
    sc.right = ext;
    sc.top = ext;
    sc.bottom = -ext;
    sc.near = 1;
    sc.far = 40;
    sc.updateProjectionMatrix();
  }

  /** Một góc làm việc: thảm, bàn, màn hình, ghế, vách ngăn thấp, người ngồi, đồng xu avatar và nhãn tên ngắn. */
  private buildDesk(m: Office3DMember, x: number, z: number, svg: string | null): THREE.Group {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    const std = (color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...extra });
    const box = (w: number, h: number, d: number, color: number, px: number, py: number, pz: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), std(color, extra));
      mesh.position.set(px, py, pz);
      mesh.castShadow = mesh.receiveShadow = true;
      g.add(mesh);
      return mesh;
    };
    const accent = new THREE.Color(m.archived ? "#5a606b" : m.color);
    // Thảm theo màu avatar.
    const rug = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.03, 3.0), std(accent.getHex(), { roughness: 1, transparent: true, opacity: 0.38 }));
    rug.position.set(0, 0.016, 0.5);
    rug.receiveShadow = true;
    g.add(rug);
    // Bàn gỗ ấm.
    box(2.3, 0.12, 1.15, m.archived ? 0x4a4f5a : 0x9a7449, 0, 0.95, 0);
    for (const [lx, lz] of [[-1.05, -0.45], [1.05, -0.45], [-1.05, 0.45], [1.05, 0.45]] as const) box(0.09, 0.95, 0.09, 0x272b35, lx, 0.475, lz);
    // Vách ngăn thấp phía sau và bên trái tạo cảm giác "góc làm việc".
    box(2.6, 0.9, 0.08, 0x3b4256, 0, 0.45, -0.72);
    box(0.08, 0.9, 1.9, 0x3b4256, -1.3, 0.45, 0.1);
    // Màn hình hướng về người ngồi, có sáng theo màu avatar.
    box(0.95, 0.58, 0.05, 0x0e1014, 0, 1.52, -0.3);
    box(0.84, 0.46, 0.02, 0x000000, 0, 1.52, -0.27, { emissive: accent, emissiveIntensity: m.busy ? 1.2 : 0.4, color: 0x05070a });
    box(0.1, 0.3, 0.1, 0x1c1f27, 0, 1.18, -0.3);
    box(0.5, 0.03, 0.2, 0x181b22, 0, 1.03, 0.1); // bàn phím
    // Ghế.
    box(0.82, 0.1, 0.82, 0x20242e, 0, 0.62, 0.95);
    box(0.82, 0.85, 0.1, 0x20242e, 0, 1.05, 1.4);
    box(0.1, 0.6, 0.1, 0x14161c, 0, 0.3, 0.95);
    // Người ngồi (quay lưng ra phía ghế, hướng về màn hình): thân, đầu, hai tay.
    const bodyMat = std(accent.getHex(), { roughness: 0.55 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.38, 0.9, 20), bodyMat);
    body.position.set(0, 1.15, 0.95);
    body.castShadow = true;
    g.add(body);
    for (const sx of [-0.36, 0.36]) {
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.7, 10), bodyMat);
      arm.rotation.x = Math.PI / 2.6;
      arm.position.set(sx, 1.22, 0.55);
      arm.castShadow = true;
      g.add(arm);
    }
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 24, 18), std(0xf0d3b3, { roughness: 0.6 }));
    head.position.set(0, 1.88, 0.95);
    head.castShadow = true;
    g.add(head);
    // Đèn trạng thái.
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 10), new THREE.MeshBasicMaterial({ color: m.waiting ? 0xf5b84a : m.busy ? 0xb095ff : 0x52c98f }));
    led.position.set(0.95, 1.05, 0.3);
    g.add(led);

    // Đồng xu avatar nhỏ (luôn quay về phía camera) và nhãn tên ngắn.
    const coinCanvas = document.createElement("canvas");
    coinCanvas.width = coinCanvas.height = 256;
    const coinTex = new THREE.CanvasTexture(coinCanvas);
    coinTex.colorSpace = THREE.SRGBColorSpace;
    drawCoin(coinCanvas, m.color, svg, () => { coinTex.needsUpdate = true; });
    coinTex.needsUpdate = true;
    const coin = new THREE.Sprite(new THREE.SpriteMaterial({ map: coinTex, transparent: true }));
    coin.scale.set(0.62, 0.62, 1);
    coin.position.set(-0.5, 2.55, 0.95);
    g.add(coin);
    this.coins.set(m.id, coin);

    const labelCanvas = document.createElement("canvas");
    labelCanvas.width = 420;
    labelCanvas.height = 110;
    drawLabel(labelCanvas, m, false);
    const labelTex = new THREE.CanvasTexture(labelCanvas);
    labelTex.colorSpace = THREE.SRGBColorSpace;
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTex, transparent: true, depthTest: false }));
    label.scale.set(1.6, 0.42, 1);
    label.position.set(0.2, 2.55, 0.95);
    label.renderOrder = 10;
    g.add(label);
    this.labels.set(m.id, { canvas: labelCanvas, tex: labelTex, m, sprite: label });

    const ring = new THREE.Mesh(new THREE.RingGeometry(1.7, 1.86, 48), new THREE.MeshBasicMaterial({ color: 0xf5b84a, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, 0.05, 0.5);
    ring.visible = false;
    g.add(ring);
    this.rings.set(m.id, ring);

    const hit = new THREE.Mesh(new THREE.BoxGeometry(2.5, 3.0, 2.4), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.set(0, 1.5, 0.5);
    hit.userData.memberId = m.id;
    g.add(hit);
    this.hits.push(hit);
    return g;
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const t = performance.now() / 1000;
    for (const [id, coin] of this.coins) coin.position.y = 2.55 + Math.sin(t * 1.6 + id.length) * 0.04;
    if (this.selected) {
      const r = this.rings.get(this.selected);
      if (r) r.scale.setScalar(1 + Math.sin(t * 3) * 0.03);
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener("pointerdown", this.onDown);
    el.removeEventListener("pointerup", this.onUp);
    this.disposeGroup(this.group);
    this.disposeGroup(this.room);
    this.plank.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    el.remove();
  }
}

export function Office3D({ members, selectedId, onSelect, onUnsupported, handleRef }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const iconsRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const cb = useRef({ onSelect, onUnsupported });
  cb.current = { onSelect, onUnsupported };
  const selRef = useRef(selectedId);
  selRef.current = selectedId;

  const iconSvg = (avatar: string): string | null => {
    const svg = iconsRef.current?.querySelector(`[data-avatar="${avatar}"] svg`);
    if (!svg) return null;
    const clone = svg.cloneNode(true) as SVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", "128");
    clone.setAttribute("height", "128");
    return new XMLSerializer().serializeToString(clone).replace(/currentColor/g, "#0e1013");
  };

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    let scene: OfficeScene;
    try {
      scene = new OfficeScene(el, (id) => cb.current.onSelect(id), () => cb.current.onUnsupported("Trình duyệt đã dừng đồ họa 3D."));
    } catch {
      cb.current.onUnsupported("Trình duyệt hoặc thiết bị này không hỗ trợ WebGL.");
      return;
    }
    sceneRef.current = scene;
    handleRef.current = { reset: () => scene.reset(), zoom: (f) => scene.zoom(f) };
    (window as unknown as { __lumiOffice3D?: OfficeScene }).__lumiOffice3D = scene;
    return () => {
      scene.dispose();
      sceneRef.current = null;
      handleRef.current = null;
      delete (window as unknown as { __lumiOffice3D?: OfficeScene }).__lumiOffice3D;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Danh sách thành viên đổi (thêm/sửa/lưu trữ): dựng lại cảnh ngay, giữ thành viên đang chọn.
  const key = members.map((m) => `${m.id}|${m.name}|${m.role}|${m.avatar}|${m.archived}|${m.busy}|${m.waiting}`).join(";");
  useEffect(() => {
    sceneRef.current?.setMembers(members, iconSvg);
    sceneRef.current?.setSelected(selRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    sceneRef.current?.setSelected(selectedId);
  }, [selectedId]);

  return (
    <>
      <div ref={mountRef} style={{ position: "absolute", inset: 0 }} />
      <div ref={iconsRef} style={{ display: "none" }} aria-hidden>
        {members.map((m) => <Avatar key={`${m.id}-${m.avatar}`} avatar={m.avatar} size={64} />)}
      </div>
    </>
  );
}
