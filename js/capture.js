/**
 * capture.js — ตัวควบคุมหน้าถ่ายภาพแบบมีผู้ช่วยนำทาง
 *
 * หลักการเดียวกับ ar-app.js ของโปรเจคเดิม: state object เป็นแหล่งความจริงเดียว
 * ทุกครั้งที่ state เปลี่ยนจะเรียก render() วาดหน้าจอใหม่จาก state
 *
 *   intro → capturing ⇄ review → measure → done
 *
 * โปรโตคอลการถ่าย: 4 ผนัง × หลายจุด × 2 ภาพต่อจุด (ก้ม / เงย)
 * ตรวจคุณภาพทุก ~200 ms: คมชัด แสง รายละเอียดพื้นผิว การซ้อนทับ และการสั่น
 */
import * as Q from './quality.js';
import { SensorHub, requestPermission } from './sensors.js';
import * as store from './store.js';
import { createRectPlan } from './plan-model.js';

const WALLS = ['A', 'B', 'C', 'D'];
const SHOTS = [
  { key: 'low', label: 'ก้ม', hint: 'ก้มให้เห็นรอยต่อพื้นกับผนัง', pitch: [-28, -4] },
  { key: 'high', label: 'เงย', hint: 'เงยให้เห็นรอยต่อเพดานกับผนัง', pitch: [2, 24] },
];
const MIN_STATIONS_PER_WALL = 3;
const ANALYSIS_LONG_SIDE = 160;
const SECTORS = 12;

/* ======================================================================
 * State
 * ==================================================================== */
const state = {
  screen: 'intro', // intro|capturing|review|measure|done
  room: null,
  wall: 0, // ผนังที่กำลังถ่าย
  station: 0, // จุดที่บนผนังนี้
  shotInStation: 0, // 0 = ก้ม, 1 = เงย
  shots: [], // [{id, url, meta}]
  live: null, // ผลวิเคราะห์เฟรมล่าสุด
  assessment: { level: 'warn', issues: [] },
  overlap: null,
  stepsAtLastStation: 0,
  error: '',
};

const el = {};
const sensors = new SensorHub();
const sharpRef = new Q.RollingRef(25);
let stream = null;
let lastGrad = null; // gradient ของภาพล่าสุดที่ถ่าย (ไว้เทียบ overlap)
let analyzeTimer = null;
let overlapBusy = false;
const small = document.createElement('canvas');
const smallCtx = small.getContext('2d', { willReadFrequently: true });

function $(id) {
  return document.getElementById(id);
}

function setState(patch) {
  Object.assign(state, patch);
  render();
}

function toast(msg, ms = 2400) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.toast.hidden = true), ms);
}

/* ======================================================================
 * เริ่มกล้อง
 * ==================================================================== */
function checkEnvironment() {
  const msgs = [];
  if (!window.isSecureContext) msgs.push('ต้องเปิดผ่าน HTTPS (หรือ localhost) กล้องจึงจะทำงาน');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) msgs.push('เบราว์เซอร์นี้เปิดกล้องไม่ได้');
  const ua = navigator.userAgent;
  if (/FBAN|FBAV|Line\/|Instagram/i.test(ua)) msgs.push('ดูเหมือนเปิดในแอป LINE/Facebook — ถ้ากล้องไม่ทำงาน ให้เปิดลิงก์ใน Safari หรือ Chrome');
  if (msgs.length) {
    el.envWarn.innerHTML = msgs.map((m) => '• ' + m).join('<br>');
    el.envWarn.hidden = false;
  }
  return msgs;
}

