/**
 * [khalil] 窗口互动:A·趴窗口(挂在指定窗口顶边跟随) + B·推窗口(把旁边窗口推一把)。
 * 眼和手都在 win-helpers.ps1(C# P/Invoke):fg/list/push 一次性调用,track 常驻流式。
 * 趴下时主进程每拍直接 setContentBounds 钉住宠物;被拖拽(inputBusy)或窗口
 * 关闭/最大化时自动脱钩。不碰用户窗口一个像素(推窗口除外——那是用户点的)。
 * @module dsh-pet/runtime/electron-helper/main/window-perch
 */
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

/**
 * @param {{ petWindows: object, helperDir: string, platform: string }} deps
 */
function createWindowPerch({ petWindows, helperDir, platform }) {
  if (platform !== 'win32') return { perch: () => 'unsupported', pushNearby: () => 'unsupported', isPerched: () => false };
  const ps1 = path.join(helperDir, 'main', 'win-helpers.ps1');

  /** 一次性 PS 调用:返回 stdout 行数组 */
  function psOnce(args) {
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, ...args], { timeout: 15000, windowsHide: true });
    if (r.status !== 0) return [];
    return String(r.stdout || '').split('\n').filter((l) => l.trim().startsWith('{'));
  }

  let tracker = null; // 常驻 track 子进程
  let perchedPet = null;
  let relX = 0.3; // 趴在窗口顶边的水平相对位置

  function stopTracker() {
    if (tracker) { tracker.kill(); tracker = null; }
  }

  function detach(reason) {
    if (!perchedPet) return;
    console.error(`[dsh-pet perch] 脱钩(${reason})`);
    stopTracker();
    perchedPet = null;
  }

  /** A·趴窗口:挂在 hwnd 窗口顶边跟随 */
  function perch(petId) {
    if (perchedPet === petId) { detach('再点取消'); return 'off'; }
    if (perchedPet) detach('换目标');
    const fgRows = psOnce(['fg']);
    const fg = fgRows.length ? JSON.parse(fgRows[0]) : null;
    if (!fg || fg.dead || !fg.usable) return 'no-window';
    const win = petWindows.state.windows.get(petId);
    if (!win || win.isDestroyed()) return 'no-pet';
    // 记录趴点:取宠物当前 x 相对窗口宽度的比例( clamp 到 0.1~0.7 )
    const b = win.getContentBounds();
    relX = Math.max(0.1, Math.min(0.7, (b.x + b.width / 2 - fg.x) / Math.max(1, fg.w)));
    perchedPet = petId;
    console.error(`[dsh-pet perch] ${petId} 趴上 ${fg.title.slice(0, 24)} (relX=${relX.toFixed(2)})`);
    tracker = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, 'track', String(fg.hwnd)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    tracker.stdout.on('data', (chunk) => {
      buf += String(chunk);
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('{')) continue;
        let rect;
        try { rect = JSON.parse(line); } catch (e) { continue; }
        if (!perchedPet) return;
        if (rect.dead) { detach('窗口没了/最大化'); return; }
        const w = petWindows.state.windows.get(perchedPet);
        if (!w || w.isDestroyed()) { detach('宠物没了'); return; }
        // 被拖拽/开菜单 = 主人把她摘下来
        if (petWindows.state.inputBusy.get(w.id) === true) { detach('主人拖拽'); return; }
        // 钉到窗口顶边:宠物窗底边贴窗口顶 + 8px 重叠(踩在标题栏上)
        const b2 = w.getContentBounds();
        const nx = Math.round(rect.x + rect.w * relX - b2.width / 2);
        const ny = Math.round(rect.y - b2.height + Math.round(b2.height * 0.08));
        w.setContentBounds({ x: nx, y: ny, width: b2.width, height: b2.height }, false);
      }
    });
    tracker.on('exit', () => { if (perchedPet) detach('tracker 退出'); });
    return 'on';
  }

  /** B·推窗口:找宠物旁边最近的非最大化窗口,推一把(方向=远离宠物) */
  function pushNearby(petId) {
    const win = petWindows.state.windows.get(petId);
    if (!win || win.isDestroyed()) return 'no-pet';
    const b = win.getContentBounds();
    const pcx = b.x + b.width / 2;
    const rows = psOnce(['list']);
    let best = null;
    let bestDist = Infinity;
    for (const line of rows) {
      let r;
      try { r = JSON.parse(line); } catch (e) { continue; }
      // 距离 = 窗口中心到宠物中心的横向距离;太远(>800px)不推
      const cx = r.x + r.w / 2;
      const dist = Math.abs(cx - pcx);
      if (dist > 800 || dist < 24) continue;
      // 跳过桌面(Program Manager)与输入法
      if (/Program Manager|Text Input/i.test(r.title)) continue;
      if (dist < bestDist) { bestDist = dist; best = r; }
    }
    if (!best) return 'no-target';
    const cx = best.x + best.w / 2;
    const dx = (cx > pcx ? 1 : -1) * 90; // 往远离宠物的方向推 90px
    psOnce(['push', String(best.hwnd), String(dx)]);
    console.error(`[dsh-pet perch] ${petId} 推了一把「${best.title.slice(0, 20)}」dx=${dx}`);
    return 'pushed';
  }

  return { perch, pushNearby, isPerched: () => !!perchedPet };
}

module.exports = { createWindowPerch };
