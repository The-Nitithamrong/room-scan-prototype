/**
 * editor.js — แก้แปลน 2D (SVG) + สลับดู 3D + ส่งออก
 *
 * state เป็นแหล่งความจริงเดียว: plan (ข้อมูล), view (กล้อง 2D), sel (สิ่งที่เลือก)
 * ทุกการแก้ไขผ่าน commit() ซึ่งเก็บประวัติไว้ทำ undo/redo และบันทึกอัตโนมัติ
 *
 * การโต้ตอบ (Pointer Events — ใช้ได้ทั้งนิ้วและเมาส์)
 *   ลากมุม          ย้ายมุม (จับกริด 1 ซม. และจับแนวตั้งฉากกับมุมข้างเคียง)
 *   ลากผนัง         เลื่อนผนังตั้งฉากกับตัวเอง (ห้องยังเป็นมุมฉาก)
 *   ลากประตู/หน้าต่าง เลื่อนตามแนวผนัง
 *   ลากพื้นที่ว่าง    เลื่อนมุมมอง · สองนิ้ว/ล้อเมาส์ = ซูม
 */
import * as P from './plan-model.js';
import * as store from './store.js';

const WALL_PX = 7;
const HIT_PX = 26;
const SNAP_PX = 10;
const WALL_NAMES = 'ABCDEFGHIJKLMNOP';

const state = {
  plan: null,
  room: null, // ห้องใน store (null = เปิดจากไฟล์ตัวอย่าง ยังไม่ได้บันทึก)
  sel: null, // {type:'wall'|'corner'|'opening', index}
  view: { s: 80, tx: 0, ty: 0 }, // screen = (x*s + tx, -y*s + ty)
  mode: '2d',
  undo: [],
  redo: [],
};

const el = {};
let viewer = null; // โมดูล 3D (โหลดเมื่อใช้)

/* ======================================================================
 * แปลงพิกัด
 * ==================================================================== */
const toScreen = ([x, y]) => [x * state.view.s + state.view.tx, -y * state.view.s + state.view.ty];
const toWorld = (sx, sy) => [(sx - state.view.tx) / state.view.s, -(sy - state.view.ty) / state.view.s];

function fit() {
  const r = el.svg.getBoundingClientRect();
  const xs = state.plan.corners.map((c) => c[0]);
  const ys = state.plan.corners.map((c) => c[1]);
  const w = Math.max(...xs) - Math.min(...xs) || 1;
  const h = Math.max(...ys) - Math.min(...ys) || 1;
  const pad = 70;
  const s = Math.min((r.width - 2 * pad) / w, (r.height - 2 * pad) / h);
  state.view.s = Math.max(10, s);
  state.view.tx = r.width / 2 - ((Math.min(...xs) + Math.max(...xs)) / 2) * state.view.s;
  state.view.ty = r.height / 2 + ((Math.min(...ys) + Math.max(...ys)) / 2) * state.view.s;
}

/* ======================================================================
 * แก้ไข + ประวัติ
 * ==================================================================== */
function commit(next, { record = true } = {}) {
  if (record) {
    state.undo.push(P.clone(state.plan));
    if (state.undo.length > 100) state.undo.shift();
    state.redo = [];
  }
  state.plan = next;
  save();
  render();
}

function undo() {
  if (!state.undo.length) return;
  state.redo.push(P.clone(state.plan));
  state.plan = state.undo.pop();
  state.sel = null;
  save();
  render();
}

function redo() {
  if (!state.redo.length) return;
  state.undo.push(P.clone(state.plan));
  state.plan = state.redo.pop();
  save();
  render();
}

function save() {
  if (!state.room) return;
  state.room.plan = state.plan;
  state.room.name = state.plan.name;
  store.saveRoom(state.room);
}

function toast(msg, ms = 2600) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.toast.hidden = true), ms);
}

/* ======================================================================
 * วาด 2D
 * ==================================================================== */
function svgEl(tag, attrs, text) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (text != null) n.textContent = text;
  return n;
}

