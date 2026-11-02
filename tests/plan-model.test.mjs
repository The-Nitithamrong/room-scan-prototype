// ทดสอบ plan-model.js — รัน: npm test (ในโฟลเดอร์ prototype)
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../js/plan-model.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test('createRectPlan: พื้นที่ เส้นรอบรูป และความถูกต้องของ schema', () => {
  const p = P.createRectPlan(4.2, 3.35, 2.6, 'ห้องนอน');
  assert.deepEqual(P.validatePlan(p), []);
  close(P.area(p), 4.2 * 3.35);
  close(P.perimeter(p), 2 * (4.2 + 3.35));
  assert.ok(P.isRectangle(p));
  assert.ok(P.signedArea(p) > 0, 'มุมต้องเรียงทวนเข็ม');
});

test('setWallLength บนห้องสี่เหลี่ยม: ผนังตรงข้ามเลื่อนตาม ยังเป็นมุมฉาก', () => {
  const p = P.createRectPlan(4, 3, 2.6);
  const q = P.setWallLength(p, 0, 4.5);
  close(P.wallLength(q, 0), 4.5);
  close(P.wallLength(q, 2), 4.5);
  close(P.wallLength(q, 1), 3);
  assert.ok(P.isRectangle(q));
  close(P.wallLength(p, 0), 4, 1e-9); // ของเดิมไม่ถูกแก้
});

test('setWallLength ปฏิเสธค่าที่ไม่ถูกต้อง', () => {
  const p = P.createRectPlan(4, 3, 2.6);
  assert.throws(() => P.setWallLength(p, 0, 0));
  assert.throws(() => P.setWallLength(p, 0, -1));
});

test('scaleToReference: ย่อ/ขยายทั้งแปลนตามสัดส่วน รวมช่องเปิดและความสูง', () => {
  let p = P.createRectPlan(2, 1.5, 1.3); // แปลนจากภาพที่สเกลผิด 2 เท่า
  p.scaled = false;
  p = P.addOpening(p, 0, 'door');
  const q = P.scaleToReference(p, { kind: 'wall', wall: 0, measured: 4 });
  close(P.wallLength(q, 0), 4);
  close(P.wallLength(q, 1), 3);
  close(q.height, 2.6);
  assert.equal(q.scaled, true);
  close(q.openings[0].width, p.openings[0].width * 2, 1e-3);
  assert.equal(q.references.length, 1);
  close(q.references[0].scale, 2);
});

test('checkReference: รายงานความต่างเป็นเปอร์เซ็นต์', () => {
  const p = P.createRectPlan(4, 3, 2.6);
  close(P.checkReference(p, { kind: 'wall', wall: 1, measured: 3 }), 0);
  close(P.checkReference(p, { kind: 'wall', wall: 1, measured: 3.06 }), (100 * (3 - 3.06)) / 3.06);
});

test('addOpening / clampOpenings: ช่องเปิดอยู่ในผนังเสมอ', () => {
  let p = P.createRectPlan(4, 3, 2.6);
  p = P.addOpening(p, 1, 'window');
  const o = p.openings[0];
  close(o.offset + o.width / 2, 1.5, 1e-3); // อยู่กลางผนัง
  p = P.updateOpening(p, 0, { offset: 10 });
  assert.ok(p.openings[0].offset + p.openings[0].width <= P.wallLength(p, 1) + 1e-9);
  p = P.setWallLength(p, 1, 1.0);
  assert.ok(p.openings[0].width <= 1.0 + 1e-9);
});

test('splitWall: เพิ่มมุมและเลื่อน index ช่องเปิดของผนังถัดไป', () => {
  let p = P.createRectPlan(4, 3, 2.6);
  p = P.addOpening(p, 2, 'door');
  const q = P.splitWall(p, 0);
  assert.equal(q.corners.length, 5);
  assert.equal(q.openings[0].wall, 3);
  close(P.area(q), 12);
});

test('validatePlan: จับไฟล์เสีย', () => {
  assert.ok(P.validatePlan(null).length);
  assert.ok(P.validatePlan({ schema: 'x', corners: [[0, 0]] }).length >= 2);
  const p = P.createRectPlan(4, 3, 2.6);
  p.corners[1] = [NaN, 0];
  assert.ok(P.validatePlan(p).length);
});

test('ส่งออก: SVG/DXF/furniture มีข้อมูลครบ', () => {
  let p = P.createRectPlan(4.2, 3.35, 2.6, 'ห้อง <ทดสอบ>');
  p = P.addOpening(p, 0, 'door');
  const svg = P.toSVG(p);
  assert.match(svg, /^<svg/);
  assert.match(svg, /4\.20 ม\./);
  assert.match(svg, /&lt;ทดสอบ&gt;/); // escape ชื่อ
  const dxf = P.toDXF(p);
  assert.equal((dxf.match(/\nLINE\n/g) || []).length, 5); // ผนัง 4 + ประตู 1
  assert.match(dxf, /4200/);
  assert.ok(dxf.trim().endsWith('EOF'));
  const f = P.toFurnitureLayout(p);
  assert.equal(f.walls.length, 4);
  assert.equal(f.openings.length, 1);
  assert.equal(f.openings[0].from.length, 2);
});
