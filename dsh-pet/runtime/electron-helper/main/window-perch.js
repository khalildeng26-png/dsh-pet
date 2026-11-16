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

  let lastSent = null;

  /** 发归一化位置指令(微锁),渲染端执行——主进程不再碰窗口 */
  async function sendPosition(petId, x, y) {
    try {
      const base = (origin || 'http://127.0.0.1:3080') + petRoute;
      const cfg = await (await fetch(base + '/config')).json();
      const p = (cfg?.main ?? cfg)?.pets?.find((s) => s.id === petId);
      const sf = p && p.display && p.display !== 'none' ? p.display : 'both';
      const lk = await (await fetch(base + '/lock?pet=' + petId + '&surface=' + sf, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
      if (!lk || !lk.lockId) return;
      try {
        await fetch(base + '/position?pet=' + petId + '&surface=' + sf + '&lock=' + lk.lockId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ x, y, mode: 'instant' }) });
      } finally {
        await fetch(base + '/lock/release?pet=' + petId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lockId: lk.lockId }) });
      }
    } catch (e) { dbg.errors.push('sendPosition: ' + e.message); }
  }

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
    stopPerchAmbience();
    lastSent = null;
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
    if (fgd && !fgd.dead && fgd.usable && fgd.pid !== process.pid) fg = fgd; // 前台是宠物自己=自趴死循环,禁
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
    dbg.perched = petId; dbg.rects = 0; lastSent = null; dbg.applied = 0; dbg.errors = [];
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
        if (rect.dead) { detach('窗口没了/最大化'); return; }
        if (rect.pid === process.pid) { detach('目标是宠物自己'); return; }
        dbg.rects += 1; dbg.lastRect = { x: rect.x, y: rect.y, w: rect.w };
        const w = petWindows.state.windows.get(perchedPet);
        if (!w || w.isDestroyed()) { detach('宠物没了'); return; }
        if (petWindows.state.inputBusy.get(w.id) === true) { detach('主人拖拽'); return; }
        // [架构修正] 不 setContentBounds 钉窗口(与渲染端位置同步拉锯=卡死);
        // 窗口动了才发 /position 归一化指令,渲染端自己走——单一写入者
        const moved = !lastSent || rect.x !== lastSent.x || rect.y !== lastSent.y || rect.w !== lastSent.w;
        if (moved) {
          lastSent = { x: rect.x, y: rect.y, w: rect.w };
          const b2 = w.getContentBounds();
          const nx = Math.round(rect.x + rect.w * relX - b2.width / 2);
          const rawNy = rect.y - b2.height + Math.round(b2.height * 0.08);
          const ny = Math.max(rawNy, -Math.round(b2.height * 0.35));
          const area = petWindows.geometry ? petWindows.geometry().hull : { width: 1920, height: 1080 };
          const xn = Math.max(-0.2, Math.min(1.2, nx / Math.max(1, area.width)));
          const yn = Math.max(-0.4, Math.min(1.2, ny / Math.max(1, area.height)));
          void sendPosition(perchedPet, xn, yn);
          dbg.applied += 1; dbg.lastApply = { xn: +xn.toFixed(3), yn: +yn.toFixed(3) };
        }
      }
    });;
    tracker.on('exit', () => { if (perchedPet) detach('tracker 退出'); });
    void setFixed(petId, true); // 压住随机漫游(异步,失败不影响趴)
    writeState(petId, fg.hwnd);
    startPerchAmbience(petId);
    return 'on';
  }

  // [khalil] 趴窗氛围:上去行礼,之后定期小动作(让她看起来"趴着陪主人干活")
  let perchTimer = null;
  const PERCH_IDLE_ANIMS = ['悠闲哼歌', '摇扇纳凉', '超大伸懒腰', '东张西望'];

  async function playAnim(petId, name) {
    try {
      const base = (origin || 'http://127.0.0.1:3080') + petRoute;
      const cfg = await (await fetch(base + '/config')).json();
      const p = (cfg?.main ?? cfg)?.pets?.find((x) => x.id === petId);
      const sf = p && p.display && p.display !== 'none' ? p.display : 'both';
      const lk = await (await fetch(base + '/lock?pet=' + petId + '&surface=' + sf, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
      if (!lk || !lk.lockId) return;
      try {
        await fetch(base + '/anim?pet=' + petId + '&surface=' + sf + '&lock=' + lk.lockId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      } finally {
        await fetch(base + '/lock/release?pet=' + petId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lockId: lk.lockId }) });
      }
    } catch (e) { /* 动画失败不影响趴 */ }
  }

  function startPerchAmbience(petId) {
    stopPerchAmbience();
    void playAnim(petId, '女仆屈膝礼仪'); // 上去先行个礼
    perchTimer = setInterval(() => {
      if (!perchedPet) return;
      void playAnim(perchedPet, PERCH_IDLE_ANIMS[Math.floor(Math.random() * PERCH_IDLE_ANIMS.length)]);
    }, 90000 + Math.floor(Math.random() * 30000));
    perchTimer.unref?.();
  }
  function stopPerchAmbience() {
    if (perchTimer) { clearInterval(perchTimer); perchTimer = null; }
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
