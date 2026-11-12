"use client";

// Cảnh Văn phòng 3D v2 (three.js): mỗi dự án một phòng, Phòng họp trải hai cột ở giữa (OFC-07, OFC-08).
// Nhãn và bong bóng là HTML phủ lên cảnh (chữ sắc nét, chọn được bằng bàn phím); dữ liệu đưa vào đã tính sẵn ở office-view.
// Chỉ được tải động khi người dùng chọn 3D.
import { useEffect, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { MEET_ID, type OfficePlan, type RoomPlan } from "@/lib/lumi/office-layout";
import type { MeetingBoard, OfficeStatus } from "@/lib/lumi/office-state";

export interface Office3DMember {
  id: string;
  name: string;
  role: string;
  color: string;
  human: boolean;
  status: OfficeStatus;
  label: string;
  bubble: string | null;
  review: number;
}
export interface Office3DMeeting {
  /** false = chế độ mô phỏng: họp chỉ có ở dữ liệu thật. */
  available: boolean;
  board: MeetingBoard | null;
  seatIds: string[];
}
export interface Office3DHandle {
  reset: () => void;
  zoom: (factor: number) => void;
}
interface Props {
  plan: OfficePlan;
  members: Office3DMember[];
  meeting: Office3DMeeting;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onUnsupported: (message: string) => void;
  handleRef: MutableRefObject<Office3DHandle | null>;
}

const STATUS_HEX: Record<OfficeStatus, number> = { working: 0xb095ff, review: 0xf5b84a, blocked: 0xf07474, idle: 0x52c98f, archived: 0x5a606b };
const initials = (name: string) => name.replace(/^Trợ lý\s+/i, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
const MAX_SEATS = 8;
const TABLE_Z = 0.5; // tâm bàn họp so với tâm phòng

interface Figure { grp: THREE.Group; head: THREE.Group; arms: [THREE.Group, THREE.Group]; mat: THREE.MeshStandardMaterial }
interface Desk { grp: THREE.Group; fig: Figure; screen: THREE.Mesh; glow: THREE.Mesh; ring: THREE.Mesh; stack: THREE.Group; ph: number; world: THREE.Vector3 }
interface Anchor { el: HTMLElement; x: number; y: number; z: number }

class OfficeScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private world = new THREE.Group();
  private overlay: HTMLDivElement;
  private raf = 0;
  private ro: ResizeObserver;
  private down: { x: number; y: number; t: number } | null = null;
  private disposed = false;
  private geo = new Map<string, THREE.BufferGeometry>();
  private hits: THREE.Object3D[] = [];
  private desks = new Map<string, Desk>();
  private seats: Figure[] = [];
  private anchors: Anchor[] = [];
  private roomCenter = new Map<string, THREE.Vector3>();
  private wallN = new THREE.MeshStandardMaterial({ color: 0x2a3246, roughness: 0.85, transparent: true });
  private wallW = new THREE.MeshStandardMaterial({ color: 0x2a3246, roughness: 0.85, transparent: true });
  private wN = 1;
  private wW = 1;
  private holo: THREE.Mesh | null = null;
  private board: { canvas: HTMLCanvasElement; tex: THREE.CanvasTexture } | null = null;
  private plan: OfficePlan | null = null;
  private members = new Map<string, Office3DMember>();
  private meeting: Office3DMeeting = { available: false, board: null, seatIds: [] };
  private selected: string | null = null;
  private fitDist = 30;
  private flight: { t0: number; fromT: THREE.Vector3; toT: THREE.Vector3; fromP: THREE.Vector3; toP: THREE.Vector3 } | null = null;
  private reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  private ph = 0.92;

  constructor(private container: HTMLDivElement, private onPick: (id: string) => void, private onAdd: () => void, private onLost: () => void) {
    const probe = document.createElement("canvas");
    if (!(probe.getContext("webgl2") ?? probe.getContext("webgl"))) throw new Error("webgl-unavailable");
    const w = container.clientWidth || 600;
    const h = container.clientHeight || 400;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.domElement.setAttribute("aria-label", "Cảnh văn phòng 3D. Dùng danh sách thành viên bên dưới để chọn bằng bàn phím.");
    this.renderer.domElement.setAttribute("data-testid", "canvas-3d");
    container.prepend(this.renderer.domElement);
    this.renderer.domElement.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.onLost();
    });
    this.overlay = document.createElement("div");
    this.overlay.className = "o3-overlay";
    container.appendChild(this.overlay);

    this.scene.background = new THREE.Color(0x0b0e15);
    this.scene.fog = new THREE.Fog(0x0b0e15, 55, 110);
    this.camera = new THREE.PerspectiveCamera(36, w / h, 0.1, 200);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 6;
    this.controls.minPolarAngle = 0.25;
    this.controls.maxPolarAngle = 1.38;

    this.scene.add(new THREE.HemisphereLight(0xb9c8ff, 0x2b2330, 1.5));
    const sun = new THREE.DirectionalLight(0xffe0b0, 2.6);
    sun.position.set(-10, 20, 14);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 26, bottom: -26, near: 1, far: 90 });
    this.scene.add(sun);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), new THREE.MeshStandardMaterial({ color: 0x0e121b, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.2;
    ground.receiveShadow = true;
    this.scene.add(ground);
    const grid = new THREE.GridHelper(80, 80, 0x1c2333, 0x151b28);
    grid.position.y = -0.19;
    this.scene.add(grid);
    this.scene.add(this.world);

    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", this.onDown);
    el.addEventListener("pointerup", this.onUp);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.loop();
  }

  // ───────── giao tiếp với React
  setPlan(plan: OfficePlan, members: Office3DMember[], meeting: Office3DMeeting) {
    this.plan = plan;
    this.members = new Map(members.map((m) => [m.id, m]));
    this.meeting = meeting;
    this.build();
    this.fit();
    this.reset();
  }
  setData(members: Office3DMember[], meeting: Office3DMeeting) {
    this.members = new Map(members.map((m) => [m.id, m]));
    this.meeting = meeting;
    this.applyMeeting();
    this.rebuildOverlay();
  }
  setSelected(id: string | null, fly: boolean) {
    this.selected = id;
    for (const [mid, d] of this.desks) d.ring.visible = mid === id;
    if (this.holo) (this.holo.material as THREE.MeshBasicMaterial).color.set(id === MEET_ID ? 0xffffff : 0xf5b84a);
    this.overlay.querySelectorAll<HTMLElement>("[data-id]").forEach((e) => e.classList.toggle("sel", e.dataset.id === id));
    if (fly && id) this.flyToId(id);
  }
  screenPositionOf(id: string): { x: number; y: number } | null {
    const d = this.desks.get(id);
    const p = d ? d.world.clone() : this.roomCenter.get(id)?.clone();
    if (!p) return null;
    p.project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height };
  }

  // ───────── camera
  private fit() {
    const plan = this.plan;
    if (!plan) return;
    const pts: THREE.Vector3[] = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [0, 3.6]) pts.push(new THREE.Vector3((sx * plan.width) / 2, y, (sz * plan.depth) / 2));
    const cam = this.camera.clone();
    cam.aspect = Math.max(0.45, this.camera.aspect || 1.6);
    cam.updateProjectionMatrix();
    const dir = new THREE.Vector3(0, Math.sin(this.ph), Math.cos(this.ph));
    const tg = new THREE.Vector3(0, 0.5, 0);
    let dist = 8;
    for (; dist < 140; dist += 0.4) {
      cam.position.copy(tg).addScaledVector(dir, dist);
      cam.lookAt(tg);
      cam.updateMatrixWorld(true);
      let worst = 0;
      for (const p of pts) {
        const q = p.clone().project(cam);
        worst = Math.max(worst, Math.abs(q.x), Math.abs(q.y));
      }
      if (worst < 0.9) break;
    }
    this.fitDist = dist;
    this.controls.maxDistance = dist * 1.8;
  }
  reset() {
    this.flight = null;
    const tg = new THREE.Vector3(0, 0.5, 0);
    this.controls.target.copy(tg);
    this.camera.position.copy(tg).add(new THREE.Vector3(0, Math.sin(this.ph), Math.cos(this.ph)).multiplyScalar(this.fitDist));
    this.controls.update();
  }
  zoom(f: number) {
    const v = this.camera.position.clone().sub(this.controls.target).multiplyScalar(f);
    v.setLength(Math.min(this.controls.maxDistance, Math.max(this.controls.minDistance, v.length())));
    this.camera.position.copy(this.controls.target).add(v);
    this.controls.update();
  }
  private flyToId(id: string) {
    const roomId = id === MEET_ID ? MEET_ID : (this.desks.get(id)?.grp.userData.room as string | undefined);
    const c = roomId ? this.roomCenter.get(roomId) : undefined;
    if (!c) return;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const dist = Math.max(11, this.fitDist * (id === MEET_ID ? 0.62 : 0.5));
    const toT = new THREE.Vector3(c.x, 0.5, c.z);
    const toP = toT.clone().addScaledVector(dir, dist);
    if (this.reduce) {
      this.controls.target.copy(toT);
      this.camera.position.copy(toP);
      this.controls.update();
      return;
    }
    this.flight = { t0: performance.now(), fromT: this.controls.target.clone(), toT, fromP: this.camera.position.clone(), toP };
  }

  // ───────── dựng cảnh
  private rb(parent: THREE.Object3D, w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, b = 0.035) {
    const key = [w, h, d, b].join();
    let g = this.geo.get(key);
    if (!g) {
      const a = Math.max(0.001, w - 2 * b);
      const c = Math.max(0.001, h - 2 * b);
      const s = new THREE.Shape();
      s.moveTo(-a / 2, -c / 2);
      s.lineTo(a / 2, -c / 2);
      s.lineTo(a / 2, c / 2);
      s.lineTo(-a / 2, c / 2);
      s.closePath();
      g = new THREE.ExtrudeGeometry(s, { depth: Math.max(0.001, d - 2 * b), bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 2, curveSegments: 2 });
      g.translate(0, 0, -(d - 2 * b) / 2);
      this.geo.set(key, g);
    }
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true;
    parent.add(m);
    return m;
  }
  private std(color: number | THREE.Color, extra: THREE.MeshStandardMaterialParameters = {}) {
    return new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.02, ...extra });
  }
  private figure(parent: THREE.Object3D, hex: string, human: boolean): Figure {
    const grp = new THREE.Group();
    parent.add(grp);
    const mat = this.std(new THREE.Color(hex), { roughness: 0.55 });
    const skin = this.std(0xf0cfae, { roughness: 0.6 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.5, 6, 16), mat);
    body.position.y = 1.25;
    body.castShadow = true;
    grp.add(body);
    const head = new THREE.Group();
    head.position.y = 1.95;
    grp.add(head);
    const hs = new THREE.Mesh(new THREE.SphereGeometry(0.28, 24, 18), skin);
    hs.castShadow = true;
    head.add(hs);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.295, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), this.std(human ? 0x3a2a20 : 0x23262f));
    hair.position.y = 0.02;
    hair.rotation.x = -0.25;
    head.add(hair);
    const eye = new THREE.MeshBasicMaterial({ color: 0x14171f });
    for (const x of [-0.1, 0.1]) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 8), eye);
      e.position.set(x, 0.03, 0.255);
      head.add(e);
    }
    const mk = (s: number) => {
      const p = new THREE.Group();
      p.position.set(s * 0.36, 1.5, 0);
      grp.add(p);
      const a = new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.5, 4, 8), mat);
      a.position.y = -0.28;
      a.castShadow = true;
      p.add(a);
      p.rotation.x = -0.9;
      return p;
    };
    return { grp, head, arms: [mk(-1), mk(1)], mat };
  }

  private disposeWorld() {
    this.world.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) {
        (x as THREE.MeshBasicMaterial).map?.dispose?.();
        x.dispose();
      }
    });
    this.world.clear();
    this.geo.clear();
    this.hits = [];
    this.desks.clear();
    this.seats = [];
    this.roomCenter.clear();
    this.holo = null;
    this.board = null;
  }

  private build() {
    this.disposeWorld();
    const plan = this.plan!;
    for (const r of plan.rooms) {
      const g = new THREE.Group();
      g.position.set(r.x, 0, r.z);
      this.world.add(g);
      this.roomCenter.set(r.id, new THREE.Vector3(r.x, 0, r.z));
      const meet = r.kind === "meet";
      const rc = new THREE.Color(r.accent);
      const base = new THREE.Color(0x2b3245);
      this.rb(g, r.w, 0.2, r.d, this.std(base.clone().lerp(rc, meet ? 0.07 : 0.16), { roughness: 0.9 }), 0, -0.1, 0, 0.05);
      this.rb(g, r.w - 0.5, 0.02, r.d - 0.5, this.std(base.clone().lerp(rc, meet ? 0.12 : 0.3), { roughness: 1 }), 0, 0.01, 0.1, 0.005);
      this.rb(g, r.w + 0.2, 1.9, 0.2, this.wallN, 0, 0.95, -r.d / 2 - 0.05);
      this.rb(g, 0.2, 1.9, r.d + 0.2, this.wallW, -r.w / 2 - 0.05, 0.95, 0);
      const trim = this.std(rc, { emissive: rc, emissiveIntensity: 0.5, roughness: 0.5 });
      this.rb(g, r.w + 0.24, 0.07, 0.26, trim, 0, 1.93, -r.d / 2 - 0.05, 0.01);
      this.rb(g, 0.26, 0.07, r.d + 0.24, trim, -r.w / 2 - 0.05, 1.93, 0, 0.01);
      const win = this.std(0x8fb4ff, { emissive: 0x5f8fe8, emissiveIntensity: 0.6, roughness: 0.3 });
      for (const x of meet ? [-6, 6] : [-1.8, 1.8]) this.rb(g, 1.8, 0.9, 0.04, win, x, 1.15, -r.d / 2 + 0.07, 0.01);
      this.rb(g, 1.5, 1.2, 0.4, this.std(0x6e5638), r.w / 2 - 1, 0.6, -r.d / 2 + 0.3);
      ["#d96b5a", "#5a8fd9", "#e0b44a", "#6fbf8a"].forEach((c, i) => this.rb(g, 0.28, 0.22, 0.3, this.std(new THREE.Color(c)), r.w / 2 - 1.45 + i * 0.31, 0.55 + (i % 2) * 0.32, -r.d / 2 + 0.35, 0.01));
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.2, 0.42, 16), this.std(0x4a3a2c));
      pot.position.set(-r.w / 2 + 0.55, 0.21, -r.d / 2 + 0.55);
      pot.castShadow = true;
      const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 1), this.std(0x2f8a5c));
      leaf.position.set(-r.w / 2 + 0.55, 0.85, -r.d / 2 + 0.55);
      leaf.castShadow = true;
      g.add(pot, leaf);
      for (const x of meet ? [-4, 0, 4] : [0]) {
        const pl = new THREE.PointLight(0xffd9a0, 9, 12, 1.6);
        pl.position.set(x, 3.6, 0);
        g.add(pl);
      }
      if (meet) this.buildMeeting(g, r);
      else this.buildDesks(g, r);
    }
    this.applyMeeting();
    this.rebuildOverlay();
    this.setSelected(this.selected, false);
  }

  private buildDesks(g: THREE.Group, r: RoomPlan) {
    if (r.desks.length === 0) {
      // phòng trống: một bàn chưa có người
      this.rb(g, 2.3, 0.12, 1.1, this.std(0x3a4155), 0, 0.95, -0.3);
      for (const [x, z] of [[-1.05, -0.4], [1.05, -0.4], [-1.05, 0.4], [1.05, 0.4]] as const) this.rb(g, 0.09, 0.95, 0.09, this.std(0x20242e), x, 0.475, -0.3 + z, 0.01);
      return;
    }
    for (const spot of r.desks) {
      const m = this.members.get(spot.memberId);
      const hex = m?.color ?? "#59627a";
      const col = new THREE.Color(hex);
      const dg = new THREE.Group();
      dg.position.set(spot.x, 0, spot.z);
      dg.userData.room = r.id;
      g.add(dg);
      this.rb(dg, 2.3, 0.12, 1.1, this.std(m?.status === "archived" ? 0x4a4f5a : 0xa07a4d), 0, 0.95, 0);
      for (const [x, z] of [[-1.05, -0.4], [1.05, -0.4], [-1.05, 0.4], [1.05, 0.4]] as const) this.rb(dg, 0.09, 0.95, 0.09, this.std(0x20242e), x, 0.475, z, 0.01);
      const screen = this.rb(dg, 0.95, 0.6, 0.06, this.std(0x07090d, { emissive: col, emissiveIntensity: 0.3 }), 0, 1.55, 0.1, 0.02);
      this.rb(dg, 0.1, 0.3, 0.1, this.std(0x1c1f27), 0, 1.2, 0.1, 0.01);
      this.rb(dg, 0.55, 0.03, 0.2, this.std(0x171a22), 0, 1.03, -0.25, 0.01);
      const stack = new THREE.Group();
      stack.position.set(0.85, 1.01, -0.25);
      dg.add(stack);
      for (let i = 0; i < 4; i++) {
        const p = this.rb(stack, 0.46, 0.035, 0.34, this.std(0xf2f4fa, { roughness: 0.9 }), 0, i * 0.04, 0, 0.005);
        p.rotation.y = i % 2 ? 0.12 : -0.1;
        p.visible = false;
      }
      this.rb(dg, 0.9, 0.1, 0.9, this.std(0x20242e), 0, 0.62, -0.95);
      this.rb(dg, 0.9, 0.9, 0.1, this.std(0x20242e), 0, 1.1, -1.4);
      const fig = this.figure(dg, hex, m?.human ?? false);
      fig.grp.position.set(0, 0, -0.95);
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.75, 1.9, 56), new THREE.MeshBasicMaterial({ color: 0xf5b84a, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(0, 0.03, -0.4);
      ring.visible = false;
      dg.add(ring);
      const glow = new THREE.Mesh(new THREE.CircleGeometry(1.7, 40), new THREE.MeshBasicMaterial({ color: 0xf5b84a, transparent: true, opacity: 0, depthWrite: false }));
      glow.rotation.x = -Math.PI / 2;
      glow.position.set(0, 0.025, -0.4);
      dg.add(glow);
      const hit = new THREE.Mesh(new THREE.BoxGeometry(2.6, 3.2, 2.8), new THREE.MeshBasicMaterial({ visible: false }));
      hit.position.set(0, 1.6, -0.3);
      hit.userData.pick = spot.memberId;
      dg.add(hit);
      this.hits.push(hit);
      this.desks.set(spot.memberId, { grp: dg, fig, screen, glow, ring, stack, ph: Math.random() * 6, world: new THREE.Vector3(r.x + spot.x, 1.3, r.z + spot.z - 0.8) });
    }
  }

  private buildMeeting(g: THREE.Group, r: RoomPlan) {
    // bảng họp trên vách sau: ba cột, vẽ lại khi dữ liệu họp đổi
    const canvas = document.createElement("canvas");
    canvas.width = 1152;
    canvas.height = 240;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.board = { canvas, tex };
    const bm = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 1.5), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    bm.position.set(0, 1.1, -r.d / 2 + 0.08);
    g.add(bm);
    this.rb(g, 7.4, 1.7, 0.05, this.std(0x0d1017), 0, 1.1, -r.d / 2 + 0.05, 0.01);
    const table = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.12, 48), this.std(0xc9a46e));
    table.scale.set(3, 1, 1.45);
    table.position.set(0, 0.85, TABLE_Z);
    table.castShadow = table.receiveShadow = true;
    g.add(table);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 0.8, 20), this.std(0x20242e));
    leg.position.set(0, 0.42, TABLE_Z);
    leg.castShadow = true;
    g.add(leg);
    const holo = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.025, 8, 48), new THREE.MeshBasicMaterial({ color: 0xf5b84a, transparent: true, opacity: 0.35 }));
    holo.rotation.x = Math.PI / 2;
    holo.position.set(0, 1.02, TABLE_Z);
    g.add(holo);
    this.holo = holo;
    const chairMat = this.std(0x20242e);
    for (let k = 0; k < MAX_SEATS; k++) {
      const a = (k * Math.PI) / 4;
      const px = Math.cos(a) * 3.55;
      const pz = TABLE_Z + Math.sin(a) * 2.0;
      const yaw = Math.atan2(-px, -(pz - TABLE_Z));
      const ch = new THREE.Group();
      ch.position.set(px, 0, pz);
      ch.rotation.y = yaw;
      g.add(ch);
      this.rb(ch, 0.8, 0.1, 0.8, chairMat, 0, 0.62, 0);
      this.rb(ch, 0.8, 0.8, 0.1, chairMat, 0, 1.05, -0.42);
      const f = this.figure(g, "#8e9ab1", false);
      f.grp.position.set(px, 0, pz);
      f.grp.rotation.y = yaw;
      f.arms.forEach((arm) => (arm.rotation.x = -0.6));
      f.grp.visible = false;
      this.seats.push(f);
    }
    const hit = new THREE.Mesh(new THREE.BoxGeometry(8.5, 3, 4.8), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.set(0, 1.5, TABLE_Z);
    hit.userData.pick = MEET_ID;
    g.add(hit);
    this.hits.push(hit);
  }

  /** Người đang họp ngồi vào bàn họp (bàn riêng để trống); bảng trên tường vẽ lại. */
  private applyMeeting() {
    const seatIds = this.meeting.seatIds.filter((id) => this.members.has(id)).slice(0, MAX_SEATS);
    this.seats.forEach((f, i) => {
      const m = seatIds[i] ? this.members.get(seatIds[i]!) : undefined;
      f.grp.visible = !!m;
      if (m) f.mat.color.set(m.color);
    });
    for (const [id, d] of this.desks) d.fig.grp.visible = !seatIds.includes(id);
    this.drawBoard();
  }
  private drawBoard() {
    if (!this.board) return;
    const { canvas, tex } = this.board;
    const x = canvas.getContext("2d")!;
    x.fillStyle = "#10151f";
    x.fillRect(0, 0, 1152, 240);
    x.fillStyle = "#8e9ab1";
    x.font = "700 20px system-ui, 'Segoe UI', sans-serif";
    x.fillText("BẢNG HỌP", 24, 34);
    const hex = ["#b095ff", "#f5b84a", "#8e9ab1"];
    if (!this.meeting.available) {
      x.fillStyle = "#a2abba";
      x.font = "400 22px system-ui, 'Segoe UI', sans-serif";
      x.fillText("Họp chỉ có ở dữ liệu thật (đăng nhập).", 24, 120);
    } else {
      (this.meeting.board?.columns ?? []).forEach((c, i) => {
        const X = 24 + i * 372;
        x.fillStyle = "#1b2230";
        x.fillRect(X, 50, 348, 172);
        x.fillStyle = hex[i] ?? "#8e9ab1";
        x.fillRect(X, 50, 348, 5);
        x.font = "700 22px system-ui, 'Segoe UI', sans-serif";
        x.fillText(`${c.title}  ${c.count}`, X + 14, 86);
        x.fillStyle = "#e9edf5";
        x.font = "400 17px system-ui, 'Segoe UI', sans-serif";
        c.lines.forEach((t, j) => x.fillText(t, X + 14, 118 + j * 34));
        if (c.lines.length === 0) {
          x.fillStyle = "#a2abba";
          x.fillText("Chưa có", X + 14, 118);
        }
      });
    }
    tex.needsUpdate = true;
  }

  // ───────── nhãn HTML (textContent, không innerHTML: tên trợ lý do người dùng nhập)
  private mk<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) {
    const e = document.createElement(tag);
    e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  private idBlock(name: string, role: string) {
    const s = this.mk("span", "o3-id");
    s.append(this.mk("b", "", name), this.mk("i", "", role));
    return s;
  }
  private rebuildOverlay() {
    this.overlay.replaceChildren();
    this.anchors = [];
    const plan = this.plan;
    if (!plan) return;
    const put = (el: HTMLElement, x: number, y: number, z: number) => {
      this.overlay.appendChild(el);
      this.anchors.push({ el, x, y, z });
    };
    const seated = new Set(this.meeting.seatIds);
    for (const r of plan.rooms) {
      const rl = this.mk("div", "o3-room");
      rl.append(this.mk("b", "", r.name.toUpperCase()), this.mk("span", "", r.sub));
      put(rl, r.x, 0.02, r.z + r.d / 2 - 0.25);
      if (r.kind === "meet") {
        const open = this.meeting.board?.open.length ?? 0;
        const t = this.mk("button", `o3-tag${this.selected === MEET_ID ? " sel" : ""}`);
        t.type = "button";
        t.dataset.id = MEET_ID;
        t.setAttribute("aria-label", "Phòng họp");
        if (this.meeting.available && open > 0) t.appendChild(this.mk("div", "o3-bub", open === 1 ? this.meeting.board!.open[0]!.title : `${open} cuộc họp đang mở`));
        const card = this.mk("div", "o3-card");
        card.append(this.mk("span", "o3-coin", "PH"), this.idBlock("Phòng họp", this.meeting.available ? "Họp bất đồng bộ" : "Cần dữ liệu thật"), this.mk("span", `o3-st ${open > 0 ? "st-working" : "st-idle"}`, !this.meeting.available ? "Mô phỏng" : open > 0 ? "Đang họp" : "Trống"));
        t.appendChild(card);
        t.onclick = () => this.onPick(MEET_ID);
        put(t, r.x, 2.3, r.z + TABLE_Z);
        continue;
      }
      if (r.desks.length === 0) {
        const b = this.mk("button", "o3-add", "+ Thêm trợ lý");
        b.type = "button";
        b.onclick = () => this.onAdd();
        put(b, r.x, 1.7, r.z - 0.3);
        continue;
      }
      for (const spot of r.desks) {
        const m = this.members.get(spot.memberId);
        if (!m) continue;
        const inMeet = seated.has(m.id);
        const t = this.mk("button", `o3-tag${this.selected === m.id ? " sel" : ""}`);
        t.type = "button";
        t.dataset.id = m.id;
        t.setAttribute("aria-label", `${m.name}, ${inMeet ? "đang họp" : m.label}`);
        if (m.bubble && !inMeet) t.appendChild(this.mk("div", "o3-bub", m.bubble));
        const card = this.mk("div", "o3-card");
        const coin = this.mk("span", "o3-coin", initials(m.name));
        coin.style.background = m.color;
        card.append(coin, this.idBlock(m.name, m.role.split(" · ")[0] ?? m.role), this.mk("span", `o3-st st-${inMeet ? "working" : m.status}`, inMeet ? "Đang họp" : m.human ? (m.review > 0 ? "Chờ duyệt" : "Online") : m.label));
        t.appendChild(card);
        t.onclick = () => this.onPick(m.id);
        put(t, r.x + spot.x, 2.55, r.z + spot.z - 0.95);
      }
    }
  }

  // ───────── tương tác
  private onDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY, t: performance.now() };
  };
  private onUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    if (!d) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || performance.now() - d.t > 700) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), this.camera);
    const hit = ray.intersectObjects(this.hits, false)[0];
    const id = hit?.object.userData.pick as string | undefined;
    if (id) this.onPick(id);
  };
  private resize() {
    if (this.disposed) return;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const prev = this.fitDist;
    this.fit();
    if (Math.abs(prev - this.fitDist) > 0.5 && !this.flight) this.reset();
  }

  // ───────── vòng lặp
  private v3 = new THREE.Vector3();
  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (document.visibilityState === "hidden") return;
    const now = performance.now();
    const t = now / 1000;
    if (this.flight) {
      const f = this.flight;
      const k = Math.min(1, (now - f.t0) / 650);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.controls.target.lerpVectors(f.fromT, f.toT, e);
      this.camera.position.lerpVectors(f.fromP, f.toP, e);
      if (k >= 1) this.flight = null;
    }
    this.controls.update();
    // tường mờ khi nhìn từ phía sau để luôn thấy bên trong phòng
    const cp = this.camera.position;
    this.wN += ((cp.z < -(this.plan?.depth ?? 0) / 2 ? 0.12 : 1) - this.wN) * 0.12;
    this.wW += ((cp.x < -(this.plan?.width ?? 0) / 2 ? 0.12 : 1) - this.wW) * 0.12;
    this.wallN.opacity = this.wN;
    this.wallN.transparent = this.wN < 0.99;
    this.wallW.opacity = this.wW;
    this.wallW.transparent = this.wW < 0.99;
    if (!this.reduce) this.animate(t);
    const meetOpen = (this.meeting.board?.open.length ?? 0) > 0;
    if (this.holo) {
      const mat = this.holo.material as THREE.MeshBasicMaterial;
      mat.opacity = meetOpen ? 0.9 : 0.3;
      this.holo.scale.setScalar(meetOpen && !this.reduce ? 1 + Math.sin(t * 4) * 0.12 : 1);
      this.holo.rotation.z = this.reduce ? 0 : t * 0.6;
    }
    this.renderer.render(this.scene, this.camera);
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    for (const a of this.anchors) {
      this.v3.set(a.x, a.y, a.z).project(this.camera);
      const behind = this.v3.z > 1;
      a.el.style.display = behind ? "none" : "";
      if (behind) continue;
      a.el.style.left = `${((this.v3.x + 1) / 2) * w}px`;
      a.el.style.top = `${((1 - this.v3.y) / 2) * h}px`;
      a.el.style.zIndex = String(Math.round(1000 - this.v3.z * 500));
    }
  };
  private animate(t: number) {
    for (const [id, d] of this.desks) {
      const m = this.members.get(id);
      const st: OfficeStatus = m?.status ?? "idle";
      const scr = d.screen.material as THREE.MeshStandardMaterial;
      const glow = d.glow.material as THREE.MeshBasicMaterial;
      scr.emissive.setHex(STATUS_HEX[st]);
      const { head, arms } = d.fig;
      d.stack.children.forEach((p, i) => (p.visible = i < Math.min(m?.review ?? 0, 4)));
      if (st === "working") {
        arms[0].rotation.x = -1.0 + Math.sin(t * 13 + d.ph) * 0.12;
        arms[1].rotation.x = -1.0 + Math.sin(t * 13 + d.ph + 2) * 0.12;
        head.position.y = 1.95 + Math.sin(t * 5 + d.ph) * 0.015;
        head.rotation.y = Math.sin(t * 1.2 + d.ph) * 0.12;
        scr.emissiveIntensity = 0.9 + Math.sin(t * 7 + d.ph) * 0.25;
        glow.opacity = 0;
      } else if (st === "review") {
        arms[1].rotation.x = -Math.PI + 0.4 + Math.sin(t * 4) * 0.3;
        arms[0].rotation.x = -0.5;
        head.position.y = 1.95;
        head.rotation.y = Math.sin(t * 1.5) * 0.2;
        scr.emissiveIntensity = 0.3;
        glow.color.setHex(0xf5b84a);
        glow.opacity = 0.14 + Math.sin(t * 3) * 0.08;
      } else if (st === "blocked") {
        arms[0].rotation.x = arms[1].rotation.x = -0.3;
        head.position.y = 1.95;
        head.rotation.y = Math.sin(t * 0.9 + d.ph) * 0.3;
        scr.emissiveIntensity = 0.25;
        glow.color.setHex(0xf07474);
        glow.opacity = 0.08;
      } else {
        arms[0].rotation.x = arms[1].rotation.x = -0.3;
        head.position.y = 1.95 + (st === "archived" ? 0 : Math.sin(t * 1.8 + d.ph) * 0.012);
        head.rotation.y = st === "archived" ? 0 : Math.sin(t * 0.7 + d.ph) * 0.35;
        scr.emissiveIntensity = 0.2;
        glow.opacity = 0;
      }
    }
    this.seats.forEach((f, i) => {
      if (!f.grp.visible) return;
      f.head.position.y = 1.95 + Math.sin(t * 6 + i) * 0.02;
      f.head.rotation.y = Math.sin(t * 1.3 + i) * 0.25;
      f.arms[1].rotation.x = -0.6 + Math.sin(t * 3 + i) * 0.35;
    });
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener("pointerdown", this.onDown);
    el.removeEventListener("pointerup", this.onUp);
    this.disposeWorld();
    this.wallN.dispose();
    this.wallW.dispose();
    this.controls.dispose();
    this.renderer.dispose();
    this.overlay.remove();
    el.remove();
  }
}

