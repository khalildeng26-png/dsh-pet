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
function createWindowPerch({ petWindows, helperDir, platform, origin, petRoute }) {
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

  // [khalil] 诊断:内部状态透出(探针 /debug 可读)
  const dbg = { perched: null, rects: 0, applied: 0, lastRect: null, lastApply: null, errors: [] };

  function stopTracker() {
    if (tracker) { tracker.kill(); tracker = null; }
  }

  /** 随机漫游开关:趴窗时必须关掉,否则渲染端每帧的位置会把钉位顶掉 */
  async function setFixed(petId, on) {
    // 走 PUT /config(pet-config 不收 main 条目);整体 try/catch 绝不炸主流程
    try {
      const base = (origin || 'http://127.0.0.1:3080') + petRoute;
      const cfg = await (await fetch(base + '/config')).json();
      const cur = (cfg?.main ?? cfg)?.pets?.find((p) => p.id === petId); if (cur && cur.fixedEnabled === on) { console.error(`[dsh-pet perch] fixedEnabled 已是 ${on},跳过写入`); return; }
      const ent = cfg?.main ?? cfg;
      const WHITELIST = ['pets','voiceEnabled','voiceName','voiceVolume','whisperPrompt','font','physics','confineToScreen','clickSoundEnabled','notificationsEnabled','chatMemoryRounds','whisperImageEnabled','chatImageEnabled','chatAnimationEnabled','chatImageLimit'];
      const out = {};
      for (const k of WHITELIST) if (k in ent) out[k] = ent[k];
      out.pets = (ent.pets || []).map((p) => (p.id === petId ? { ...p, fixedEnabled: on } : p));
      await fetch(base + '/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out) });
      console.error(`[dsh-pet perch] ${petId} fixedEnabled=${on}`);
    } catch (e) {
      console.error(`[dsh-pet perch] setFixed 失败: ${String(e)}`);
    }
  }

  function detach(reason) {
    if (!perchedPet) return;
    console.error(`[dsh-pet perch] 脱钩(${reason})`);
    setFixed(perchedPet, false);
    clearState();
    stopTracker();
    perchedPet = null;
  }

  /** A·趴窗口:挂在 hwnd 窗口顶边跟随 */
  // [khalil] 趴窗状态落盘:PUT /config 会触发助手重启,重启后凭标记自动重新趴
  const stateFile = require('node:path').join(require('node:os').homedir(), '.dsh', 'dsh-pet', 'perch-state.json');
  function writeState(petId, hwnd) { try { require('node:fs').writeFileSync(stateFile, JSON.stringify({ petId, hwnd })); } catch (e) {} }
  function clearState() { try { require('node:fs').rmSync(stateFile, { force: true }); } catch (e) {} }

  function perch(petId, hwndIn) {
    if (perchedPet === petId) { detach('再点取消'); return 'off'; }
    if (perchedPet) detach('换目标');
    let fg = null;
    const fgRows = psOnce(['fg']);
    const fgd = fgRows.length ? JSON.parse(fgRows[0]) : null;
    if (fgd && !fgd.dead && fgd.usable) fg = fgd;
    if (!fg) {
      // 前台不可趴(最大化/桌面):回落到 list 里面积最大的可趴窗口
      const rows = psOnce(['list']).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
      rows.sort((a, b) => (b.w * b.h) - (a.w * a.h));
      fg = rows.find((r) => !/Program Manager|Text Input/i.test(r.title)) || null;
      if (!fg) return 'no-window';
    }
    const win = petWindows.state.windows.get(petId);
    if (!win || win.isDestroyed()) return 'no-pet';
    // 记录趴点:取宠物当前 x 相对窗口宽度的比例( clamp 到 0.1~0.7 )
    const b = win.getContentBounds();
    relX = hwndIn ? 0.3 : Math.max(0.1, Math.min(0.7, (b.x + b.width / 2 - fg.x) / Math.max(1, fg.w)));
    perchedPet = petId;
    console.error(`[dsh-pet perch] ${petId} 趴上 ${fg.title.slice(0, 24)} (relX=${relX.toFixed(2)})`);
    dbg.perched = petId; dbg.rects = 0; dbg.applied = 0; dbg.errors = [];
    tracker = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, 'track', String(fg.hwnd)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    dbg.trackerPid = () => (tracker ? tracker.pid : null);
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
        dbg.rects += 1; dbg.lastRect = { x: rect.x, y: rect.y, w: rect.w };
        if (rect.dead) { detach('窗口没了/最大化'); return; }
        const w = petWindows.state.windows.get(perchedPet);
        if (!w || w.isDestroyed()) { detach('宠物没了'); return; }
        // 被拖拽/开菜单 = 主人把她摘下来
        if (petWindows.state.inputBusy.get(w.id) === true) { detach('主人拖拽'); return; }
        // 钉到窗口顶边:宠物窗底边贴窗口顶 + 8px 重叠(踩在标题栏上)
        const b2 = w.getContentBounds();
        const nx = Math.round(rect.x + rect.w * relX - b2.width / 2);
        // 钳制:窗口顶着屏幕顶时,至少保留 65% 身体在屏内(否则"趴上去"=飞出屏幕像没反应)
        const rawNy = rect.y - b2.height + Math.round(b2.height * 0.08);
        const ny = Math.max(rawNy, -Math.round(b2.height * 0.35)); // 最多探出屏幕顶 35%
        try { w.setContentBounds({ x: nx, y: ny, width: b2.width, height: b2.height }, false); dbg.applied += 1; dbg.lastApply = { nx, ny }; } catch (e) { dbg.errors.push('setContentBounds: ' + e.message); }
        try { const rb = w.getContentBounds(); dbg.actual = { x: rb.x, y: rb.y }; } catch (e) {}
        w.setContentBounds({ x: nx, y: ny, width: b2.width, height: b2.height }, false);
      }
    });
    tracker.on('exit', () => { if (perchedPet) detach('tracker 退出'); });
    void setFixed(petId, true); // 压住随机漫游(异步,失败不影响趴)
    writeState(petId, fg.hwnd);
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

  reattach: (petId, hwnd) => perch(petId, hwnd),
  /** 重启后凭落盘状态自动重新趴(不再写配置,fixed 已是 true) */
  function reattach(petId, hwnd) { return perch(petId, hwnd); }

  return { perch, pushNearby, isPerched: () => !!perchedPet, debug: () => ({ ...dbg, trackerPid: tracker ? tracker.pid : null, perchedPet }) };
}

module.exports = { createWindowPerch };
