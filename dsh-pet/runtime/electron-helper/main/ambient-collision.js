/**
 * 常驻互撞:官方碰撞结算只挂在飞行帧(被扔出去的那只的渲染循环),静止或漫游撞到一起的
 * 两只永远没人结算。本模块在主进程做兜底——碰撞站场(petWindows.state.petStates)本来就
 * 汇聚了每只宠物的包围盒与速度(静止也登记),这里周期扫描「双方都慢」的重叠对,给较小的
 * 那只发一个 pet:hit 小冲量(与飞行碰撞同一通道),让它弹开让位。不改渲染端、不改客户端。
 *
 * 只处理静止-静止:任一方在飞(速度超阈)时交还给官方飞行结算,避免两套物理互相加塞。
 * @module dsh-pet/runtime/electron-helper/main/ambient-collision
 */

/** 与 src/shared/constants.ts 的 HIT_BOX 同源(640×360 画框坐标);改上游要同步这里。 */
const HIT_BOX = { x0: 200, y0: 50, x1: 440, y1: 335 };

/** 身体包围盒(与 src/shared/physics/collide.ts 的 bodyPixelBox 同公式)。 */
function bodyBox(p) {
  const h = (p.size * 9) / 16;
  return {
    left: p.x + (HIT_BOX.x0 / 640) * p.size,
    top: p.y + p.bottomPad + (HIT_BOX.y0 / 360) * h,
    right: p.x + (HIT_BOX.x1 / 640) * p.size,
    bottom: p.y + p.bottomPad + (HIT_BOX.y1 / 360) * h,
  };
}

/** 两矩形相交。 */
function overlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** 质量感速度阈值(px/s):双方都低于它才算「静止重叠」。 */
const SLOW = Number(process.env.DSH_PET_AMBIENT_SLOW ?? 120);
/** 推开水平速度(px/s)。 */
const SPEED = Number(process.env.DSH_PET_AMBIENT_SPEED ?? 300);
/** 上抛分量(px/s,负=向上):小跳一下再落,比平推更有「撞到让位」的感觉。 */
const HOP = Number(process.env.DSH_PET_AMBIENT_HOP ?? -110);
/** 同一对宠物的两次推开之间的冷却(ms):防止重叠帧连环加塞。 */
const COOLDOWN_MS = Number(process.env.DSH_PET_AMBIENT_COOLDOWN ?? 1200);
/** 扫描周期(ms)。 */
const TICK_MS = 180;

/**
 * 宠物 vs 障碍物(如聊天窗):静止宠物压在障碍矩形上 → 沿水平方向推离障碍中心。
 * 返回 { petId, vx, vy } 或 null。
 */
function pickObstacleShove(petStates, obstacle) {
  if (!obstacle) return null;
  const ocx = (obstacle.left + obstacle.right) / 2;
  for (const [id, p] of petStates) {
    if (!p || !(p.size > 0)) continue;
    if (Math.hypot(p.vx || 0, p.vy || 0) > SLOW) continue;
    if (!overlap(bodyBox(p), obstacle)) continue;
    const dir = p.x + p.size / 2 < ocx ? -1 : 1;
    return { petId: id, vx: Math.round(dir * SPEED), vy: HOP };
  }
  return null;
}

/**
 * 扫描站场,找出需要推开的一对;返回 { petId, vx, vy } 或 null。
 * 推较小的那只,沿两身体中心连线向外,方向由被推方相对另一方的位置决定。
 */
function pickAmbientShove(petStates) {
  const ids = [...petStates.keys()];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = petStates.get(ids[i]);
      const b = petStates.get(ids[j]);
      if (!a || !b || !(a.size > 0) || !(b.size > 0)) continue;
      if (Math.hypot(a.vx || 0, a.vy || 0) > SLOW || Math.hypot(b.vx || 0, b.vy || 0) > SLOW) continue;
      if (!overlap(bodyBox(a), bodyBox(b))) continue;
      const acx = a.x + a.size / 2;
      const acy = a.y + (a.size * 9) / 32;
      const bcx = b.x + b.size / 2;
      const bcy = b.y + (b.size * 9) / 32;
      let dx = acx - bcx;
      let dy = acy - bcy;
      const dist = Math.hypot(dx, dy);
      if (dist < 1) {
        dx = 1;
        dy = 0;
      } else {
        dx /= dist;
        dy /= dist;
      }
      const pushA = a.size <= b.size;
      const sgn = pushA ? 1 : -1;
      const petId = pushA ? ids[i] : ids[j];
      return {
        petId,
        vx: Math.round(sgn * dx * SPEED),
        vy: Math.round(Math.min(0, sgn * dy * SPEED * 0.6) + HOP),
      };
    }
  }
  return null;
}

/**
 * 启动常驻碰撞扫描。返回停止函数(测试用;进程内常驻可不接)。
 * 被用户拖拽/交互中的宠物(inputBusy)不推——手里的宠物不该被 pet:hit 打飞。
 * @param {{ petWindows: { state: { petStates: Map<string, object>, windows: Map<string, import('electron').BrowserWindow>, inputBusy: Map<number, boolean> } }, obstacle?: () => ({left,top,right,bottom}|null) }} deps
 */
function startAmbientCollision({ petWindows, obstacle }) {
  const lastShove = new Map();
  /** 该宠物正被用户持有(拖拽/菜单)吗? */
  const isHeld = (petId) => {
    const win = petWindows.state.windows.get(petId);
    return !win || win.isDestroyed() ? true : petWindows.state.inputBusy.get(win.id) === true;
  };
  const timer = setInterval(() => {
    let shove = pickAmbientShove(petWindows.state.petStates);
    if (!shove && obstacle) {
      try {
        shove = pickObstacleShove(petWindows.state.petStates, obstacle());
      } catch (e) {
        shove = null;
      }
    }
    if (!shove) return;
    const now = Date.now();
    if (now - (lastShove.get(shove.petId) || 0) < COOLDOWN_MS) return;
    if (isHeld(shove.petId)) return;
    const win = petWindows.state.windows.get(shove.petId);
    if (!win || win.isDestroyed()) return;
    lastShove.set(shove.petId, now);
    win.webContents.send('pet:hit', { vx: shove.vx, vy: shove.vy });
  }, TICK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = { pickAmbientShove, startAmbientCollision, bodyBox, overlap };
