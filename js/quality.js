/**
 * quality.js — ตรวจคุณภาพเฟรมกล้องแบบเรียลไทม์ (ฟังก์ชันล้วน ไม่แตะ DOM — ทดสอบด้วย node ได้)
 *
 * ทุกค่าคำนวณบนภาพย่อ (เช่น 160×120) เพื่อให้ทำได้หลายครั้งต่อวินาทีบนมือถือรุ่นล่าง
 *
 *   sharpness  ความแปรปรวนของ Laplacian (Pech-Pacheco et al., 2000) — ต่ำ = เบลอ
 *   luma       ความสว่างเฉลี่ย + สัดส่วนพิกเซลมืดจัด/สว่างจัด
 *   texture    พลังงาน gradient เฉลี่ย — ต่ำ = ผนังเรียบ SfM หา feature ไม่ได้
 *   overlap    ประมาณการซ้อนทับกับภาพก่อนหน้า จากการเลื่อนภาพ (NCC บน gradient)
 *
 * ค่าเกณฑ์ใน THRESHOLDS เป็นค่าเริ่มต้นสำหรับต้นแบบเท่านั้น
 * ต้องปรับจากข้อมูล Pilot หลายรุ่นมือถือ (docs/03-test-plan.md)
 */

export const THRESHOLDS = {
  lumaDark: 55, // ค่าเฉลี่ย 0–255 ต่ำกว่านี้ = มืด
  lumaBright: 215,
  clipFrac: 0.25, // พิกเซลมืดจัด/สว่างจัดเกินสัดส่วนนี้ = แสงไม่ดี
  sharpAbsMin: 12, // ใต้ค่านี้เบลอแน่นอน (บนภาพย่อ 160 px)
  sharpRel: 0.45, // ต่ำกว่า 45% ของค่าดีล่าสุด = สั่น/โฟกัสหลุด
  textureMin: 4.0, // gradient เฉลี่ย ต่ำกว่านี้ = เรียบเกินไป
  overlapMin: 0.55, // ซ้อนทับน้อยกว่านี้ = ห่างจากภาพก่อนเกินไป
  overlapMax: 0.92, // มากกว่านี้ = แทบไม่ขยับ ภาพซ้ำ
  rotRateMax: 35, // องศา/วินาที — มือสั่น/หมุนเร็ว
};

/** RGBA → gray (Float32Array) ด้วยน้ำหนัก Rec.601 */
export function toGray(rgba, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    g[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  }
  return g;
}

/** variance ของ Laplacian 4-neighbour */
export function laplacianVariance(g, w, h) {
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = g[i - w] + g[i + w] + g[i - 1] + g[i + 1] - 4 * g[i];
      sum += v;
      sum2 += v * v;
      n++;
    }
  }
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

export function lumaStats(g) {
  let s = 0;
  let dark = 0;
  let bright = 0;
  for (let i = 0; i < g.length; i++) {
    s += g[i];
    if (g[i] < 16) dark++;
    else if (g[i] > 245) bright++;
  }
  return { mean: s / g.length, darkFrac: dark / g.length, brightFrac: bright / g.length };
}

/** ภาพขนาดของ gradient (|gx|+|gy|) และค่าเฉลี่ย */
export function gradient(g, w, h) {
  const m = new Float32Array(w * h);
  let s = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = Math.abs(g[i + 1] - g[i - 1]) + Math.abs(g[i + w] - g[i - w]);
      m[i] = v;
      s += v;
    }
  }
  return { mag: m, mean: s / ((w - 2) * (h - 2)) };
}

/** ย่อภาพ gray ลงครึ่งหนึ่ง (box filter) */
export function halve(g, w, h) {
  const W = w >> 1;
  const H = h >> 1;
  const o = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = 2 * y * w + 2 * x;
      o[y * W + x] = (g[i] + g[i + 1] + g[i + w] + g[i + w + 1]) / 4;
    }
  }
  return { g: o, w: W, h: H };
}

function nccAt(a, b, w, h, dx, dy, step) {
  // เทียบ a(x,y) กับ b(x+dx, y+dy) ในส่วนที่ซ้อนกัน
  const x0 = Math.max(0, -dx);
  const x1 = Math.min(w, w - dx);
  const y0 = Math.max(0, -dy);
  const y1 = Math.min(h, h - dy);
  if (x1 - x0 < w * 0.2 || y1 - y0 < h * 0.2) return -1;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  let n = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const va = a[y * w + x];
      const vb = b[(y + dy) * w + x + dx];
      sa += va;
      sb += vb;
      saa += va * va;
      sbb += vb * vb;
      sab += va * vb;
      n++;
    }
  }
  const cov = sab / n - (sa / n) * (sb / n);
  const den = Math.sqrt(Math.max(1e-9, (saa / n - (sa / n) ** 2) * (sbb / n - (sb / n) ** 2)));
  return cov / den;
}

