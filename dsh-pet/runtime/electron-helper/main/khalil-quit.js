'use strict';
/**
 * [khalil] DSH 桥接模式下的托盘「退出」：完整关停路径。
 *
 * 上游不在 DSH 形态提供 /quit 能力（desktop.ts issue #178：助手自退会被宿主当崩溃按退避
 * 复活，必须由宿主执行停机；而宿主出于通用性在 DSH 内拒绝代劳）。本 fork 的用户把 dsh web
 * 当宠物专用服务跑，配套的 sidecar/看门狗/自启也都是本 fork 的产物——所以退出按钮由我们
 * 自己把全套关掉：
 *   1. 停看门狗计划任务（否则 ≤10 分钟内全部复活）
 *   2. 杀四件套 sidecar（按脚本名精确匹配 node 进程，绝不误伤其他 node）
 *   3. 停宿主 dsh web（按配置 URL 的端口找 LISTENING 进程）
 *   4. 禁用开机自启（启动文件夹的 vbs 改名 .off；「宠物启动.cmd」或手动改回即可恢复；
 *      没有这些文件的机器——比如上游原版——本步静默跳过）
 *   5. app.quit()（宿主已死，不存在「被当崩溃复活」的问题）
 * 全程 best-effort：任何一步失败都继续走完，最终仍退出本进程。
 * 独立应用模式不走这里（canQuit=true 走上游原生退出，box 子进程随 will-quit 收尾）。
 * @module dsh-pet/runtime/electron-helper/main/khalil-quit
 */
const { execSync } = require('node:child_process');
const { renameSync, existsSync } = require('node:fs');
const { join } = require('node:path');

/** 本 fork 的四件套脚本名（wmic 按命令行精确匹配，跨目录安全）。 */
const SIDECAR_SCRIPTS = ['screen-talk.mjs', 'look-screen.mjs', 'pet-theater.mjs', 'personality-menu.mjs'];
/** 启动文件夹里本 fork 的自启项（改名禁用，可逆）。 */
const AUTOSTART_VBS = ['dsh-pet-autostart.vbs', 'dsh-pet-services.vbs'];
/** 本 fork 的看门狗计划任务名。 */
const WATCHDOG_TASK = 'dsh-pet-watchdog';

/** 静默执行一条命令（失败忽略，超时兜底）。 */
function sh(cmd) {
  try {
    execSync(cmd, { stdio: 'ignore', timeout: 15000, windowsHide: true });
  } catch (e) {
    /* best-effort：关停链上任何一步失败都不该中断后续步骤 */
  }
}

/**
 * 完整关停并退出。
 * @param deps.app - Electron app（最后一步 app.quit()）
 * @param deps.log - 日志函数（缺省 console.log；失败也不影响关停）
 */
function khalilFullStop({ app, log }) {
  const say = (m) => {
    try {
      (log || console.log)('[dsh-pet-desktop-helper] ' + m);
    } catch (e) {
      /* 日志失败不影响关停 */
    }
  };

  // 1) 看门狗：不先停它，10 分钟内一切都会复活
  sh(`schtasks /change /tn "${WATCHDOG_TASK}" /disable`);
  say('退出：看门狗已停（若存在）');

  // 2) sidecar 四件套：按脚本名匹配 node 进程（这些名字是本 fork 专属，不会误伤）
  const like = SIDECAR_SCRIPTS.map((s) => `CommandLine like '%${s}%'`).join(' or ');
  sh(`wmic process where "name='node.exe' and (${like})" call terminate`);
  say('退出：sidecar 已停');

  // 3) 宿主 dsh web：配置 URL 取端口，netstat 找 LISTENING 的 PID（只杀监听者，不碰连接方）
  try {
    const cfgUrl = process.env.DSH_PET_CONFIG_URL || 'http://127.0.0.1:3080/dsh-pet-7340/config';
    const port = new URL(cfgUrl).port || '3080';
    const out = execSync('netstat -ano', { timeout: 15000, windowsHide: true }).toString();
    const pids = new Set();
    for (const line of out.split('\n')) {
      if (line.includes(':' + port) && /LISTENING/i.test(line)) {
        const m = line.trim().match(/(\d+)\s*$/);
        if (m) pids.add(m[1]);
      }
    }
    for (const pid of pids) sh(`taskkill /f /pid ${pid}`);
    say(`退出：宿主已停（端口 ${port}，${pids.size} 个进程）`);
  } catch (e) {
    say('退出：宿主停机探测失败（继续）：' + (e && e.message ? e.message : String(e)));
  }

  // 4) 开机自启禁用（改名可逆；非本 fork 的机器没有这些文件，静默跳过）
  try {
    const startup = join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    for (const name of AUTOSTART_VBS) {
      const from = join(startup, name);
      if (existsSync(from)) renameSync(from, from + '.off');
    }
    say('退出：开机自启已禁用');
  } catch (e) {
    say('退出：自启处理失败（继续）：' + (e && e.message ? e.message : String(e)));
  }

  // 5) 退出自己（宿主已死，不会被当崩溃复活）
  app.quit();
}

module.exports = { khalilFullStop };
