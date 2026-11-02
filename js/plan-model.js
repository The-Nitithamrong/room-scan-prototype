/**
 * plan-model.js — โมเดลข้อมูลแปลนห้อง (roomscan.plan/v1) + ฟังก์ชันคำนวณ/ส่งออก
 *
 * เป็น ES module ที่ไม่แตะ DOM เลย เพื่อให้ editor, viewer และ capture ใช้ร่วมกัน
 * และทดสอบด้วย node ได้ตรง ๆ (ดู tests/plan-model.test.mjs)
 *
 * พิกัด: เมตร แกน x ไปขวา แกน y ขึ้น (มองจากบน) มุมเรียงทวนเข็มนาฬิกา
 * ผนัง i คือเส้นจาก corners[i] → corners[(i+1) % n]
 */

export const SCHEMA = 'roomscan.plan/v1';

export const OPENING_DEFAULTS = {
  door: { width: 0.8, height: 2.0, sill: 0 },
  window: { width: 1.2, height: 1.2, sill: 0.9 },
};

/* ======================================================================
 * สร้าง / ตรวจสอบ
 * ==================================================================== */
export function createRectPlan(width, depth, height, name) {
  return {
    schema: SCHEMA,
    name: name || 'ห้องใหม่',
    units: 'm',
    scaled: true,
    height: height || 2.6,
    corners: [[0, 0], [width, 0], [width, depth], [0, depth]],
    openings: [],
    references: [],
    quality: { level: 'warn', messages: ['สร้างจากระยะที่ผู้ใช้กรอกเอง ไม่ได้มาจากภาพ'] },
    source: { kind: 'manual', created: new Date().toISOString() },
  };
}

/** คืนรายการปัญหา (array ว่าง = ใช้ได้) — ใช้ตอนเปิดไฟล์ที่ผู้ใช้นำเข้า */
export function validatePlan(p) {
  const errs = [];
  if (!p || typeof p !== 'object') return ['ไม่ใช่ไฟล์แปลน'];
  if (p.schema !== SCHEMA) errs.push('schema ไม่ใช่ ' + SCHEMA);
  if (!Array.isArray(p.corners) || p.corners.length < 3) errs.push('ต้องมีมุมอย่างน้อย 3 มุม');
  else if (p.corners.some((c) => !Array.isArray(c) || c.length !== 2 || !c.every(Number.isFinite)))
    errs.push('พิกัดมุมไม่ถูกต้อง');
  if (p.height != null && !(p.height > 0)) errs.push('ความสูงต้องมากกว่า 0');
  (p.openings || []).forEach((o, i) => {
    if (!['door', 'window'].includes(o.type)) errs.push(`ช่องเปิด ${i}: ชนิดไม่ถูกต้อง`);
    if (!(o.wall >= 0 && o.wall < (p.corners || []).length)) errs.push(`ช่องเปิด ${i}: ผนังไม่ถูกต้อง`);
  });
  return errs;
}

export function clone(p) {
  return JSON.parse(JSON.stringify(p));
}

/* ======================================================================
 * เรขาคณิต
 * ==================================================================== */
export function wallCount(p) {
  return p.corners.length;
}

export function wallEnds(p, i) {
  const n = p.corners.length;
  return [p.corners[i], p.corners[(i + 1) % n]];
}

