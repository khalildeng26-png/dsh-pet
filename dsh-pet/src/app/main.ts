/**
 * dsh-pet 独立应用主进程：同一个 Electron 进程里装本机 HTTP 服务、插件宿主半侧与桌面 Helper。
 * 只做启动装配与日志落盘：不实现路由（见 router.ts），不实现窗口/托盘/物理（复用桌面 Helper）。
 * 依赖宿主半侧的 apply()、standalone 的配置与安全模块，以及 runtime/electron-helper/main.js。
 * 始终成立：端口先于 Helper 就位（它在 ready 前就要用配置地址），令牌只经请求头与环境变量传递。
 * @module dsh-pet/src/app/main
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { flattenPetList, readAllConfig } from '../host/config.ts';
import { dshHomeDir } from '../host/helper-process.ts';
import { apply } from '../host/index.ts';
import { createFileLogger, setDefaultLogger } from '../host/log-file.ts';
import { createStandaloneAi } from '../standalone/ai-provider.ts';
import { packageVersion } from '../standalone/check.ts';
import { createStandaloneContext, type RegisteredRoute } from '../standalone/context.ts';
import { configPathsFor } from '../standalone/options.ts';
import { createRequestSecurity } from '../standalone/request-security.ts';

import { installDesktopAuth, type DesktopSession } from './desktop-auth.ts';
import { startRouter } from './router.ts';
import { ROUTE_SEGMENT } from '../shared/constants.ts';

/**
 * `electron` 由 Electron 运行时提供，不是本包依赖；只声明实际用到的成员。
 * 静态 `import 'electron'` 会让 `tsc --noEmit` 找不到类型而整仓变红。
 */
interface WebContentsLike {
  on(
    event: 'console-message',
    listener: (event: unknown, level: number, message: string, line: number, sourceId: string) => void,
  ): void;
}
interface ElectronApp {
  whenReady(): Promise<void>;
  requestSingleInstanceLock(): boolean;
  exit(code?: number): void;
  on(event: 'web-contents-created', listener: (event: unknown, contents: WebContentsLike) => void): void;
  on(event: 'second-instance', listener: () => void): void;
  on(event: 'will-quit', listener: () => void): void;
}
/** 引导窗只要这两个成员；完整类型交给 Electron 自带声明。 */
interface ElectronBrowserWindowLike {
  loadURL(url: string): Promise<void>;
  on(event: 'closed', listener: () => void): void;
}
type BrowserWindowCtor = new (options: Record<string, unknown>) => ElectronBrowserWindowLike;
const { app, session, BrowserWindow } = createRequire(import.meta.url)('electron') as {
  app: ElectronApp;
  session: { defaultSession: DesktopSession };
  BrowserWindow: BrowserWindowCtor;
};

/** 包根目录：与 helper-process.ts 的 packageRoot 同一口径（模块所在目录的上一级） */
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const helperMain = join(packageRoot, 'runtime', 'electron-helper', 'main.js');

const log = (message: string): void => console.log(`[dsh-pet-app] ${message}`);

/** 单实例：第二次双击直接退出（共用 userData 的 Chromium profile 会互踢） */
const locked = app.requestSingleInstanceLock();
if (!locked) {
  app.exit(0);
} else {
  await boot();
}

/**
 * 启动应用。
 *
 * 外层必须 `await`：端口要在 `require(helperMain)` 之前确定（Helper 在 ready 回调里就要用配置地址），
 * 而 Helper 又必须在 ready 之前被 require（内部有 `app.commandLine.appendSwitch`，ready 后再加不生效）。
 */