/**
 * ประมาณการเลื่อนระหว่างภาพก่อนหน้า (prev) กับเฟรมปัจจุบัน (cur) — ทั้งคู่เป็น gradient magnitude
 * ค้นหาแบบหยาบ→ละเอียด: ครึ่งความละเอียดค้นทั่ว แล้วเกลาที่ความละเอียดเต็ม ±2 px
 * คืน { dx, dy, score, overlap } — overlap คือสัดส่วนพื้นที่ที่ซ้อนกัน (0–1)
 *
 * ข้อจำกัด: แบบจำลองเป็นการเลื่อนภาพ 2D ซึ่งใกล้เคียงเมื่อหมุนกล้องเล็กน้อย
 * เมื่อเดินเข้าใกล้/ถอยห่างผนังมาก ค่าจะคลาดเคลื่อน — ใช้เป็นตัวชี้นำ ไม่ใช่ค่าวัด
 */
export function estimateShift(prev, cur, w, h, maxFrac = 0.75) {
  const A = halve(prev, w, h);
  const B = halve(cur, w, h);
  const mx = Math.floor(A.w * maxFrac);
  const my = Math.floor(A.h * maxFrac);
  let best = { dx: 0, dy: 0, score: -2 };
  for (let dy = -my; dy <= my; dy += 1) {
    for (let dx = -mx; dx <= mx; dx += 1) {
      const s = nccAt(A.g, B.g, A.w, A.h, dx, dy, 2);
      if (s > best.score) best = { dx, dy, score: s };
    }
  }
  let fine = { dx: best.dx * 2, dy: best.dy * 2, score: -2 };
  const cx = fine.dx;
  const cy = fine.dy;
  for (let dy = cy - 2; dy <= cy + 2; dy++) {
    for (let dx = cx - 2; dx <= cx + 2; dx++) {
      const s = nccAt(prev, cur, w, h, dx, dy, 1);
      if (s > fine.score) fine = { dx, dy, score: s };
    }
  }
  const overlap = Math.max(0, 1 - Math.abs(fine.dx) / w) * Math.max(0, 1 - Math.abs(fine.dy) / h);
  return { dx: fine.dx, dy: fine.dy, score: fine.score, overlap };
}

/**
 * วิเคราะห์เฟรมเดียว — rgba จาก canvas.getImageData ของภาพย่อ
 * คืน metrics + gradient (เก็บไว้เทียบ overlap ตอนถ่ายภาพถัดไป)
 */
export function analyzeFrame(rgba, w, h) {
  const g = toGray(rgba, w, h);
  const grad = gradient(g, w, h);
  return {
    sharpness: laplacianVariance(g, w, h),
    luma: lumaStats(g),
    texture: grad.mean,
    grad: grad.mag,
    w,
    h,
  };
}

/**
 * ตัดสินคุณภาพ — คืน { level: ok|warn|fail, issues: [{code, msg, level}] }
 * ctx: { sharpRef, prevGrad, rotRate, overlap }
 */
export function assess(m, ctx = {}, T = THRESHOLDS) {
  const issues = [];
  const add = (code, level, msg) => issues.push({ code, level, msg });

  if (m.luma.mean < T.lumaDark || m.luma.darkFrac > T.clipFrac) add('dark', 'fail', 'มืดเกินไป — เปิดไฟหรือเปิดม่าน');
  else if (m.luma.mean > T.lumaBright || m.luma.brightFrac > T.clipFrac) add('bright', 'warn', 'สว่างจ้าเกินไป — เลี่ยงการหันเข้าหน้าต่าง/ไฟโดยตรง');

  const sharpRef = ctx.sharpRef || 0;
  if (m.sharpness < T.sharpAbsMin) add('blur', 'fail', 'ภาพเบลอ — ถือให้นิ่งหรือแตะจอเพื่อโฟกัส');
  else if (sharpRef > 0 && m.sharpness < T.sharpRel * sharpRef) add('blur', 'warn', 'ความคมลดลง — ถือให้นิ่งกว่านี้');

  if (ctx.rotRate != null && ctx.rotRate > T.rotRateMax) add('motion', 'fail', 'ขยับเร็วเกินไป — หยุดนิ่งก่อนกดถ่าย');

  if (m.texture < T.textureMin) add('texture', 'warn', 'ผนังเรียบเกินไป — เล็งให้เห็นมุมห้อง ขอบประตู หรือของในห้องด้วย');

  if (ctx.overlap != null) {
    if (ctx.overlap < T.overlapMin) add('overlap-low', 'warn', 'ซ้อนกับภาพก่อนน้อยไป — ถอยกลับมาเล็กน้อย');
    else if (ctx.overlap > T.overlapMax) add('overlap-high', 'warn', 'แทบไม่ต่างจากภาพก่อน — ก้าวไปด้านข้างอีกครึ่งก้าว');
  }

  const level = issues.some((i) => i.level === 'fail') ? 'fail' : issues.length ? 'warn' : 'ok';
  return { level, issues };
}

/** ค่าอ้างอิงความคมแบบเคลื่อนที่: เปอร์เซ็นไทล์ที่ 80 ของ N เฟรมล่าสุด */
export class RollingRef {
  constructor(n = 30) {
    this.n = n;
    this.buf = [];
  }

  push(v) {
    this.buf.push(v);
    if (this.buf.length > this.n) this.buf.shift();
  }

  value() {
    if (this.buf.length < 5) return 0;
    const s = this.buf.slice().sort((a, b) => a - b);
    return s[Math.floor(0.8 * (s.length - 1))];
  }
}