async function startCamera() {
  el.btnStart.disabled = true;
  // ต้องขอสิทธิ์เซนเซอร์ใน handler ของการแตะ (iOS) — ก่อน await อื่นใด
  const perm = await requestPermission();
  sensors.start();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1440 },
      },
    });
  } catch (err) {
    el.btnStart.disabled = false;
    const msg =
      err.name === 'NotAllowedError'
        ? 'ไม่ได้รับอนุญาตให้ใช้กล้อง — เปิดสิทธิ์ในการตั้งค่าเบราว์เซอร์แล้วลองใหม่'
        : 'เปิดกล้องไม่สำเร็จ: ' + err.message;
    el.envWarn.textContent = msg;
    el.envWarn.hidden = false;
    return;
  }
  el.video.srcObject = stream;
  await el.video.play().catch(() => {});

  const name = el.roomName.value.trim() || 'ห้องใหม่';
  let room = state.room;
  if (!room) room = store.createRoom(name);
  else room.name = name;
  room.capture = {
    started: new Date().toISOString(),
    device: navigator.userAgent,
    sensors: perm,
    track: stream.getVideoTracks()[0].getSettings(),
  };
  store.saveRoom(room);
  history.replaceState(null, '', '?room=' + room.id);

  if (perm.orientation !== 'granted') toast('ไม่ได้รับสิทธิ์เซนเซอร์ — ระบบจะไม่แนะนำมุมก้ม/เงย', 4000);

  setState({ screen: 'capturing', room });
  analyzeTimer = setInterval(analyzeLive, 200);
}

function stopCamera() {
  clearInterval(analyzeTimer);
  analyzeTimer = null;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

/* ======================================================================
 * วิเคราะห์เฟรมสด
 * ==================================================================== */
function grabSmall() {
  const v = el.video;
  if (!v.videoWidth) return null;
  const k = ANALYSIS_LONG_SIDE / Math.max(v.videoWidth, v.videoHeight);
  const w = Math.round(v.videoWidth * k);
  const h = Math.round(v.videoHeight * k);
  if (small.width !== w || small.height !== h) {
    small.width = w;
    small.height = h;
  }
  smallCtx.drawImage(v, 0, 0, w, h);
  return { data: smallCtx.getImageData(0, 0, w, h).data, w, h };
}

function analyzeLive() {
  if (state.screen !== 'capturing') return;
  const f = grabSmall();
  if (!f) return;
  const m = Q.analyzeFrame(f.data, f.w, f.h);
  sharpRef.push(m.sharpness);

  // overlap ใช้ CPU มากกว่า — ทำแบบไม่ซ้อนกันและเฉพาะเมื่อขนาดภาพเท่ากัน
  if (lastGrad && lastGrad.w === m.w && lastGrad.h === m.h && !overlapBusy) {
    overlapBusy = true;
    const r = Q.estimateShift(lastGrad.mag, m.grad, m.w, m.h);
    // ค่า NCC ต่ำ = จับคู่ไม่ได้เลย → ถือว่าซ้อนทับน้อย
    state.overlap = r.score > 0.25 ? r.overlap : 0;
    overlapBusy = false;
  }

  const assessment = Q.assess(m, {
    sharpRef: sharpRef.value(),
    rotRate: sensors.hasMotion ? sensors.rotRate : null,
    overlap: lastGrad ? state.overlap : null,
  });
  state.live = m;
  state.assessment = assessment;
  renderLive();
}

/* ======================================================================
 * ถ่ายภาพ
 * ==================================================================== */
function pitchStatus() {
  const target = SHOTS[state.shotInStation].pitch;
  if (!sensors.dir) return { ok: true, known: false };
  const p = sensors.dir.pitch;
  return { ok: p >= target[0] && p <= target[1], known: true, pitch: p, target };
}

async function takeShot() {
  const a = state.assessment;
  const blocking = a.issues.filter((i) => i.level === 'fail');
  if (blocking.length) {
    if (navigator.vibrate) navigator.vibrate([40, 60, 40]);
    toast(blocking[0].msg);
    return;
  }
  const v = el.video;
  if (!v.videoWidth) return;

  // คำเตือน "หมุนตัวอยู่กับที่": เริ่มจุดใหม่โดยไม่มีการก้าวเลย
  const stepsSince = sensors.steps - state.stepsAtLastStation;
  const newStation = state.shotInStation === 0 && state.station > 0;
  const noStep = newStation && sensors.hasMotion && stepsSince === 0;

  const canvas = document.createElement('canvas');
  canvas.width = v.videoWidth;
  canvas.height = v.videoHeight;
  canvas.getContext('2d').drawImage(v, 0, 0);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));

  const m = state.live;
  const meta = Object.assign(
    {
      t: Date.now(),
      wall: WALLS[state.wall],
      station: state.station,
      shot: SHOTS[state.shotInStation].key,
      width: v.videoWidth,
      height: v.videoHeight,
      sharpness: m ? +m.sharpness.toFixed(1) : null,
      luma: m ? +m.luma.mean.toFixed(1) : null,
      texture: m ? +m.texture.toFixed(2) : null,
      overlapPrev: lastGrad && state.overlap != null ? +state.overlap.toFixed(2) : null,
      stepsSincePrevStation: newStation ? stepsSince : null,
      quality: a.level,
      issues: a.issues.map((i) => i.code).concat(noStep ? ['no-step'] : []),
    },
    sensors.snapshot()
  );
  const id = state.room.id + '-' + meta.t;
  await store.addShot({ id, roomId: state.room.id, blob, meta });

  lastGrad = m ? { mag: m.grad, w: m.w, h: m.h } : null;
  state.overlap = null;

  el.flash.classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() => el.flash.classList.remove('on')));
  if (navigator.vibrate) navigator.vibrate(15);

  const shots = state.shots.concat([{ id, url: URL.createObjectURL(blob), meta }]);
  let { station, shotInStation } = state;
  if (shotInStation === 0) {
    shotInStation = 1;
  } else {
    shotInStation = 0;
    station += 1;
    state.stepsAtLastStation = sensors.steps;
  }
  if (noStep) toast('ดูเหมือนยังไม่ได้ก้าว — ก้าวไปด้านข้างครึ่งก้าวระหว่างจุด ระบบจึงคำนวณระยะได้', 4500);
  setState({ shots, station, shotInStation });
}