export function wallLength(p, i) {
  const [a, b] = wallEnds(p, i);
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function wallDir(p, i) {
  const [a, b] = wallEnds(p, i);
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
}

/** พื้นที่ (shoelace) — บวกเมื่อเรียงทวนเข็ม */
export function signedArea(p) {
  let s = 0;
  const c = p.corners;
  for (let i = 0; i < c.length; i++) {
    const [x1, y1] = c[i];
    const [x2, y2] = c[(i + 1) % c.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

export function area(p) {
  return Math.abs(signedArea(p));
}

export function perimeter(p) {
  let s = 0;
  for (let i = 0; i < p.corners.length; i++) s += wallLength(p, i);
  return s;
}

/** ทุกมุมเป็นมุมฉากไหม (ยอมให้คลาด tolDeg องศา) */
export function isRectilinear(p, tolDeg = 0.5) {
  const n = p.corners.length;
  for (let i = 0; i < n; i++) {
    const d1 = wallDir(p, (i - 1 + n) % n);
    const d2 = wallDir(p, i);
    const dot = d1[0] * d2[0] + d1[1] * d2[1];
    if (Math.abs(dot) > Math.sin((tolDeg * Math.PI) / 180)) return false;
  }
  return true;
}

export function isRectangle(p) {
  return p.corners.length === 4 && isRectilinear(p);
}

/* ======================================================================
 * แก้ไข — ทุกฟังก์ชันคืนแปลนใหม่ ไม่แก้ของเดิม (ทำ undo ง่าย)
 * ==================================================================== */

/**
 * กำหนดความยาวผนัง i
 *  - ห้องสี่เหลี่ยมผืนผ้า: ขยับผนังฝั่งตรงข้ามตามไปด้วย ให้ยังเป็นมุมฉาก
 *  - รูปทรงอื่น: เลื่อนปลายผนัง (และมุมถัด ๆ ไปไม่เปลี่ยน) ตามทิศผนังเดิม
 */
export function setWallLength(p, i, L) {
  if (!(L > 0)) throw new Error('ความยาวต้องมากกว่า 0');
  const q = clone(p);
  const n = q.corners.length;
  const delta = L - wallLength(p, i);
  const [dx, dy] = wallDir(p, i);
  if (isRectangle(p)) {
    // เลื่อนมุมปลายผนัง i และมุมถัดไป (ผนังฝั่งตรงข้ามเลื่อนตาม)
    for (const k of [(i + 1) % n, (i + 2) % n]) {
      q.corners[k] = [q.corners[k][0] + dx * delta, q.corners[k][1] + dy * delta];
    }
  } else {
    const k = (i + 1) % n;
    q.corners[k] = [q.corners[k][0] + dx * delta, q.corners[k][1] + dy * delta];
  }
  return clampOpenings(roundPlan(q));
}

/** ย่อ/ขยายทั้งแปลนให้ผนัง i ยาวเท่าระยะที่วัดจริง (ใช้กับผลจากภาพที่ยังไม่มีสเกล) */
export function scaleToReference(p, ref) {
  const est = ref.kind === 'height' ? p.height : wallLength(p, ref.wall);
  if (!(est > 0) || !(ref.measured > 0)) throw new Error('ระยะอ้างอิงไม่ถูกต้อง');
  const s = ref.measured / est;
  const q = clone(p);
  q.corners = q.corners.map(([x, y]) => [x * s, y * s]);
  if (q.height) q.height *= s;
  q.openings = (q.openings || []).map((o) => Object.assign({}, o, { offset: o.offset * s, width: o.width * s }));
  if (q.cameras) q.cameras = q.cameras.map(([x, y]) => [x * s, y * s]);
  q.units = 'm';
  q.scaled = true;
  q.references = (q.references || []).concat([Object.assign({ scale: s }, ref)]);
  return roundPlan(q);
}

/** ตรวจความสอดคล้องของระยะอ้างอิงชุดที่ 2 กับแปลนปัจจุบัน (คืนเปอร์เซ็นต์ความต่าง) */
export function checkReference(p, ref) {
  const est = ref.kind === 'height' ? p.height : wallLength(p, ref.wall);
  return (100 * (est - ref.measured)) / ref.measured;
}

export function moveCorner(p, i, x, y) {
  const q = clone(p);
  q.corners[i] = [x, y];
  return clampOpenings(roundPlan(q));
}

/** แทรกมุมใหม่กลางผนัง i (ใช้ทำห้องรูปตัว L) */
export function splitWall(p, i) {
  const q = clone(p);
  const [a, b] = wallEnds(p, i);
  q.corners.splice(i + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  q.openings = (q.openings || []).map((o) => (o.wall > i ? Object.assign({}, o, { wall: o.wall + 1 }) : o));
  return roundPlan(q);
}

export function addOpening(p, wall, type) {
  const q = clone(p);
  const d = OPENING_DEFAULTS[type];
  const L = wallLength(p, wall);
  const width = Math.min(d.width, L * 0.9);
  q.openings = (q.openings || []).concat([
    { type, wall, offset: (L - width) / 2, width, height: d.height, sill: d.sill },
  ]);
  return roundPlan(q);
}

export function updateOpening(p, idx, patch) {
  const q = clone(p);
  q.openings[idx] = Object.assign({}, q.openings[idx], patch);
  return clampOpenings(roundPlan(q));
}

export function removeOpening(p, idx) {
  const q = clone(p);
  q.openings.splice(idx, 1);
  return q;
}

/** ช่องเปิดต้องอยู่ในผนังเสมอ หลังแก้ความยาวผนัง */
export function clampOpenings(p) {
  (p.openings || []).forEach((o) => {
    const L = wallLength(p, o.wall);
    o.width = Math.min(o.width, L);
    o.offset = Math.min(Math.max(0, o.offset), L - o.width);
  });
  return p;
}

/** ปัดเป็นมิลลิเมตร — ความละเอียดเกินนี้ไม่มีความหมายสำหรับข้อมูลจากภาพ */
export function roundPlan(p) {
  const r = (v) => Math.round(v * 1000) / 1000;
  p.corners = p.corners.map(([x, y]) => [r(x), r(y)]);
  if (p.height != null) p.height = r(p.height);
  (p.openings || []).forEach((o) => {
    ['offset', 'width', 'height', 'sill'].forEach((k) => {
      if (o[k] != null) o[k] = r(o[k]);
    });
  });
  return p;
}

/* ======================================================================
 * ส่งออก
 * ==================================================================== */
export function toJSON(p) {
  return JSON.stringify(p, null, 2);
}

function bounds(p) {
  const xs = p.corners.map((c) => c[0]);
  const ys = p.corners.map((c) => c[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** ตำแหน่งปลายทั้งสองของช่องเปิดบนผนัง */
export function openingEnds(p, o) {
  const [a] = wallEnds(p, o.wall);
  const [dx, dy] = wallDir(p, o.wall);
  return [
    [a[0] + dx * o.offset, a[1] + dy * o.offset],
    [a[0] + dx * (o.offset + o.width), a[1] + dy * (o.offset + o.width)],
  ];
}

/** SVG สำหรับพิมพ์/แชร์ — มาตราส่วน 1 ม. = 100 หน่วย มีระยะกำกับทุกผนัง */
export function toSVG(p) {
  const b = bounds(p);
  const m = 0.6;
  const S = 100;
  const W = (b.maxX - b.minX + 2 * m) * S;
  const H = (b.maxY - b.minY + 2 * m) * S;
  const X = (x) => ((x - b.minX + m) * S).toFixed(1);
  const Y = (y) => ((b.maxY - y + m) * S).toFixed(1);
  const pts = p.corners.map(([x, y]) => `${X(x)},${Y(y)}`).join(' ');
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" font-family="sans-serif">`,
    `<rect width="100%" height="100%" fill="#fff"/>`,
    `<polygon points="${pts}" fill="#f4f6fb" stroke="#1d2433" stroke-width="8" stroke-linejoin="miter"/>`,
  ];
  const sign = signedArea(p) >= 0 ? 1 : -1;
  for (let i = 0; i < p.corners.length; i++) {
    const [a, c] = wallEnds(p, i);
    const [dx, dy] = wallDir(p, i);
    const nx = dy * sign;
    const ny = -dx * sign; // ชี้ออกนอกห้อง
    const mx = (a[0] + c[0]) / 2 + nx * 0.3;
    const my = (a[1] + c[1]) / 2 + ny * 0.3;
    out.push(
      `<text x="${X(mx)}" y="${Y(my)}" font-size="22" text-anchor="middle" dominant-baseline="middle" fill="#1d2433">${wallLength(p, i).toFixed(2)} ม.</text>`
    );
  }
  (p.openings || []).forEach((o) => {
    const [e1, e2] = openingEnds(p, o);
    const color = o.type === 'door' ? '#c2410c' : '#0369a1';
    out.push(`<line x1="${X(e1[0])}" y1="${Y(e1[1])}" x2="${X(e2[0])}" y2="${Y(e2[1])}" stroke="${color}" stroke-width="12"/>`);
  });
  out.push(
    `<text x="10" y="${(H - 12).toFixed(0)}" font-size="16" fill="#64748b">${escapeXml(p.name || '')} · พื้นที่ ${area(p).toFixed(2)} ตร.ม. · สูง ${p.height ? p.height.toFixed(2) + ' ม.' : '-'} · ค่าประมาณจากภาพ ต้องวัดหน้างานก่อนสั่งผลิต</text>`
  );
  out.push('</svg>');
  return out.join('\n');
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}

/**
 * DXF (AutoCAD R12 ASCII) หน่วยมิลลิเมตร — เปิดได้ใน AutoCAD, LibreCAD, SketchUp (ผ่าน import)
 * layer: WALLS, DOORS, WINDOWS, DIMS(ข้อความ)
 */
export function toDXF(p) {
  const mm = (v) => (v * 1000).toFixed(1);
  const lines = ['0', 'SECTION', '2', 'ENTITIES'];
  const line = (layer, a, b) => {
    lines.push('0', 'LINE', '8', layer, '10', mm(a[0]), '20', mm(a[1]), '30', '0', '11', mm(b[0]), '21', mm(b[1]), '31', '0');
  };
  const text = (layer, at, h, s) => {
    lines.push('0', 'TEXT', '8', layer, '10', mm(at[0]), '20', mm(at[1]), '30', '0', '40', String(h), '1', s);
  };
  for (let i = 0; i < p.corners.length; i++) {
    const [a, b] = wallEnds(p, i);
    line('WALLS', a, b);
    text('DIMS', [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], 80, `${Math.round(wallLength(p, i) * 1000)}`);
  }
  (p.openings || []).forEach((o) => {
    const [e1, e2] = openingEnds(p, o);
    line(o.type === 'door' ? 'DOORS' : 'WINDOWS', e1, e2);
  });
  lines.push('0', 'ENDSEC', '0', 'EOF');
  return lines.join('\n');
}

/**
 * รูปแบบสำหรับระบบวางเฟอร์นิเจอร์: ผนังเป็นเส้นพร้อมความหนาโดยประมาณ และช่องเปิด
 * แยกจากไฟล์แปลนหลักเพื่อให้ระบบปลายทางไม่ต้องรู้ schema ภายใน
 */
export function toFurnitureLayout(p) {
  return {
    format: 'roomscan.furniture-input/v1',
    units: 'm',
    height: p.height,
    floor_polygon: p.corners,
    walls: p.corners.map((_, i) => {
      const [a, b] = wallEnds(p, i);
      return { index: i, from: a, to: b, length: +wallLength(p, i).toFixed(3) };
    }),
    openings: (p.openings || []).map((o) => {
      const [e1, e2] = openingEnds(p, o);
      return Object.assign({}, o, { from: e1, to: e2 });
    }),
    accuracy_note: 'ระยะจากภาพถ่ายมีความคลาดเคลื่อน เว้นระยะเผื่อเฟอร์นิเจอร์อย่างน้อย 5 ซม. และวัดหน้างานก่อนสั่งทำ built-in',
  };
}