async function boot(): Promise<void> {
  // 独立应用没有控制台：插件日志、standalone 日志与同进程 Helper/渲染端的 console 全部落盘。
  // 原始 console 方法要先快照——包装后的 console 会转给文件 logger，logger 的 base 必须指向原始方法，
  // 否则 logger → console → logger 无限递归。
  const logFile = join(dshHomeDir(), 'dsh-pet', 'logs.txt');
  const rawConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };
  const logger = createFileLogger({
    file: logFile,
    base: rawConsole,
    debugEnabled: process.env.DSH_PET_LOG_DEBUG === '1',
  });
  const toLine = (args: unknown[]): string => args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
  for (const level of ['info', 'warn', 'error', 'debug'] as const) {
    console[level] = (...args: unknown[]): void => {
      rawConsole[level](...args);
      logger[level](toLine(args));
    };
  }
  console.log = (...args: unknown[]): void => {
    rawConsole.log(...args);
    logger.info(toLine(args));
  };
  // 纯模块（config/chat/whisper）没有 ctx.logger，靠默认出口落盘
  setDefaultLogger(logger);

  const routes: RegisteredRoute[] = [];
  let port = 0;

  // 与 CLI 同一套安全模型：令牌只经「配置页地址的 #token=」递给浏览器，不进日志
  const security = createRequestSecurity();
  const ai = createStandaloneAi(dshHomeDir(), logger);
  const context = createStandaloneContext({
    port: () => port,
    logger,
    routes,
    ai,
    authenticatedUrl: security.authenticatedUrl,
  });

  const server = await startRouter(routes, { security, ai, log, status, landingPage });
  port = server.port;
  const origin = `http://127.0.0.1:${port}`;
  log(`本机服务 ${origin}`);

  // 先把「我自己就是应用」告诉插件，再 apply：apply 内部据此短路 spawn 与下载
  process.env.DSH_PET_IN_PROCESS = '1';
  process.env.DSH_PET_APP_MODE = '1';
  // 独立模式点首项打开的是本机 AI 设置页，不是 DSH 站点：形态必须显式标成 standalone。
  process.env.DSH_PET_OPEN_TARGET = 'standalone';
  // 不注入宿主 PID：helper 的「宿主没了就退出」只对双进程有意义，同进程里设了会自己杀自己
  delete process.env.DSH_PET_HOST_PID;
  process.env.DSH_PET_CONFIG_URL = `${origin}${ROUTE_SEGMENT}/config`;
  // 右键「打开 AI 设置」用它：带令牌的配置页（与 CLI 行为一致）。裸 origin 在应用里没有页面可看。
  process.env.DSH_PET_SITE_URL = security.authenticatedUrl(origin);
  if (!process.env.DSH_PET_SCALE) process.env.DSH_PET_SCALE = '1';

  apply(context.ctx);
  log(`apply() 完成：routes=${routes.length} 失败=${context.failures.length}`);

  // helper 读它决定建几个窗口；读不到时它会回落到单个默认窗口，首帧再由渲染端自校正
  process.env.DSH_PET_PETS = JSON.stringify(desktopPets());

  // 同进程跑 Helper：建窗、托盘、IPC、碰撞都在它内部完成（CJS，需要 require）。
  // 渲染端日志必须转出来——打包后的应用没有控制台，渲染端报错只会表现成「窗口透明」。
  app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', (_e, level, message, line, source) => {
      log(`渲染端[${level}] ${message} (${source}:${line})`);
    });
  });
  // 必须早于 Helper 的 whenReady 回调建出 file 渲染页。
  void app.whenReady().then(() => {
    installDesktopAuth(
      session.defaultSession,
      origin,
      join(packageRoot, 'runtime/electron-helper/index.html'),
      security.token,
    );
  });
  process.env.DSH_PET_APP_TOKEN = security.token;
  try {
    createRequire(import.meta.url)(helperMain);
  } finally {
    delete process.env.DSH_PET_APP_TOKEN;
  }

  // [khalil] box 服务:捆绑的姐妹同屏会/手动看屏/小剧场脚本随包分发,
  // 用本进程的运行时以纯 Node 模式拉起(ELECTRON_RUN_AS_NODE=1),宠物 API 指向本机服务。
  // key 时序:key 从设置页读取,启动瞬间多半还没填——所以只在 key 就绪后拉起,
  // 之后每 20s 轮询:key 首次出现→拉起;key 被换→杀旧拉新(env 是启动快照,必须重启才生效)。
  let boxKey = readApiKey();
  let boxChildren = boxKey ? spawnBoxServices(origin, boxKey) : [];
  const boxKeyTimer = setInterval(() => {
    const k = readApiKey();
    if (k === boxKey) return;
    log(`box key 变更:${boxKey ? '换Key' : '首次配置'} → ${k ? '重启服务' : '停止服务(清空)'}`);
    for (const child of boxChildren) child.kill();
    boxChildren = [];
    boxKey = k;
    if (k) boxChildren = spawnBoxServices(origin, k);
  }, 20000);
  boxKeyTimer.unref?.();
  // 首次运行未配置 key:弹引导窗直达 AI 设置页(带令牌),填完保存即可,无需重启。
  if (!boxKey) {
    void app.whenReady().then(() => {
      const win = new BrowserWindow({
        width: 760,
        height: 680,
        title: '鲸鱼姐妹 · 先配置 AI',
        autoHideMenuBar: true,
      });
      void win.loadURL(security.authenticatedUrl(origin));
    });
  }

  app.on('second-instance', () => log('已有一个实例在运行，忽略本次启动'));
  app.on('will-quit', () => {
    for (const child of boxChildren) child.kill();
    // 退出前把最后一批日志刷出去（定时器最多 1s，这里显式补一次）
    void logger.flush();
    logger.dispose();
    void ai.dispose();
    void context.dispose().catch(() => undefined);
    void server.close().catch(() => undefined);
  });
}