function nextWall() {
  if (state.station < MIN_STATIONS_PER_WALL) {
    toast(`ผนังนี้ควรมีอย่างน้อย ${MIN_STATIONS_PER_WALL} จุด (ตอนนี้ ${state.station})`);
    return;
  }
  if (state.wall >= WALLS.length - 1) {
    openReview();
    return;
  }
  setState({ wall: state.wall + 1, station: 0, shotInStation: 0 });
  toast(`เลี้ยวที่มุมห้อง แล้วเริ่มผนัง ${WALLS[state.wall]} — ถ่ายมุมห้องให้ซ้อนกับภาพก่อนหน้า`, 3500);
}

/* ======================================================================
 * ตรวจภาพ / วัดระยะ / สรุป
 * ==================================================================== */
function coverageCounts(shots) {
  const c = new Array(SECTORS).fill(0);
  const ref = shots.find((s) => s.meta.heading != null);
  shots.forEach((s) => {
    if (s.meta.heading == null || !ref) return;
    const rel = (s.meta.heading - ref.meta.heading + 360) % 360;
    c[Math.floor(rel / (360 / SECTORS)) % SECTORS]++;
  });
  return c;
}

function captureSummary() {
  const shots = state.shots;
  const n = shots.length;
  const bad = shots.filter((s) => s.meta.quality !== 'ok').length;
  const cov = coverageCounts(shots);
  const known = shots.some((s) => s.meta.heading != null);
  const covered = cov.filter((v) => v >= 2).length;
  const perWall = WALLS.map((w) => new Set(shots.filter((s) => s.meta.wall === w).map((s) => s.meta.station)).size);
  const noStep = shots.filter((s) => s.meta.issues.includes('no-step')).length;
  const advice = [];
  if (n < 24) advice.push(`มี ${n} ภาพ — แนะนำอย่างน้อย 24 ภาพ (4 ผนัง × 3 จุด × 2 ภาพ)`);
  perWall.forEach((k, i) => {
    if (k < MIN_STATIONS_PER_WALL) advice.push(`ผนัง ${WALLS[i]} มี ${k} จุด — ควรมีอย่างน้อย ${MIN_STATIONS_PER_WALL}`);
  });
  if (known && covered < SECTORS - 1) advice.push(`ภาพครอบคลุม ${covered}/${SECTORS} ทิศ — ยังมีบางทิศที่ถ่ายน้อย`);
  if (bad > n * 0.2) advice.push(`${bad} ภาพมีคำเตือนคุณภาพ — ลองลบและถ่ายใหม่`);
  if (noStep) advice.push(`${noStep} จุดดูเหมือนไม่ได้ก้าว — การหมุนอยู่กับที่ทำให้คำนวณระยะไม่ได้`);
  return { n, bad, covered, known, perWall, advice };
}

