// ทดสอบ quality.js และ sensors.cameraDirection ด้วยภาพสังเคราะห์
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Q from '../js/quality.js';
import { cameraDirection } from '../js/sensors.js';

const W = 160;
const H = 120;

/** ภาพลายสุ่ม (มี texture) แบบ seed ได้ */
function texturedGray(seed = 1, w = W, h = H) {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const g = new Float32Array(w * h);
  for (let k = 0; k < 40; k++) {
    const x0 = Math.floor(rnd() * w);
    const y0 = Math.floor(rnd() * h);
    const rw = 4 + Math.floor(rnd() * 25);
    const rh = 4 + Math.floor(rnd() * 25);
    const v = rnd() * 255;
    for (let y = y0; y < Math.min(h, y0 + rh); y++) for (let x = x0; x < Math.min(w, x0 + rw); x++) g[y * w + x] = v;
  }
  return g;
}

function boxBlur(g, w, h, r) {
  const o = new Float32Array(g.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && xx < w && yy >= 0 && yy < h) {
            s += g[yy * w + xx];
            n++;
          }
        }
      }
      o[y * w + x] = s / n;
    }
  }
  return o;
}

function toRGBA(g) {
  const out = new Uint8ClampedArray(g.length * 4);
  for (let i = 0; i < g.length; i++) {
    out[4 * i] = out[4 * i + 1] = out[4 * i + 2] = g[i];
    out[4 * i + 3] = 255;
  }
  return out;
}

function shift(g, w, h, dx, dy) {
  const o = new Float32Array(g.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = x - dx;
    const sy = y - dy;
    o[y * w + x] = sx >= 0 && sx < w && sy >= 0 && sy < h ? g[sy * w + sx] : 0;
  }
  return o;
}

test('ภาพเบลอมีค่า sharpness ต่ำกว่าภาพคมมาก', () => {
  const g = texturedGray(3);
  const sharp = Q.laplacianVariance(g, W, H);
  const blur = Q.laplacianVariance(boxBlur(g, W, H, 3), W, H);
  assert.ok(sharp > 5 * blur, `sharp=${sharp} blur=${blur}`);
});

test('ผนังเรียบถูกเตือนเรื่อง texture และภาพมืดถูกบล็อก', () => {
  const flat = new Float32Array(W * H).fill(200);
  const m = Q.analyzeFrame(toRGBA(flat), W, H);
  const a = Q.assess(m);
  assert.ok(a.issues.some((i) => i.code === 'texture'));
  const dark = new Float32Array(W * H).fill(20);
  const a2 = Q.assess(Q.analyzeFrame(toRGBA(dark), W, H));
  assert.equal(a2.level, 'fail');
  assert.ok(a2.issues.some((i) => i.code === 'dark'));
});

test('ภาพคมและสว่างพอ ผ่านเกณฑ์', () => {
  const g = texturedGray(5).map((v) => 60 + v * 0.6);
  const a = Q.assess(Q.analyzeFrame(toRGBA(g), W, H), { overlap: 0.7 });
  assert.equal(a.level, 'ok', JSON.stringify(a.issues));
});

test('estimateShift หาการเลื่อนภาพได้ใกล้เคียง และคำนวณ overlap', () => {
  const g = texturedGray(9);
  const moved = shift(g, W, H, 30, -8);
  const ga = Q.gradient(g, W, H).mag;
  const gb = Q.gradient(moved, W, H).mag;
  const r = Q.estimateShift(ga, gb, W, H);
  assert.ok(Math.abs(r.dx - 30) <= 1 && Math.abs(r.dy + 8) <= 1, JSON.stringify(r));
  assert.ok(Math.abs(r.overlap - (1 - 30 / W) * (1 - 8 / H)) < 0.02);
  assert.ok(r.score > 0.5);
});

test('assess: overlap น้อย/มากเกินไปได้คำเตือนที่ต่างกัน', () => {
  const g = texturedGray(5).map((v) => 60 + v * 0.6);
  const m = Q.analyzeFrame(toRGBA(g), W, H);
  assert.ok(Q.assess(m, { overlap: 0.3 }).issues.some((i) => i.code === 'overlap-low'));
  assert.ok(Q.assess(m, { overlap: 0.97 }).issues.some((i) => i.code === 'overlap-high'));
  assert.ok(Q.assess(m, { rotRate: 90 }).issues.some((i) => i.code === 'motion'));
});

test('cameraDirection: ถือตั้งตรงหันทิศเหนือ / ก้ม / เงย / หันตะวันออก', () => {
  let d = cameraDirection(0, 90, 0);
  assert.ok(Math.abs(d.pitch) < 1e-6 && (d.heading < 1e-6 || d.heading > 360 - 1e-6), JSON.stringify(d));
  d = cameraDirection(0, 60, 0);
  assert.ok(Math.abs(d.pitch + 30) < 1e-6, 'beta 60° = ก้ม 30°');
  d = cameraDirection(0, 110, 0);
  assert.ok(Math.abs(d.pitch - 20) < 1e-6, 'beta 110° = เงย 20°');
  // alpha หมุนทวนเข็ม (มองจากบน) 90° → กล้องหันไปทิศตะวันตก (heading 270)
  d = cameraDirection(90, 90, 0);
  assert.ok(Math.abs(d.heading - 270) < 1e-6, JSON.stringify(d));
});

test('RollingRef ใช้เปอร์เซ็นไทล์ที่ 80', () => {
  const r = new Q.RollingRef(10);
  assert.equal(r.value(), 0);
  for (let i = 1; i <= 10; i++) r.push(i);
  assert.equal(r.value(), 8);
});