function drawGrid(g, w, h) {
  const s = state.view.s;
  const [x0, y1] = toWorld(0, 0);
  const [x1, y0] = toWorld(w, h);
  const minor = s > 120 ? 0.1 : s > 40 ? 0.5 : 1;
  for (let x = Math.floor(x0 / minor) * minor; x <= x1; x += minor) {
    const sx = toScreen([x, 0])[0];
    const major = Math.abs(x - Math.round(x)) < 1e-6;
    g.appendChild(svgEl('line', { x1: sx, y1: 0, x2: sx, y2: h, class: major ? 'grid-major' : 'grid-minor' }));
  }
  for (let y = Math.floor(y0 / minor) * minor; y <= y1; y += minor) {
    const sy = toScreen([0, y])[1];
    const major = Math.abs(y - Math.round(y)) < 1e-6;
    g.appendChild(svgEl('line', { x1: 0, y1: sy, x2: w, y2: sy, class: major ? 'grid-major' : 'grid-minor' }));
  }
}

function render2d() {
  const svg = el.svg;
  const r = svg.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
  svg.textContent = '';
  const p = state.plan;
  const sel = state.sel;

  const grid = svgEl('g', {});
  drawGrid(grid, r.width, r.height);
  svg.appendChild(grid);

  // พื้น
  svg.appendChild(svgEl('polygon', { points: p.corners.map((c) => toScreen(c).join(',')).join(' '), class: 'floor' }));

  // ตำแหน่งที่ถ่ายภาพ (ถ้ามีจาก PoC) — ให้ผู้ใช้เห็นว่าส่วนไหนของห้องมีข้อมูล
  (p.cameras || []).forEach((c) => {
    const [x, y] = toScreen(c);
    svg.appendChild(svgEl('circle', { cx: x, cy: y, r: 3, class: 'cam-pt' }));
  });

  const sign = P.signedArea(p) >= 0 ? 1 : -1;
  const n = p.corners.length;
  for (let i = 0; i < n; i++) {
    const [a, b] = P.wallEnds(p, i).map(toScreen);
    const isSel = sel && sel.type === 'wall' && sel.index === i;
    svg.appendChild(svgEl('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: 'wall' + (isSel ? ' sel' : ''), 'stroke-width': WALL_PX }));
    svg.appendChild(svgEl('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: 'wall-hit', 'stroke-width': HIT_PX, 'data-wall': i }));
    // ป้ายระยะ: วางด้านนอกห้อง
    const [dx, dy] = P.wallDir(p, i);
    const nx = dy * sign;
    const ny = -dx * sign;
    const [ea, eb] = P.wallEnds(p, i);
    const mid = toScreen([(ea[0] + eb[0]) / 2, (ea[1] + eb[1]) / 2]);
    const off = 22;
    const lx = mid[0] + nx * off;
    const ly = mid[1] - ny * off;
    let ang = (Math.atan2(-(dy), dx) * 180) / Math.PI;
    if (ang > 90) ang -= 180;
    if (ang < -90) ang += 180;
    svg.appendChild(
      svgEl(
        'text',
        { x: lx, y: ly, class: 'dim' + (isSel ? ' sel' : ''), 'font-size': 14, 'stroke-width': 4, 'text-anchor': 'middle', 'dominant-baseline': 'middle', transform: `rotate(${ang} ${lx} ${ly})` },
        `${WALL_NAMES[i]} · ${P.wallLength(p, i).toFixed(2)} ${p.scaled ? 'ม.' : 'หน่วย'}`
      )
    );
  }

  (p.openings || []).forEach((o, k) => {
    const [e1, e2] = P.openingEnds(p, o).map(toScreen);
    const isSel = sel && sel.type === 'opening' && sel.index === k;
    svg.appendChild(svgEl('line', { x1: e1[0], y1: e1[1], x2: e2[0], y2: e2[1], class: `opening ${o.type}${isSel ? ' sel' : ''}`, 'stroke-width': WALL_PX + 5, 'data-opening': k }));
  });

  p.corners.forEach((c, i) => {
    const [x, y] = toScreen(c);
    const isSel = sel && sel.type === 'corner' && sel.index === i;
    svg.appendChild(svgEl('circle', { cx: x, cy: y, r: 9, class: 'corner' + (isSel ? ' sel' : ''), 'stroke-width': 3, 'data-corner': i }));
  });
}

/* ======================================================================
 * แผงด้านล่าง/ขวา
 * ==================================================================== */
function fmt(v, d = 2) {
  return v == null || Number.isNaN(v) ? '-' : Number(v).toFixed(d);
}

function numberField(label, value, attrs) {
  return `<label class="field"><span>${label}</span><input type="number" inputmode="decimal" step="${attrs.step || 0.01}" min="${attrs.min ?? 0}" value="${value}" data-field="${attrs.field}"></label>`;
}

function qualityHTML(q) {
  if (!q) return '';
  const label = { ok: 'ผ่าน', warn: 'ควรตรวจสอบ', fail: 'ไม่ผ่าน' }[q.level] || q.level;
  const msgs = (q.messages || []).map((m) => `<li>${m}</li>`).join('');
  return `<div class="notice ${q.level === 'fail' ? 'danger' : q.level === 'ok' ? 'info' : ''}" style="margin-bottom:12px">
    <b>คุณภาพผลลัพธ์: ${label}</b>${msgs ? `<ul>${msgs}</ul>` : ''}</div>`;
}

function renderPanel() {
  const p = state.plan;
  const sel = state.sel;
  const u = p.scaled ? 'ม.' : 'หน่วย';
  let html = '';

  if (!sel) {
    html += `<h3>${escapeHtml(p.name)}</h3>`;
    if (!p.scaled) {
      html += `<div class="notice danger" style="margin-bottom:12px"><b>ยังไม่มีสเกลจริง</b> — ขนาดในแปลนเป็นหน่วยสัมพัทธ์จากภาพ กด “ตั้งสเกล” แล้วกรอกระยะที่วัดจริง</div>`;
    }
    html += qualityHTML(p.quality);
    html += `<dl class="kv" style="margin-bottom:12px">
      <dt>พื้นที่</dt><dd>${fmt(P.area(p))} ${p.scaled ? 'ตร.ม.' : ''}</dd>
      <dt>เส้นรอบรูป</dt><dd>${fmt(P.perimeter(p))} ${u}</dd>
      <dt>มุม</dt><dd>${p.corners.length} มุม ${P.isRectilinear(p) ? '(มุมฉากทั้งหมด)' : ''}</dd>
      <dt>ช่องเปิด</dt><dd>${(p.openings || []).length}</dd>
      <dt>ที่มา</dt><dd>${{ 'poc-sfm': 'ภาพถ่าย (PoC)', manual: 'กรอกเอง' }[(p.source || {}).kind] || '-'}</dd></dl>`;
    html += `<div class="grid-2" style="margin-bottom:12px">
      <label class="field"><span>ชื่อห้อง</span><input type="text" value="${escapeHtml(p.name)}" data-field="name"></label>
      ${numberField(`ความสูงฝ้า (${u})`, fmt(p.height), { field: 'height', step: 0.01 })}</div>`;
    html += `<div class="row"><button class="btn btn-sm grow" data-act="scale">ตั้งสเกลจากระยะที่วัด</button></div>`;
    html += `<p class="faint" style="font-size:13px;margin-top:12px">แตะผนังเพื่อแก้ความยาวหรือเพิ่มประตู/หน้าต่าง · ลากมุมหรือผนังเพื่อปรับรูปทรง</p>`;
    html += `<p class="faint" style="font-size:12px">${escapeHtml(p.disclaimer || 'ค่าจากภาพถ่ายเป็นค่าประมาณ ต้องวัดหน้างานก่อนสั่งทำ built-in งานกระจก หรืองานก่อสร้าง')}</p>`;
  } else if (sel.type === 'wall') {
    const i = sel.index;
    const wq = ((p.quality || {}).walls || [])[i];
    html += `<h3>ผนัง ${WALL_NAMES[i]}</h3>`;
    if (wq && (wq.coverage < 0.5 || wq.ambiguous_inner_peak)) {
      html += `<div class="notice" style="margin-bottom:12px">${wq.coverage < 0.5 ? `มีข้อมูลจากภาพ ${Math.round(wq.coverage * 100)}% ของความยาว` : ''}${wq.ambiguous_inner_peak ? ' · พบระนาบซ้อน (อาจเป็นตู้ชิดผนัง) ตรวจว่าเส้นผนังอยู่ถูกตำแหน่ง' : ''}</div>`;
    }
    html += `<div class="grid-2" style="margin-bottom:12px">${numberField(`ความยาว (${u})`, fmt(P.wallLength(p, i), 3), { field: 'wallLength', step: 0.001 })}
      <div style="align-self:end"><button class="btn btn-sm btn-block" data-act="scale-wall">ใช้เป็นระยะอ้างอิง</button></div></div>`;
    html += `<p class="faint" style="font-size:13px">“ความยาว” เปลี่ยนรูปทรง (${P.isRectangle(p) ? 'ผนังตรงข้ามเลื่อนตาม' : 'เลื่อนมุมปลาย'}) · “ใช้เป็นระยะอ้างอิง” ย่อ/ขยายทั้งแปลน</p>`;
    html += `<div class="row"><button class="btn btn-sm grow" data-act="add-door">+ ประตู</button><button class="btn btn-sm grow" data-act="add-window">+ หน้าต่าง</button><button class="btn btn-sm grow" data-act="split">+ มุม</button></div>`;
  } else if (sel.type === 'opening') {
    const o = p.openings[sel.index];
    const L = P.wallLength(p, o.wall);
    html += `<h3>${o.type === 'door' ? 'ประตู' : 'หน้าต่าง'} บนผนัง ${WALL_NAMES[o.wall]}</h3>`;
    html += `<div class="grid-2" style="margin-bottom:12px">
      ${numberField('กว้าง (ม.)', fmt(o.width, 3), { field: 'o.width', step: 0.01 })}
      ${numberField('ระยะจากมุม (ม.)', fmt(o.offset, 3), { field: 'o.offset', step: 0.01 })}
      ${numberField('สูง (ม.)', fmt(o.height, 2), { field: 'o.height', step: 0.01 })}
      ${numberField('สูงจากพื้น (ม.)', fmt(o.sill, 2), { field: 'o.sill', step: 0.01 })}</div>`;
    html += `<p class="faint" style="font-size:13px">ผนังยาว ${fmt(L)} ม. · เหลือด้านขวา ${fmt(L - o.offset - o.width)} ม.</p>`;
    html += `<div class="row"><button class="btn btn-sm btn-danger grow" data-act="del-opening">ลบ</button></div>`;
  } else if (sel.type === 'corner') {
    const c = p.corners[sel.index];
    html += `<h3>มุมที่ ${sel.index + 1}</h3><dl class="kv" style="margin-bottom:12px"><dt>x</dt><dd>${fmt(c[0], 3)}</dd><dt>y</dt><dd>${fmt(c[1], 3)}</dd></dl>`;
    html += `<div class="row"><button class="btn btn-sm btn-danger grow" data-act="del-corner" ${p.corners.length <= 3 ? 'disabled' : ''}>ลบมุม</button></div>`;
  }
  el.panel.innerHTML = html;

  el.hud.innerHTML = state.plan.quality
    ? `<span class="badge ${state.plan.quality.level}">${{ ok: 'คุณภาพผ่าน', warn: 'ควรตรวจสอบ', fail: 'ไม่ผ่าน' }[state.plan.quality.level] || ''}</span>`
    : '';
}

function escapeHtml(s) {
  return String(s || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
}

function render() {
  el.title.textContent = state.plan.name;
  el.btnUndo.disabled = !state.undo.length;
  el.btnRedo.disabled = !state.redo.length;
  el.btn2d.setAttribute('aria-pressed', state.mode === '2d');
  el.btn3d.setAttribute('aria-pressed', state.mode === '3d');
  el.svg.style.display = state.mode === '2d' ? '' : 'none';
  el.view3d.hidden = state.mode !== '3d';
  if (state.mode === '2d') render2d();
  else if (viewer) viewer.update(state.plan);
  renderPanel();
}

/* ======================================================================
 * แผงควบคุม: รับค่า
 * ==================================================================== */
function onPanelChange(e) {
  const f = e.target.getAttribute('data-field');
  if (!f) return;
  const p = state.plan;
  const v = e.target.type === 'number' ? parseFloat(e.target.value) : e.target.value;
  try {
    if (f === 'name') commit(Object.assign(P.clone(p), { name: v.trim() || 'ห้อง' }));
    else if (f === 'height') {
      if (!(v > 0)) throw new Error('ความสูงต้องมากกว่า 0');
      commit(Object.assign(P.clone(p), { height: v }));
    } else if (f === 'wallLength') commit(P.setWallLength(p, state.sel.index, v));
    else if (f.startsWith('o.')) {
      if (!(v >= 0)) throw new Error('ค่าต้องไม่ติดลบ');
      commit(P.updateOpening(p, state.sel.index, { [f.slice(2)]: v }));
    }
  } catch (err) {
    toast(err.message);
    render();
  }
}

function onPanelClick(e) {
  const act = e.target.getAttribute('data-act');
  if (!act) return;
  const p = state.plan;
  const sel = state.sel;
  if (act === 'scale') openScaleDialog(null);
  else if (act === 'scale-wall') openScaleDialog(sel.index);
  else if (act === 'add-door' || act === 'add-window') {
    const next = P.addOpening(p, sel.index, act === 'add-door' ? 'door' : 'window');
    state.sel = { type: 'opening', index: next.openings.length - 1 };
    commit(next);
  } else if (act === 'split') {
    commit(P.splitWall(p, sel.index));
    state.sel = { type: 'corner', index: sel.index + 1 };
    render();
  } else if (act === 'del-opening') {
    state.sel = null;
    commit(P.removeOpening(p, sel.index));
  } else if (act === 'del-corner') {
    const q = P.clone(p);
    q.corners.splice(sel.index, 1);
    q.openings = (q.openings || []).filter((o) => o.wall !== sel.index && o.wall !== (sel.index - 1 + p.corners.length) % p.corners.length);
    q.openings.forEach((o) => {
      if (o.wall > sel.index) o.wall--;
    });
    state.sel = null;
    commit(P.clampOpenings(q));
  }
}

function openScaleDialog(wall) {
  const p = state.plan;
  el.scaleKind.innerHTML =
    p.corners.map((_, i) => `<option value="wall:${i}" ${i === wall ? 'selected' : ''}>ผนัง ${WALL_NAMES[i]} (ตอนนี้ ${fmt(P.wallLength(p, i), 3)})</option>`).join('') +
    (p.height ? `<option value="height">ความสูงฝ้า (ตอนนี้ ${fmt(p.height, 3)})</option>` : '');
  el.scaleVal.value = '';
  el.dlgScale.showModal();
}

function onScaleClose() {
  if (el.dlgScale.returnValue !== 'ok') return;
  const v = parseFloat(el.scaleVal.value);
  const kind = el.scaleKind.value;
  const ref = kind === 'height' ? { kind: 'height', measured: v } : { kind: 'wall', wall: +kind.split(':')[1], measured: v };
  try {
    // ถ้ามีสเกลอยู่แล้ว ระยะใหม่ใช้ "ตรวจสอบ" ก่อน — ต่างมากแปลว่าวัดผิดหรือแปลนเพี้ยน
    if (state.plan.scaled && (state.plan.references || []).length) {
      const diff = P.checkReference(state.plan, ref);
      if (Math.abs(diff) > 1.5 && !confirm(`ระยะนี้ต่างจากแปลนปัจจุบัน ${diff.toFixed(1)}%\nอาจวัดผิด เลือกผนังผิด หรือรูปทรงจากภาพเพี้ยน\nยืนยันจะย่อ/ขยายทั้งแปลนตามระยะนี้?`)) return;
    }
    commit(P.scaleToReference(state.plan, ref));
    toast('ตั้งสเกลแล้ว — ถ้ามีระยะอีกจุด ให้ใช้ตรวจสอบซ้ำ');
  } catch (err) {
    toast(err.message);
  }
}

/* ======================================================================
 * การโต้ตอบบน SVG
 * ==================================================================== */
const pointers = new Map();
let drag = null;

function localXY(e) {
  const r = el.svg.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function snapCorner(i, w) {
  const p = state.plan;
  const n = p.corners.length;
  let [x, y] = [Math.round(w[0] * 100) / 100, Math.round(w[1] * 100) / 100];
  const tol = SNAP_PX / state.view.s;
  // จับแนวให้ตั้งฉากกับมุมข้างเคียง
  for (const j of [(i - 1 + n) % n, (i + 1) % n]) {
    const c = p.corners[j];
    if (Math.abs(x - c[0]) < tol) x = c[0];
    if (Math.abs(y - c[1]) < tol) y = c[1];
  }
  return [x, y];
}

function onPointerDown(e) {
  el.svg.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, localXY(e));
  const t = e.target;
  const start = localXY(e);
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    drag = { kind: 'pinch', d0: Math.hypot(a[0] - b[0], a[1] - b[1]), s0: state.view.s, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], before: null };
    return;
  }
  const base = P.clone(state.plan);
  if (t.hasAttribute('data-corner')) drag = { kind: 'corner', index: +t.getAttribute('data-corner'), start, base, moved: false };
  else if (t.hasAttribute('data-opening')) drag = { kind: 'opening', index: +t.getAttribute('data-opening'), start, base, moved: false };
  else if (t.hasAttribute('data-wall')) drag = { kind: 'wall', index: +t.getAttribute('data-wall'), start, base, moved: false };
  else drag = { kind: 'pan', start, tx: state.view.tx, ty: state.view.ty, moved: false };
}

function onPointerMove(e) {
  if (!pointers.has(e.pointerId) || !drag) return;
  const cur = localXY(e);
  pointers.set(e.pointerId, cur);
  if (drag.kind === 'pinch' && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    zoomAt(drag.mid, (drag.s0 * d) / drag.d0);
    return;
  }
  const dx = cur[0] - drag.start[0];
  const dy = cur[1] - drag.start[1];
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  const s = state.view.s;
  if (drag.kind === 'pan') {
    state.view.tx = drag.tx + dx;
    state.view.ty = drag.ty + dy;
    render2d();
  } else if (drag.kind === 'corner') {
    const w = toWorld(cur[0], cur[1]);
    state.plan = P.moveCorner(drag.base, drag.index, ...snapCorner(drag.index, w));
    state.sel = { type: 'corner', index: drag.index };
    render2d();
  } else if (drag.kind === 'wall') {
    // เลื่อนผนังตามแนวตั้งฉาก: ฉายการลากลงบน normal ของผนัง
    const [ux, uy] = P.wallDir(drag.base, drag.index);
    const nx = -uy;
    const ny = ux;
    const dw = Math.round(((dx / s) * nx + (-dy / s) * ny) * 100) / 100;
    const q = P.clone(drag.base);
    const n = q.corners.length;
    for (const k of [drag.index, (drag.index + 1) % n]) q.corners[k] = [q.corners[k][0] + nx * dw, q.corners[k][1] + ny * dw];
    state.plan = P.clampOpenings(P.roundPlan(q));
    state.sel = { type: 'wall', index: drag.index };
    render2d();
  } else if (drag.kind === 'opening') {
    const o = drag.base.openings[drag.index];
    const [ux, uy] = P.wallDir(drag.base, o.wall);
    const along = (dx / s) * ux + (-dy / s) * uy;
    state.plan = P.updateOpening(drag.base, drag.index, { offset: Math.round((o.offset + along) * 100) / 100 });
    state.sel = { type: 'opening', index: drag.index };
    render2d();
  }
}

function onPointerUp(e) {
  pointers.delete(e.pointerId);
  if (!drag) return;
  const d = drag;
  if (pointers.size > 0 && d.kind === 'pinch') return;
  drag = null;
  if (d.kind === 'pinch') return;
  if (!d.moved) {
    // แตะ = เลือก
    if (d.kind === 'pan') state.sel = null;
    else state.sel = { type: d.kind, index: d.index };
    render();
    return;
  }
  if (d.kind !== 'pan') {
    const next = state.plan;
    state.plan = d.base;
    commit(next);
  }
}

function zoomAt([sx, sy], s) {
  s = Math.max(10, Math.min(1200, s));
  const [wx, wy] = toWorld(sx, sy);
  state.view.s = s;
  state.view.tx = sx - wx * s;
  state.view.ty = sy + wy * s;
  render2d();
}

/* ======================================================================
 * 3D
 * ==================================================================== */
async function show3d() {
  state.mode = '3d';
  render();
  if (!viewer) {
    try {
      const mod = await import('./viewer3d.js');
      viewer = mod.createViewer(el.view3d);
    } catch (err) {
      console.error(err);
      toast('โหลดมุมมอง 3D ไม่สำเร็จ (ต้องต่ออินเทอร์เน็ตเพื่อโหลด Three.js)', 4000);
      state.mode = '2d';
      render();
      return;
    }
  }
  viewer.update(state.plan);
}

/* ======================================================================
 * ส่งออก/นำเข้า
 * ==================================================================== */
function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/**
 * ชื่อไฟล์ ASCII ล้วน — ทดสอบแล้ว Chromium ไม่ใช้ชื่อภาษาไทยใน a.download
 * (ได้ไฟล์ชื่อ "download" แทน) จึงใช้ชื่อห้องเฉพาะส่วนที่เป็น ASCII + วันเวลา
 */
function safeName() {
  const slug = (state.plan.name || '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `${slug || 'room'}-${stamp}`;
}

async function onMenu(e) {
  const act = e.target.closest('button') && e.target.closest('button').getAttribute('data-act');
  if (!act) return;
  el.menu.hidden = true;
  const p = state.plan;
  if (!p.scaled && act.startsWith('export') && act !== 'export-json') {
    if (!confirm('แปลนนี้ยังไม่มีสเกลจริง ไฟล์ที่ส่งออกจะไม่ใช่ขนาดจริง ส่งออกต่อไหม?')) return;
  }
  if (act === 'export-json') download(`${safeName()}.plan.json`, P.toJSON(p), 'application/json');
  else if (act === 'export-svg') download(`${safeName()}.svg`, P.toSVG(p), 'image/svg+xml');
  else if (act === 'export-dxf') download(`${safeName()}.dxf`, P.toDXF(p), 'application/dxf');
  else if (act === 'export-furniture') download(`${safeName()}.furniture.json`, JSON.stringify(P.toFurnitureLayout(p), null, 2), 'application/json');
  else if (act === 'export-glb') {
    if (!viewer) await show3d();
    if (viewer) download(`${safeName()}.glb`, await viewer.exportGLB(), 'model/gltf-binary');
  } else if (act === 'import') el.fileInput.click();
  else if (act === 'save-new') {
    const room = store.createRoom(p.name);
    state.room = room;
    save();
    history.replaceState(null, '', '?room=' + room.id);
    toast('บันทึกเป็นห้องใหม่แล้ว');
  }
}

async function onImport() {
  const f = el.fileInput.files[0];
  el.fileInput.value = '';
  if (!f) return;
  try {
    const plan = JSON.parse(await f.text());
    const errs = P.validatePlan(plan);
    if (errs.length) throw new Error(errs.join(', '));
    state.sel = null;
    commit(plan);
    fit();
    render();
    toast('นำเข้าแปลนแล้ว');
  } catch (err) {
    toast('เปิดไฟล์ไม่ได้: ' + err.message, 4000);
  }
}

/* ======================================================================
 * โหลดแปลน
 * ==================================================================== */
async function loadPlan() {
  const q = new URLSearchParams(location.search);
  const sample = q.get('sample');
  const roomId = q.get('room');
  if (sample) {
    const file = { poc: 'samples/poc-plan.json', unscaled: 'samples/poc-plan-unscaled.json' }[sample];
    if (file) {
      try {
        const res = await fetch(file);
        const plan = await res.json();
        if (!P.validatePlan(plan).length) return { plan, room: null };
      } catch (err) {
        console.warn(err);
      }
    }
  }
  if (roomId) {
    const room = store.getRoom(roomId);
    if (room) {
      const plan = room.plan || P.createRectPlan(4, 3, 2.6, room.name);
      return { plan, room };
    }
  }
  return { plan: P.createRectPlan(4.0, 3.0, 2.6, 'ห้องตัวอย่าง'), room: null };
}

async function boot() {
  [
    'title', 'btn2d', 'btn3d', 'btnUndo', 'btnRedo', 'btnMenu', 'menu', 'fileInput', 'stage', 'svg', 'view3d', 'hud',
    'btnFit', 'panel', 'dlgScale', 'scaleKind', 'scaleVal', 'toast',
  ].forEach((id) => (el[id] = document.getElementById(id)));

  const { plan, room } = await loadPlan();
  state.plan = plan;
  state.room = room;
  fit();

  el.svg.addEventListener('pointerdown', onPointerDown);
  el.svg.addEventListener('pointermove', onPointerMove);
  el.svg.addEventListener('pointerup', onPointerUp);
  el.svg.addEventListener('pointercancel', onPointerUp);
  el.svg.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoomAt(localXY(e), state.view.s * Math.exp(-e.deltaY * 0.0015));
    },
    { passive: false }
  );
  el.panel.addEventListener('change', onPanelChange);
  el.panel.addEventListener('click', onPanelClick);
  el.btnUndo.addEventListener('click', undo);
  el.btnRedo.addEventListener('click', redo);
  el.btnFit.addEventListener('click', () => {
    fit();
    render();
  });
  el.btn2d.addEventListener('click', () => {
    state.mode = '2d';
    render();
  });
  el.btn3d.addEventListener('click', show3d);
  el.btnMenu.addEventListener('click', () => (el.menu.hidden = !el.menu.hidden));
  el.menu.addEventListener('click', onMenu);
  el.fileInput.addEventListener('change', onImport);
  el.dlgScale.addEventListener('close', onScaleClose);
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') (e.shiftKey ? redo : undo)();
    if (e.key === 'Escape') {
      state.sel = null;
      render();
    }
  });
  window.addEventListener('resize', () => render());
  render();
}

boot();