/**
 * [khalil] box 脚本目录：打包后落在 resources/box（asar 外，spawn 的脚本必须可读文件），
 * 开发态在包根 box/。找不到（比如上游裁剪）就静默不拉起。
 */
function boxDir(): string {
  const candidates = [resolve(packageRoot, '..', 'box'), join(packageRoot, 'box')];
  return candidates.find((p) => existsSync(join(p, 'screen-talk.mjs'))) ?? '';
}

/** [khalil] 读独立 AI 设置里的 DeepSeek key：未配置返回空串（首启引导与 box 服务的 LLM 都靠它）。
 *  上游 0.4.9 起密钥按服务商分栏存（keys.deepseekApiKey），兼容旧版顶层 apiKey。 */
function readApiKey(): string {
  try {
    const raw = JSON.parse(readFileSync(join(dshHomeDir(), 'dsh-pet', 'standalone-ai.json'), 'utf8')) as {
      apiKey?: unknown;
      keys?: { deepseekApiKey?: unknown };
    };
    const fromKeys = raw.keys?.deepseekApiKey;
    const value = typeof fromKeys === 'string' && fromKeys ? fromKeys : raw.apiKey;
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}

/** [khalil] 拉起三个 box 服务；key 由调用方传入（未配置时不该被调用——见 boot 的 key 轮询）。 */
function spawnBoxServices(origin: string, key: string): ChildProcess[] {
  const dir = boxDir();
  log(`box 目录判定：${dir || '（未找到，不拉起）'}；DSH_PET_BOX=${process.env.DSH_PET_BOX ?? '未设'}`);
  if (!dir || process.env.DSH_PET_BOX === '0' || !key) return [];
  log(`box key 状态：${key ? '已配置' : '未配置（等待设置页填写）'}`);
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PET_API: `${origin}${ROUTE_SEGMENT}`,
      ST_KEY: key,
      LOOK_KEY: key,
      TH_KEY: key,
    };
    const children: ChildProcess[] = [];
    for (const script of ['screen-talk.mjs', 'look-screen.mjs', 'pet-theater.mjs']) {
      const child = spawn(process.execPath, [join(dir, script)], {
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        log(`box/${script} ${String(chunk).trim()}`);
      });
      child.on('exit', (code) => log(`box/${script} 退出 code=${code}`));
      children.push(child);
    }
    log(`box 服务已拉起（${dir}）共 ${children.length} 个`);
    return children;
  } catch (error) {
    log(`box 拉起失败：${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/**
 * 桌面可见宠物清单（[{id,size}]）。
 * 与 `src/host/index.ts` 的 isDesktopVisible 同口径：display 含 desktop/both 才建窗。
 */
function desktopPets(): Array<{ id: string; size: number }> {
  try {
    const pets = flattenPetList(readAllConfig(configPathsFor(packageRoot, dshHomeDir())));
    const desktop = pets
      .filter((pet) => pet.display === 'desktop' || pet.display === 'both')
      .map((pet) => ({ id: String(pet.id), size: Number(pet.size) }));
    log(`桌面宠物 ${JSON.stringify(desktop)}`);
    return desktop;
  } catch (error) {
    log(`读配置失败（回落单窗）：${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/** 状态接口与落地页共用的数据源；配置读不出来时如实显示 0 只，不让页面 500。 */
function status(port: number): Record<string, unknown> {
  const paths = configPathsFor(packageRoot, dshHomeDir());
  let pets: Array<Record<string, unknown>> = [];
  try {
    pets = flattenPetList(readAllConfig(paths));
  } catch {
    /* 落地页/状态接口不该因配置坏掉而 500：下面如实显示 0 只 */
  }
  return {
    name: 'dsh-pet-app',
    version: packageVersion(packageRoot),
    pid: process.pid,
    port,
    pluginRoot: packageRoot,
    configFile: paths.userFile,
    pets: pets.map((pet) => ({ id: pet.id, name: pet.name, display: pet.display })),
  };
}

/** 落地页：配置项只能改文件，可视化配置在 /standalone-ai/（需令牌）。 */
function landingPage(port: number): string {
  const info = status(port);
  const pets = (info.pets as Array<Record<string, unknown>>) ?? [];
  const petLines = pets.length
    ? pets
        .map((pet) => `<li>${escapeHtml(String(pet.name ?? pet.id))}（${escapeHtml(String(pet.display))}）</li>`)
        .join('')
    : '<li>（未读到宠物，检查配置文件）</li>';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>dsh-pet</title>
<style>
  body{font:14px/1.7 "Segoe UI",system-ui,sans-serif;margin:0;padding:32px;background:#f6f8fa;color:#1f2328}
  main{max-width:720px;margin:0 auto;background:#fff;border:1px solid #d0d7de;border-radius:12px;padding:28px 32px}
  h1{font-size:20px;margin:0 0 4px} .sub{color:#656d76;margin-bottom:20px}
  h2{font-size:14px;margin:22px 0 6px} code{background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:1px 6px;font-size:12px}
  ul{margin:6px 0;padding-left:20px} a{color:#0969da}
</style></head>
<body><main>
  <h1>dsh-pet 桌宠</h1>
  <div class="sub">版本 ${escapeHtml(String(info.version))} · 端口 ${port}</div>
  <h2>宠物</h2><ul>${petLines}</ul>
  <h2>配置文件</h2>
  <p><code>${escapeHtml(String(info.configFile))}</code></p>
  <p>改完配置后从托盘退出、重新打开应用即可生效（本模式没有「重载配置」菜单）。</p>
  <h2>AI 设置</h2>
  <p>AI 模型与密钥的配置页需要令牌，请<strong>右键桌宠 →「打开 AI 设置」</strong>，会直接打开已授权的页面。</p>
  <h2>状态</h2>
  <p><a href="/health">/health</a> · <a href="/standalone-ai/">配置页（未授权时读写会返回 403）</a></p>
</main></body></html>`;
}

/** HTML 转义：落地页拼字符串用。 */
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );
}
