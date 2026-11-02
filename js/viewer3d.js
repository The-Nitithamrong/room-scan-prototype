/**
 * viewer3d.js — สร้างโมเดลห้อง 3D จากแปลน (Three.js, MIT license)
 *
 * โมเดลเป็นแบบ "ยืดผนังจากแปลน" (extrusion): พื้น + ผนังหนา 10 ซม. + ช่องประตู/หน้าต่าง
 * ไม่ใช่ mesh จากภาพถ่าย — ตั้งใจให้เบาและแก้ไขได้ตรงกับแปลน 2D เสมอ
 * โมเดลละเอียด (texture จริง) อยู่ในขั้น Expansion ของ brief
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { wallEnds, wallLength, wallDir, signedArea } from './plan-model.js';

const WALL_T = 0.1;

export function createViewer(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1020);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 200);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x334466, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(4, 8, 6);
  scene.add(sun);

  const room = new THREE.Group();
  scene.add(room);

  const mats = {
    floor: new THREE.MeshStandardMaterial({ color: 0xc9bfae, roughness: 0.9 }),
    wall: new THREE.MeshStandardMaterial({ color: 0xeef1fb, roughness: 0.85 }),
    door: new THREE.MeshStandardMaterial({ color: 0xa0653a, roughness: 0.7 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x8fd3ff, transparent: true, opacity: 0.35, roughness: 0.1 }),
  };

  let framed = false;

  function resize() {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  /** กล่องผนังหนึ่งชิ้นตามแนวผนัง: จาก s0 ถึง s1 (เมตรตามแนว) สูงจาก z0 ถึง z1 */
  function wallPiece(a, dir, nrm, s0, s1, z0, z1, mat) {
    const len = s1 - s0;
    if (len <= 1e-3 || z1 - z0 <= 1e-3) return null;
    const g = new THREE.BoxGeometry(len, z1 - z0, WALL_T);
    const m = new THREE.Mesh(g, mat);
    const cx = a[0] + dir[0] * (s0 + len / 2) + nrm[0] * (WALL_T / 2);
    const cy = a[1] + dir[1] * (s0 + len / 2) + nrm[1] * (WALL_T / 2);
    // แปลน (x, y) → Three.js (x, -z) ให้แกน y เป็นแกนตั้ง
    m.position.set(cx, (z0 + z1) / 2, -cy);
    m.rotation.y = Math.atan2(dir[1], dir[0]);
    return m;
  }

  function update(plan) {
    room.clear();
    const H = plan.height || 2.6;
    const shape = new THREE.Shape(plan.corners.map(([x, y]) => new THREE.Vector2(x, y)));
    const floor = new THREE.Mesh(new THREE.ShapeGeometry(shape), mats.floor);
    floor.rotation.x = -Math.PI / 2;
    room.add(floor);

    const sign = signedArea(plan) >= 0 ? 1 : -1;
    for (let i = 0; i < plan.corners.length; i++) {
      const [a] = wallEnds(plan, i);
      const L = wallLength(plan, i);
      const dir = wallDir(plan, i);
      const nrm = [dir[1] * sign, -dir[0] * sign]; // ชี้ออกนอกห้อง
      const ops = (plan.openings || []).filter((o) => o.wall === i).sort((p, q) => p.offset - q.offset);
      let s = 0;
      for (const o of ops) {
        const add = (m) => m && room.add(m);
        add(wallPiece(a, dir, nrm, s, o.offset, 0, H, mats.wall));
        add(wallPiece(a, dir, nrm, o.offset, o.offset + o.width, 0, o.sill || 0, mats.wall));
        add(wallPiece(a, dir, nrm, o.offset, o.offset + o.width, (o.sill || 0) + o.height, H, mats.wall));
        const pane = wallPiece(a, dir, nrm, o.offset, o.offset + o.width, o.sill || 0, (o.sill || 0) + o.height, o.type === 'door' ? mats.door : mats.glass);
        if (pane) {
          pane.scale.z = 0.3;
          room.add(pane);
        }
        s = o.offset + o.width;
      }
      const last = wallPiece(a, dir, nrm, s, L, 0, H, mats.wall);
      if (last) room.add(last);
    }

    // ตำแหน่งถ่ายภาพ (ถ้ามี)
    (plan.cameras || []).forEach(([x, y]) => {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 8), new THREE.MeshBasicMaterial({ color: 0x3ddc97 }));
      dot.position.set(x, 1.45, -y);
      room.add(dot);
    });

    if (!framed) {
      const box = new THREE.Box3().setFromObject(room);
      const c = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3()).length();
      controls.target.copy(c);
      camera.position.set(c.x + size * 0.55, size * 0.75, c.z + size * 0.75);
      framed = true;
    }
    resize();
  }

  function loop() {
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }

  window.addEventListener('resize', resize);
  resize();
  loop();

  return {
    update,
    exportGLB() {
      return new Promise((resolve, reject) => {
        new GLTFExporter().parse(
          room,
          (buf) => resolve(new Blob([buf], { type: 'model/gltf-binary' })),
          reject,
          { binary: true }
        );
      });
    },
  };
}