async function openReview() {
  setState({ screen: 'review' });
}

async function deleteShot(id) {
  await store.removeShot(id);
  const s = state.shots.find((x) => x.id === id);
  if (s) URL.revokeObjectURL(s.url);
  setState({ shots: state.shots.filter((x) => x.id !== id) });
}

function readRef(kindEl, valEl) {
  const kind = kindEl.value;
  const v = parseFloat(valEl.value);
  if (!kind || !(v > 0)) return null;
  return kind === 'height' ? { kind: 'height', measured: v } : { kind: 'wall', wall: +kind.split(':')[1], measured: v };
}

function finishMeasure() {
  const refs = [readRef(el.ref1Kind, el.ref1Val), readRef(el.ref2Kind, el.ref2Val)].filter(Boolean);
  const warns = [];
  if (!refs.length) warns.push('ต้องมีระยะอ้างอิงอย่างน้อย 1 จุด ไม่เช่นนั้นแปลนจะไม่มีสเกลจริง');
  refs.forEach((r) => {
    if (r.kind === 'height' && (r.measured < 2.0 || r.measured > 4.5)) warns.push(`ความสูง ${r.measured} ม. ผิดปกติ — ตรวจหน่วย (เมตร)`);
    if (r.kind === 'wall' && (r.measured < 0.8 || r.measured > 15)) warns.push(`ผนังยาว ${r.measured} ม. ผิดปกติ — ตรวจหน่วย (เมตร)`);
  });
  if (refs.length === 2 && refs[0].kind === refs[1].kind && refs[0].wall === refs[1].wall) warns.push('จุดที่ 1 และ 2 เป็นระยะเดียวกัน — ควรวัดคนละผนังเพื่อใช้ตรวจสอบกัน');
  if (warns.length) {
    el.measureWarn.innerHTML = warns.map((w) => '• ' + w).join('<br>');
    el.measureWarn.hidden = false;
    if (!refs.length) return;
  }
  const h = parseFloat(el.heightVal.value);
  state.room.references = refs;
  state.room.measuredHeight = h > 0 ? h : null;
  state.room.tool = el.tool.value;
  store.saveRoom(state.room);
  setState({ screen: 'done' });
}

function manualPlan() {
  const refs = state.room.references || [];
  const a = refs.find((r) => r.kind === 'wall' && r.wall === 0);
  const b = refs.find((r) => r.kind === 'wall' && r.wall === 1);
  if (!a || !b) {
    toast('ต้องวัดทั้งผนัง A และผนัง B จึงจะสร้างแปลนสี่เหลี่ยมได้', 3500);
    return;
  }
  const plan = createRectPlan(a.measured, b.measured, state.room.measuredHeight || 2.6, state.room.name);
  plan.references = refs;
  state.room.plan = plan;
  store.saveRoom(state.room);
  location.href = 'editor.html?room=' + state.room.id;
}

