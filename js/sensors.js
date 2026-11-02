/**
 * sensors.js — อ่านเซนเซอร์ทิศทาง/การเคลื่อนไหวของมือถือ
 *
 * ใช้ทำ 3 อย่าง:
 *   1. มุมก้ม/เงยของกล้อง → นำทางให้ถ่ายเห็นรอยต่อพื้น-ผนังและเพดาน-ผนัง
 *   2. ทิศที่กล้องหัน (heading) → วงแหวนความครอบคลุม 360°
 *   3. นับก้าวแบบหยาบระหว่างภาพ → เตือนเมื่อผู้ใช้ "หมุนตัวอยู่กับที่"
 *      (SfM ต้องการระยะห่างระหว่างตำแหน่งถ่าย — COLMAP tutorial)
 *   และบันทึกเวกเตอร์แรงโน้มถ่วงไว้กับทุกภาพ เพื่อให้ backend หาทิศ "ขึ้น" ได้แม่นขึ้น
 *
 * iOS: ต้องเรียก DeviceOrientationEvent.requestPermission() จากการแตะปุ่มเท่านั้น
 * heading บน iOS เป็นค่าสัมพัทธ์ (ไม่อิงทิศเหนือ) ซึ่งเพียงพอสำหรับวัดความครอบคลุม
 */

const DEG = Math.PI / 180;

/**
 * ทิศที่กล้องหลังหัน จากมุม alpha/beta/gamma (W3C DeviceOrientation, ลำดับ Z-X'-Y'')
 * คำนวณผ่านเมทริกซ์หมุนแทนการใช้มุมตรง ๆ เพราะเมื่อถือมือถือตั้งตรง (beta≈90°)
 * มุมออยเลอร์จะเกิด gimbal lock ทำให้ alpha กระโดด
 * คืน { heading: 0–360 (องศา), pitch: -90–90 (บวก = เงย) }
 */
export function cameraDirection(alpha, beta, gamma) {
  const a = (alpha || 0) * DEG;
  const b = (beta || 0) * DEG;
  const g = (gamma || 0) * DEG;
  const cA = Math.cos(a);
  const sA = Math.sin(a);
  const cB = Math.cos(b);
  const sB = Math.sin(b);
  const cG = Math.cos(g);
  const sG = Math.sin(g);
  // กล้องหลังมองไปทาง -z ของตัวเครื่อง → fwd = -(คอลัมน์ที่ 3 ของ R)
  const fx = -(cA * sG + cG * sA * sB);
  const fy = -(sA * sG - cA * cG * sB);
  const fz = -(cB * cG);
  let heading = Math.atan2(fx, fy) / DEG;
  if (heading < 0) heading += 360;
  const pitch = Math.asin(Math.max(-1, Math.min(1, fz))) / DEG;
  return { heading, pitch };
}

export function needsPermission() {
  return (
    typeof DeviceOrientationEvent !== 'undefined' &&
    typeof DeviceOrientationEvent.requestPermission === 'function'
  );
}

/** ต้องเรียกจาก event handler ของการแตะ (transient activation) */
export async function requestPermission() {
  const out = { orientation: 'unsupported', motion: 'unsupported' };
  try {
    if (typeof DeviceOrientationEvent !== 'undefined') {
      out.orientation =
        typeof DeviceOrientationEvent.requestPermission === 'function'
          ? await DeviceOrientationEvent.requestPermission()
          : 'granted';
    }
    if (typeof DeviceMotionEvent !== 'undefined') {
      out.motion =
        typeof DeviceMotionEvent.requestPermission === 'function'
          ? await DeviceMotionEvent.requestPermission()
          : 'granted';
    }
  } catch (err) {
    out.error = err.message;
  }
  return out;
}

/**
 * ตัวอ่านเซนเซอร์ — เก็บค่าล่าสุดไว้ให้ UI ดึงไปใช้ทุกเฟรม
 */
export class SensorHub {
  constructor() {
    this.dir = null; // { heading, pitch }
    this.roll = null;
    this.gravity = null; // [x,y,z] พิกัดตัวเครื่อง (m/s²)
    this.rotRate = 0; // องศา/วินาที
    this.steps = 0;
    this.hasOrientation = false;
    this.hasMotion = false;
    this._accLP = 9.81;
    this._lastStep = 0;
    this._above = false;
    this._onOrient = this._onOrient.bind(this);
    this._onMotion = this._onMotion.bind(this);
  }

  start() {
    window.addEventListener('deviceorientation', this._onOrient);
    window.addEventListener('devicemotion', this._onMotion);
  }

  stop() {
    window.removeEventListener('deviceorientation', this._onOrient);
    window.removeEventListener('devicemotion', this._onMotion);
  }

  _onOrient(e) {
    if (e.alpha == null && e.beta == null) return;
    this.hasOrientation = true;
    // iOS ให้ทิศเข็มทิศจริงผ่าน webkitCompassHeading — ใช้ถ้ามี (ช่วยเทียบหลายรอบการถ่าย)
    this.dir = cameraDirection(e.alpha, e.beta, e.gamma);
    this.roll = e.gamma;
  }

  _onMotion(e) {
    const ag = e.accelerationIncludingGravity;
    if (ag && ag.x != null) {
      this.hasMotion = true;
      this.gravity = [ag.x, ag.y, ag.z];
      // ตัวนับก้าวอย่างง่าย: ขนาดความเร่งรวม (low-pass) ข้ามเกณฑ์ขึ้น-ลง
      const mag = Math.hypot(ag.x, ag.y, ag.z);
      this._accLP = 0.8 * this._accLP + 0.2 * mag;
      const t = e.timeStamp || performance.now();
      if (!this._above && this._accLP > 11.0 && t - this._lastStep > 350) {
        this._above = true;
        this._lastStep = t;
        this.steps++;
      } else if (this._above && this._accLP < 10.0) {
        this._above = false;
      }
    }
    const r = e.rotationRate;
    if (r && r.alpha != null) {
      this.rotRate = Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0);
    }
  }

  snapshot() {
    return {
      heading: this.dir ? +this.dir.heading.toFixed(1) : null,
      pitch: this.dir ? +this.dir.pitch.toFixed(1) : null,
      roll: this.roll != null ? +this.roll.toFixed(1) : null,
      gravity: this.gravity ? this.gravity.map((v) => +v.toFixed(3)) : null,
      steps: this.steps,
    };
  }
}