export function Office3D({ plan, members, meeting, selectedId, onSelect, onAdd, onUnsupported, handleRef }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const cb = useRef({ onSelect, onAdd, onUnsupported });
  cb.current = { onSelect, onAdd, onUnsupported };
  const live = useRef({ plan, members, meeting, selectedId });
  live.current = { plan, members, meeting, selectedId };

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    let scene: OfficeScene;
    try {
      scene = new OfficeScene(el, (id) => cb.current.onSelect(id), () => cb.current.onAdd(), () => cb.current.onUnsupported("Trình duyệt đã dừng đồ họa 3D."));
    } catch {
      cb.current.onUnsupported("Trình duyệt hoặc thiết bị này không hỗ trợ WebGL.");
      return;
    }
    sceneRef.current = scene;
    handleRef.current = { reset: () => scene.reset(), zoom: (f) => scene.zoom(f) };
    (window as unknown as { __lumiOffice3D?: OfficeScene }).__lumiOffice3D = scene;
    scene.setSelected(live.current.selectedId, false);
    scene.setPlan(live.current.plan, live.current.members, live.current.meeting);
    scene.setSelected(live.current.selectedId, false);
    return () => {
      scene.dispose();
      sceneRef.current = null;
      handleRef.current = null;
      delete (window as unknown as { __lumiOffice3D?: OfficeScene }).__lumiOffice3D;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cấu trúc đổi (phòng, bàn, màu): dựng lại cảnh. Trạng thái, bong bóng, họp đổi: chỉ cập nhật.
  const structure = plan.rooms.map((r) => `${r.id}:${r.d}:${r.desks.map((d) => `${d.memberId}@${d.x},${d.z}`).join("|")}`).join(";") + "#" + members.map((m) => `${m.id}${m.color}${m.human ? "h" : "b"}`).join(",");
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    sceneRef.current?.setPlan(live.current.plan, live.current.members, live.current.meeting);
    sceneRef.current?.setSelected(live.current.selectedId, false);
  }, [structure]);
  const dyn = members.map((m) => `${m.id}|${m.name}|${m.role}|${m.status}|${m.label}|${m.bubble ?? ""}|${m.review}`).join(";") + "#" + meeting.available + ":" + JSON.stringify(meeting.board?.columns ?? []) + ":" + meeting.seatIds.join(",");
  useEffect(() => {
    sceneRef.current?.setData(live.current.members, live.current.meeting);
    sceneRef.current?.setSelected(live.current.selectedId, false);
  }, [dyn]);
  const lastSel = useRef<string | null>(null);
  useEffect(() => {
    sceneRef.current?.setSelected(selectedId, selectedId !== null && selectedId !== lastSel.current);
    lastSel.current = selectedId;
  }, [selectedId]);

  return <div ref={mountRef} style={{ position: "absolute", inset: 0 }} />;
}