function downloadManifest() {
  const manifest = {
    format: 'roomscan.capture-manifest/v1',
    room: { id: state.room.id, name: state.room.name },
    capture: state.room.capture,
    references: state.room.references,
    measuredHeight: state.room.measuredHeight,
    tool: state.room.tool,
    shots: state.shots.map((s) => Object.assign({ id: s.id }, s.meta)),
  };
  const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `capture-manifest-${state.room.id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function wipe() {
  if (!confirm('ลบภาพทั้งหมดของห้องนี้ออกจากเครื่อง? (กู้คืนไม่ได้)')) return;
  await store.deleteShots(state.room.id);
  state.shots.forEach((s) => URL.revokeObjectURL(s.url));
  setState({ shots: [] });
  toast('ลบภาพแล้ว');
}

/* ======================================================================
 * วาดหน้าจอ
 * ==================================================================== */
function meter(node, level, value) {
  node.className = 'meter ' + level;
  node.querySelector('b').textContent = value;
}

function renderLive() {
  const m = state.live;
  const a = state.assessment;
  if (!m) return;
  const T = Q.THRESHOLDS;
  const has = (code) => a.issues.find((i) => i.code === code);
  meter(el.mSharp, has('blur') ? has('blur').level : 'ok', Math.round(m.sharpness));
  meter(el.mLight, has('dark') ? 'fail' : has('bright') ? 'warn' : 'ok', Math.round(m.luma.mean));
  meter(el.mTexture, m.texture < T.textureMin ? 'warn' : 'ok', m.texture.toFixed(1));
  if (lastGrad && state.overlap != null) {
    const lvl = has('overlap-low') || has('overlap-high') ? 'warn' : 'ok';
    meter(el.mOverlap, lvl, Math.round(state.overlap * 100) + '%');
  } else {
    meter(el.mOverlap, '', '–');
  }

  // มุมก้ม/เงย
  const ps = pitchStatus();
  el.pitchGuide.hidden = !ps.known;
  if (ps.known) {
    const toY = (p) => 50 - (Math.max(-45, Math.min(45, p)) / 45) * 50; // % จากบน
    el.pitchTarget.style.top = toY(ps.target[1]) + '%';
    el.pitchTarget.style.height = toY(ps.target[0]) - toY(ps.target[1]) + '%';
    el.pitchDot.style.top = toY(ps.pitch) + '%';
    el.pitchDot.style.background = ps.ok ? 'var(--ok)' : '#fff';
  }

  // ข้อความแนะนำ: ปัญหาร้ายแรงก่อน แล้วค่อยมุมกล้อง
  const fail = a.issues.find((i) => i.level === 'fail');
  const warn = a.issues.find((i) => i.level === 'warn');
  let hint = '';
  let cls = 'ok';
  if (fail) {
    hint = fail.msg;
    cls = 'fail';
  } else if (ps.known && !ps.ok) {
    hint = SHOTS[state.shotInStation].hint;
    cls = 'warn';
  } else if (warn) {
    hint = warn.msg;
    cls = 'warn';
  } else {
    hint = 'พร้อมถ่าย';
  }
  el.hint.textContent = hint;
  el.hint.className = 'hint ' + cls;
  el.shutter.className = 'shutter ' + (fail ? 'blocked' : !warn && (ps.ok || !ps.known) ? 'ready' : '');
}

function coverageSVG(counts) {
  const R = 26;
  const r = 15;
  const c = 30;
  const segs = counts
    .map((v, i) => {
      const a0 = ((i / SECTORS) * 360 - 90 - 13) * (Math.PI / 180);
      const a1 = (((i + 1) / SECTORS) * 360 - 90 - 17) * (Math.PI / 180);
      const p = (rad, a) => `${(c + rad * Math.cos(a)).toFixed(1)},${(c + rad * Math.sin(a)).toFixed(1)}`;
      const color = v >= 2 ? 'var(--ok)' : v === 1 ? 'var(--warn)' : 'rgba(255,255,255,0.18)';
      return `<path d="M${p(R, a0)} A${R},${R} 0 0 1 ${p(R, a1)} L${p(r, a1)} A${r},${r} 0 0 0 ${p(r, a0)} Z" fill="${color}"/>`;
    })
    .join('');
  return `<svg width="60" height="60" viewBox="0 0 60 60" aria-label="ความครอบคลุม">${segs}</svg>`;
}

function render() {
  el.scrIntro.hidden = state.screen !== 'intro';
  el.cam.hidden = state.screen !== 'capturing';
  el.scrReview.hidden = state.screen !== 'review';
  el.scrMeasure.hidden = state.screen !== 'measure';
  el.scrDone.hidden = state.screen !== 'done';

  if (state.screen === 'capturing') {
    const shot = SHOTS[state.shotInStation];
    el.stepCard.innerHTML =
      `<strong>ผนัง ${WALLS[state.wall]}</strong> · จุดที่ ${state.station + 1} · ภาพ${shot.label} (${state.shotInStation + 1}/2)<br>` +
      `<span class="muted">${state.shotInStation === 0 && state.station > 0 ? 'ก้าวไปด้านข้างครึ่งก้าวแล้ว' : ''}${shot.hint} · มองทางเดินเป็นระยะ</span>`;
    el.shotCount.textContent = state.shots.length;
    el.coverage.innerHTML = coverageSVG(coverageCounts(state.shots));
    el.btnNextWall.textContent = state.wall < WALLS.length - 1 ? `ถึงมุมห้องแล้ว → ผนัง ${WALLS[state.wall + 1]}` : 'ครบ 4 ผนังแล้ว → ตรวจภาพ';
  }

  if (state.screen === 'review') {
    const s = captureSummary();
    el.reviewTitle.textContent = `${state.room ? state.room.name : ''} · ${s.n} ภาพ`;
    el.reviewStats.innerHTML = [
      [s.n, 'ภาพทั้งหมด'],
      [s.n - s.bad, 'ผ่านเกณฑ์คุณภาพ'],
      [s.known ? `${s.covered}/${SECTORS}` : 'ไม่ทราบ', 'ทิศที่ครอบคลุม'],
      [s.perWall.join(' / '), 'จุดต่อผนัง A/B/C/D'],
    ]
      .map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`)
      .join('');
    el.reviewAdvice.hidden = !s.advice.length;
    el.reviewAdvice.innerHTML = '<b>ควรถ่ายเพิ่ม</b><ul>' + s.advice.map((a) => `<li>${a}</li>`).join('') + '</ul>';
    el.thumbs.innerHTML = state.shots
      .map(
        (x) =>
          `<div class="thumb ${x.meta.quality === 'ok' ? '' : x.meta.quality}"><img src="${x.url}" alt="ภาพผนัง ${x.meta.wall}" loading="lazy">` +
          `<span class="tag">${x.meta.wall}${x.meta.station + 1}·${x.meta.shot === 'low' ? 'ก้ม' : 'เงย'}</span>` +
          `<button data-del="${x.id}" aria-label="ลบภาพ">×</button></div>`
      )
      .join('');
    el.btnToMeasure.disabled = s.n < 6;
  }

  if (state.screen === 'done') {
    const s = captureSummary();
    const refs = (state.room.references || [])
      .map((r) => (r.kind === 'height' ? `ความสูง ${r.measured} ม.` : `ผนัง ${WALLS[r.wall]} ${r.measured} ม.`))
      .join(', ');
    el.doneSummary.innerHTML =
      `<dl class="kv"><dt>ห้อง</dt><dd>${state.room.name}</dd><dt>ภาพ</dt><dd>${s.n} (ผ่าน ${s.n - s.bad})</dd>` +
      `<dt>ระยะอ้างอิง</dt><dd>${refs || '-'}</dd><dt>เครื่องมือวัด</dt><dd>${{ laser: 'เลเซอร์', tape: 'ตลับเมตร', other: 'อื่น ๆ' }[state.room.tool] || '-'}</dd></dl>` +
      (s.advice.length ? `<div class="notice">${s.advice.map((a) => '• ' + a).join('<br>')}</div>` : '') +
      `<div class="notice info">ภาพยังอยู่ในเครื่องนี้เท่านั้น ระบบจริงจะลบภาพต้นฉบับอัตโนมัติหลังประมวลผลเสร็จตามระยะเวลาที่แจ้งไว้</div>`;
  }
}

/* ======================================================================
 * Boot
 * ==================================================================== */
async function boot() {
  [
    'cam', 'video', 'flash', 'stepCard', 'mSharp', 'mLight', 'mTexture', 'mOverlap', 'pitchGuide', 'pitchTarget',
    'pitchDot', 'hint', 'coverage', 'shutter', 'shotCount', 'btnNextWall', 'btnReview', 'scrIntro', 'roomName',
    'envWarn', 'btnStart', 'scrReview', 'reviewTitle', 'reviewStats', 'reviewAdvice', 'thumbs', 'btnBackToCam',
    'btnToMeasure', 'scrMeasure', 'ref1Kind', 'ref1Val', 'ref2Kind', 'ref2Val', 'heightVal', 'tool', 'measureWarn',
    'btnBackToReview', 'btnFinish', 'scrDone', 'doneSummary', 'btnManualPlan', 'btnManifest', 'btnWipe', 'toast',
  ].forEach((id) => (el[id] = $(id)));

  checkEnvironment();

  // กลับมาถ่ายห้องเดิมต่อได้ (?room=...)
  const id = new URLSearchParams(location.search).get('room');
  if (id) {
    const room = store.getRoom(id);
    if (room) {
      state.room = room;
      el.roomName.value = room.name;
      try {
        const rows = await store.listShots(room.id);
        state.shots = rows.map((r) => ({ id: r.id, url: URL.createObjectURL(r.blob), meta: r.meta }));
        const last = rows[rows.length - 1];
        if (last) {
          state.wall = Math.max(0, WALLS.indexOf(last.meta.wall));
          state.station = last.meta.station + (last.meta.shot === 'high' ? 1 : 0);
          state.shotInStation = last.meta.shot === 'low' ? 1 : 0;
        }
      } catch (err) {
        console.warn(err);
      }
    }
  }

  el.btnStart.addEventListener('click', startCamera);
  el.shutter.addEventListener('click', takeShot);
  el.btnNextWall.addEventListener('click', nextWall);
  el.btnReview.addEventListener('click', openReview);
  el.btnBackToCam.addEventListener('click', () => {
    if (!stream) setState({ screen: 'intro' });
    else setState({ screen: 'capturing' });
  });
  el.btnToMeasure.addEventListener('click', () => {
    stopCamera();
    setState({ screen: 'measure' });
  });
  el.thumbs.addEventListener('click', (e) => {
    const id2 = e.target.getAttribute('data-del');
    if (id2) deleteShot(id2);
  });
  el.btnBackToReview.addEventListener('click', () => setState({ screen: 'review' }));
  el.btnFinish.addEventListener('click', finishMeasure);
  el.btnManualPlan.addEventListener('click', manualPlan);
  el.btnManifest.addEventListener('click', downloadManifest);
  el.btnWipe.addEventListener('click', wipe);
  document.addEventListener('visibilitychange', () => {
    // ปิดกล้องเมื่อสลับแอป — ประหยัดแบตและไม่เปิดกล้องค้างโดยผู้ใช้ไม่รู้
    if (document.hidden && stream) {
      stopCamera();
      setState({ screen: state.shots.length ? 'review' : 'intro' });
      el.btnStart.disabled = false;
    }
  });
  render();
}

boot();
