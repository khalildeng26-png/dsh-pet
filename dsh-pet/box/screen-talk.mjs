// screen-talk.mjs — 姐妹同屏会(合并版自动):每 N 秒截一次屏,两只一起看,
// 一次 LLM 生成围绕屏幕内容的姐妹对话,原地(不走位)播出 2-3 句。
// 取代 look-screen 的每分钟自动看屏 与 theater 的随机自动触发(两者自动均关闭,手动保留)。
// Env: ST_KEY(必填) / ST_BASE / ST_MODEL / ST_INTERVAL(秒,默认120)
//      ST_WINDOW / ST_DAYS / ST_HOLIDAYS_FILE —— 与看屏同一套时间规则
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, openSync, closeSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hotTopics } from './hot.mjs';
import { memeSheet } from './memes.mjs';
import { logUsage } from './usage-log.mjs';
import { current } from './personalities.mjs';
import { fileURLToPath as __ftp } from 'node:url';
const __here = (p) => __ftp(new URL(p, import.meta.url));

// --usage 是纯读报表,必须在单实例锁之前处理(守护在跑时也要能查账)
if (process.argv.includes('--usage')) {
  let rows = [];
  try {
    rows = readFileSync(__here('./.llm-usage.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {}
  const byDay = new Map();
  for (const r of rows) {
    const day = r.ts.slice(0, 10);
    const e = byDay.get(day) ?? { calls: 0, pt: 0, ct: 0, hit: 0 };
    e.calls += 1; e.pt += r.pt || 0; e.ct += r.ct || 0; e.hit += r.hit || 0;
    byDay.set(day, e);
  }
  console.log('日期         调用  输入tok   缓存命中  输出tok   约费¥(峰段)');
  for (const [day, e] of [...byDay.entries()].sort()) {
    const missIn = Math.max(0, e.pt - e.hit);
    const cost = missIn * 2.13e-6 + e.ct * 8.5e-6; // 峰段粗估:输入miss ¥2.1/M,输出(含思考) ¥8.5/M
    console.log(`${day}  ${String(e.calls).padStart(4)}  ${String(e.pt).padStart(8)}  ${String(e.hit).padStart(8)}  ${String(e.ct).padStart(8)}  ${cost.toFixed(2)}`);
  }
  if (!rows.length) console.log('(还没有记录)');
  process.exit(0);
}

// 单实例锁(路径可用 ST_LOCK_FILE 覆盖,供测试并行跑)
const LOCK_FILE = process.env.ST_LOCK_FILE || __here('./.screen-talk.lock');
try {
  if (Date.now() - statSync(LOCK_FILE).mtimeMs < 90000) { console.error('[screen-talk] already running, exit'); process.exit(0); }
} catch {}
try { closeSync(openSync(LOCK_FILE, 'w')); } catch {}
setInterval(() => { try { utimesSync(LOCK_FILE, new Date(), new Date()); } catch { try { closeSync(openSync(LOCK_FILE, 'w')); } catch {} } }, 30000).unref?.();

const API = process.env.PET_API || 'http://127.0.0.1:3080/dsh-pet-7340';
const BASE = process.env.ST_BASE || 'https://api.deepseek.com';
const KEY = process.env.ST_KEY || '';
const MODEL = process.env.ST_MODEL || 'deepseek-flash';
const INTERVAL = Number(process.env.ST_INTERVAL ?? 300); // 2026-11-23 起 5 分钟一场(用户拍板:费用÷2.5)
const MAIN = process.env.ST_MAIN || 'main';
const SIDE = process.env.ST_SIDE || 'maid-2';
const WINDOW = process.env.ST_WINDOW || '9:00-18:30';
const DAYS = (process.env.ST_DAYS || '1,2,3,4,5').split(',').map(Number);
const HOLIDAYS_FILE = process.env.ST_HOLIDAYS_FILE || __here('./holidays.json');
const HOT_MODE_RATIO = Number(process.env.ST_HOT_RATIO ?? 0.5); // B·热搜专场出现概率(0=永远看屏幕,1=永远聊热点)

// 角色卡按当前性格动态拼(右键「更多→性格」可切,状态文件 .personality.json,每场现读):
const buildPersona = () => {
  const cm = current(MAIN), cs = current(SIDE);
  return `你是Q版鲸鱼女仆姐妹(桌面宠物)的小剧场导演。写她们围绕主人屏幕的拌嘴,要有梗、好笑、像真人姐妹斗嘴。

【角色卡·姐姐「蓝毛小女仆」】${cm.card}

【角色卡·妹妹「小跟班」】${cs.card}

【关系动力学】亲姐妹,互怼是爱的语言,但绝不允许外人说对方半句。妹妹闯祸姐姐兜底,姐姐过时妹妹补课。屏幕中出现两只鲸鱼女仆就是她们本人(更大只=姐姐,更小只=妹妹),台词互称姐姐/妹妹,绝不说"分身/克隆"。主人是她们共同吐槽又共同关心的对象(吐槽他的代码/熬夜/折腾,但真出bug了会心疼)。`;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// —— 防重复:最近说过的台词(模型看不到自己的历史,不喂清单它就翻来覆去那几个梗) ——
const USED_FILE = __here('./.used-lines.json');
function loadRecentUsed() {
  try {
    const arr = JSON.parse(readFileSync(USED_FILE, 'utf8'));
    return Array.isArray(arr) ? arr.slice(-9) : [];
  } catch { return []; }
}
function recordUsed(lines) {
  try {
    const next = [...loadRecentUsed(), ...lines.map((l) => String(l.text || '').slice(0, 40))].slice(-24);
    writeFileSync(USED_FILE, JSON.stringify(next));
  } catch {}
}
// —— 喜剧路线轮盘:每场随机一种,同样的素材换着法演 ——
const STYLES = ['互怼抬杠(为反对而反对)', '谐音梗和文字游戏', '夸张脑补(把小事脑补成大戏)', '一本正经地胡说八道', '互相拆台揭老底', '凡尔赛式自夸', '歌词或名言魔改乱入', '主播腔解说(把主人操作当赛事播报)', '卖惨比惨大赛', '冷吐槽(越冷静越好笑)', '接话茬玩梗(对方说啥都往歪处接)', '教育失败现场(姐姐讲道理妹妹歪解)'];

async function j(method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t, status: r.status }; }
}

function screenshot() {
  const s = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', __here('./look-screen-shot.ps1')], { timeout: 25000 });
  if (s.status !== 0) throw new Error('screenshot failed: ' + (s.stderr || '').toString().slice(0, 120));
  return readFileSync(join(tmpdir(), 'lookscreen.jpg')).toString('base64');
}

async function animPool() {
  const cfg = await j('GET', '/config');
  const a = (cfg?.main ?? cfg)?.animations ?? {};
  const names = new Set();
  for (const c of (a.clicks ?? [])) { const n = typeof c === 'string' ? c : c?.name; if (n) names.add(n); }
  for (const cat of (a.categories ?? [])) for (const n of (cat.actions ?? [])) names.add(n);
  return [...names];
}

function tryParseLines(raw) {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  for (const cand of [m[0], m[0].replace(/,\s*([}\]])/g, '$1')]) {
    try {
      const o = JSON.parse(cand);
      if (Array.isArray(o.lines) && o.lines.length) {
        const saw = typeof o.saw === 'string' ? o.saw.trim().slice(0, 60) : '';
        return { saw, lines: o.lines.filter((l) => l && l.text).slice(0, 3) };
      }
    } catch {}
  }
  return null;
}

async function improvise(b64, actions, hot, recentUsed, style, mode = '屏幕') {
  const cm = current(MAIN), cs = current(SIDE); // 声线/分工约束也随当前性格走
  // 思考策略(2026-11-23 用户拍板省钱档):屏幕场开思考(要真看懂,截图文本细节靠它);
  // 热点场关思考(纯文本抖机灵,关了省下最贵的思考输出 token)。
  // 坑:思考 token 计入 max_tokens(reasoning 能吃掉几千)——开思考的场额度必须给足。
  const GEN = mode === '屏幕'
    ? { thinking: { type: 'enabled', budget_tokens: 3000 }, max_tokens: 4500 }
    : { thinking: { type: 'disabled' }, max_tokens: 900 };
  // 梗学习层:刚从素材里提取的新鲜流行语(2h 一学)——妹妹玩梗优先用这里的,不准翻模型老本
  const memes = await memeSheet().catch(() => []);
  const memeBlock = memes.length
    ? `\n【近期网络热梗小抄】(妹妹玩梗优先挑这里的新鲜梗,别翻来覆去用「家人们谁懂啊」这类老梗;用法要贴合语境,拿不准就换一个)\n${memes.map((m) => `- ${m.name}:${m.meaning}${m.usage ? `(例:${m.usage})` : ''}`).join('\n')}\n`
    : '';
  const list = actions.slice(0, 40).join(',');
  const hotBlock = hot
    ? `\n【近期真实热搜/热点】(妹妹玩梗的主要来源,可挑最多1-2个自然融入;两场之间换着条目聊,别翻来覆去同一条;不合适就完全不用,永远以屏幕内容为主,严禁生硬报菜名)\n${hot}\n`
    : '';
  const recent = recentUsed || [];
  const recentBlock = recent.length
    ? `\n【她们最近已说过的台词】(严禁重复、严禁换个说法再讲一遍、也别再玩其中出现过的梗)\n${recent.map((t) => '- ' + t).join('\n')}\n`
    : '';
  const styleBlock = style ? `\n【本场喜剧路线】${style}(贴合就多用,不贴合就丢掉,别硬演)\n` : '';
  const directive = mode === '热点'
    ? `\n只输出严格JSON {"lines":[{"pet":"姐姐"|"妹妹"(姐姐=蓝毛小女仆·大只,妹妹=小跟班·小只;台词声线必须匹配:姐姐${cm.voice},妹妹${cs.voice},严禁互换声线)","anim":"动作名","text":"台词"}]}:恰好3行、两人交替出现、都要开口。本场是【热搜脱口秀】:姐妹像解说搭档聊今天热搜里的1-2条最有梗的(可意见相左吵起来),妹妹${cs.hotRole}、姐姐${cm.hotRole},像真人聊八卦一样自然。**听众规则(最重要):主人没看过热搜,台词必须让他听懂在聊什么——第一句就要点名具体事件(如「BLG全球总决赛夺冠了」「北大399元羽绒服卖爆了」),禁止用「这个/那个/这事/那事」等空指代词**,text为不超过26个汉字的口语且不含引号,anim必须从: ${list} 中选。不要输出JSON以外的任何内容。`
    : `\n只输出严格JSON {"saw":"先用20-40字如实描述屏幕实际内容(什么窗口/在干什么/最显眼的东西;看不清的绝不编造,宁可写「小字看不清」)","lines":[{"pet":"姐姐"|"妹妹"(姐姐=蓝毛小女仆·大只,妹妹=小跟班·小只;台词声线必须匹配:姐姐${cm.voice},妹妹${cs.voice},严禁互换声线)","anim":"动作名","text":"台词"}]}:恰好3行、两人交替出现、都要开口,围绕【saw 里确认过的】屏幕内容拌嘴(吐槽/接梗/互怼),台词里说到的细节必须真的在屏幕上,妹妹负责${cs.hotRole}、姐姐负责${cm.hotRole},梗不够时姐妹日常(零食/道歉账/抢镜头/嫌弃主人)本身就是最好的素材。**数字纪律:聊天记录/文档里的数字、日期、人名必须逐字核对,小字看不清就用「几个」「一些」模糊表述,严禁编造或凑整具体数字(把3个说成5个这种)= 事故**。**听众规则:主人瞄一眼就能懂——名词要具体(说「报错弹窗」「十几条回复」,不说「这个」「那玩意」)**,text为不超过26个汉字的口语且不含引号,anim必须从: ${list} 中选。不要输出JSON以外的任何内容。`;
  const contentParts = [];
  if (b64) contentParts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } });
  contentParts.push({ type: 'text', text: `${buildPersona()}${hotBlock}${memeBlock}${recentBlock}${styleBlock}${directive}` });
  const baseMessages = [{ role: 'user', content: contentParts }];

  async function send(body) {
    const r = await fetch(BASE.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => null);
    logUsage(`screen-talk:${mode}`, d?.usage); // 每笔记账,--usage 出报表
    return d;
  }

  // 优先路:给模型挂「联网搜索」工具——它自己决定要不要搜、搜什么(最多追加一轮)
  const searchTool = {
    type: 'function',
    function: {
      name: 'search_hot',
      description: '联网搜索最新的热搜榜与新闻(微博热榜/知乎热议/每日新闻)。当你想用更新鲜的热梗或验证某话题现状时调用,不需要就不用。',
      parameters: {
        type: 'object',
        properties: { keyword: { type: 'string', description: '可选关键词,只返回含它的条目' } },
        required: [],
      },
    },
  };
  try {
    let messages = baseMessages;
    for (let round = 0; round < 2; round += 1) {
      const d = await send({
        model: MODEL, messages, max_tokens: GEN.max_tokens, temperature: 1.0,
        tools: [searchTool], tool_choice: 'auto', thinking: GEN.thinking,
      });
      if (!d || d.error) break;
      const msg = d?.choices?.[0]?.message;
      const call = msg?.tool_calls?.[0];
      if (call && call.function?.name === 'search_hot') {
        let kw = '';
        try { kw = String(JSON.parse(call.function.arguments || '{}').keyword || ''); } catch (e) {}
        const fresh = await hotTopics({ fresh: true }).catch(() => '');
        const result = kw && fresh
          ? fresh.split('\n').map((l) => l.split(' / ').filter((it) => it.includes(kw)).join(' / ')).filter(Boolean).join('\n')
          : fresh;
        console.log(`[screen-talk] 模型主动联网搜索热点${kw ? `(${kw})` : ''}${result ? '' : ' → 无结果'}`);
        messages = [...messages, msg, { role: 'tool', tool_call_id: call.id, content: result || '(搜索暂无结果,用已有素材)' }];
        continue;
      }
      const r = tryParseLines(msg?.content || '');
      if (r) return r;
      break;
    }
  } catch (e) { /* 工具路失败退老路 */ }

  // 兜底路:不带工具的旧矩阵(json_object × thinking)——思考开关沿用本模式的 GEN 设定
  for (const fmt of [{ type: 'json_object' }, null]) {
    const body = {
      model: MODEL,
      messages: baseMessages,
      max_tokens: GEN.max_tokens,
      temperature: 1.0,
    };
    if (fmt) body.response_format = fmt;
    for (const think of [{ type: 'enabled' }, { type: 'disabled' }]) {
      const b = { ...body };
      if (think) b.thinking = think; else delete b.thinking;
      const d = await send(b);
      if (!d || d.error) continue;
      const raw = d?.choices?.[0]?.message?.content || '';
      const r = tryParseLines(raw);
      if (r) return r;
    }
  }
  throw new Error('improvise failed');
}

async function surfaceOf(pet) {
  const cfg = await j('GET', '/config');
  const p = (cfg?.main ?? cfg)?.pets?.find((x) => x.id === pet);
  const d = p?.display || 'both';
  return d === 'none' ? 'any' : d;
}

async function anySleeping() {
  try {
    const st = await j('GET', '/state');
    const pets = st?.pets ?? {};
    return [MAIN, SIDE].some((id) => pets[id]?.sleep?.sleeping === true);
  } catch { return false; }
}

async function playLines(lines, actions) {
  // 微锁模式:每句只在写入气泡的一瞬拿锁(~百毫秒),写完即放——气泡自带寿命自己飘,
  // 期间宠物完全自由(锁的语义是「占用期完全静止」,整场长锁会把她们定格成"卡住")。
  for (const l of lines) {
    const pet = (l.pet === SIDE || l.pet === '妹妹') ? SIDE : (l.pet === MAIN || l.pet === '姐姐') ? MAIN : null;
    if (!pet) continue; // 无法识别的填值跳过,绝不归错人
    const sf = await surfaceOf(pet);
    const lk = await j('POST', `/lock?pet=${pet}&surface=${sf}`, {});
    const id = lk?.lockId;
    if (!id) { console.log(`  ${pet}: 锁被占,跳过本句`); continue; }
    try {
      await j('POST', `/broadcast?pet=${pet}&surface=${sf}&lock=${id}`, { text: String(l.text).slice(0, 40), seconds: 7, anim: false });
      console.log(`  ${pet}: ${l.text}`);
    } finally {
      await j('POST', `/lock/release?pet=${pet}`, { lockId: id }).catch(() => {});
    }
    await sleep(7500);
  }
}

// —— 时间窗(与看屏同一套规则)——
function loadCalendar() {
  try {
    const d = JSON.parse(readFileSync(HOLIDAYS_FILE, 'utf8'));
    return { holidays: new Set(d.holidays || []) };
  } catch { return { holidays: new Set() }; }
}
const DT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const WDF = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' });
const TMF = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: 'numeric', minute: 'numeric', hour12: false });
const WDN = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
function inWindow(now = new Date()) {
  const date = DT.format(now);
  const wd = WDN[WDF.format(now)] ?? 1;
  const [ch, cm] = TMF.format(now).split(':').map(Number);
  const cur = (ch % 24) * 60 + cm;
  if (loadCalendar().holidays.has(date)) return false;
  if (!DAYS.includes(wd)) return false;
  if (WINDOW) {
    const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
    const [a, b] = WINDOW.split('-');
    const s = toMin(a), e = toMin(b);
    const inT = s <= e ? (cur >= s && cur < e) : (cur >= s || cur < e);
    if (!inT) return false;
  }
  return true;
}

let running = false;
// 保险丝(2026-11-23 事故教训):宠物本体(dsh web)不在线时,生成完也播不出去=纯烧钱。
// 每场开场先探宠物 API,不通就整场跳过——零 LLM 调用,零浪费。
async function petsAlive() {
  try {
    const r = await fetch(API + '/config', { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch { return false; }
}
async function tick(why) {
  if (running) return;
  running = true;
  try {
    if (await anySleeping()) { console.log(`[${why}] 有人睡着,跳过`); return; }
    if (!(await petsAlive())) { console.log(`[${why}] 宠物API不通,整场跳过(不烧钱)`); return; }
    const actions = await animPool().catch(() => []);
    const hot = await hotTopics().catch(() => '');
    const style = STYLES[Math.floor(Math.random() * STYLES.length)];
    // 模式轮盘:A·看屏幕(截图+热梗佐料) / B·热搜专场(纯热点脱口秀);ST_MODE 可钉死(屏幕|热点)
    const modeB = process.env.ST_MODE ? (process.env.ST_MODE === '热点' && !!hot) : (hot && Math.random() < HOT_MODE_RATIO);
    const mode = modeB ? '热点' : '屏幕';
    const b64 = modeB ? null : screenshot();
    const { saw, lines } = await improvise(b64, actions, hot, loadRecentUsed(), style, mode);
    console.log(`[${new Date().toLocaleTimeString()}] (${why}·${mode}) [路线:${style}] 姐妹同屏会:${saw ? '\n  看到: ' + saw : ''}`);
    await playLines(lines, actions);
    recordUsed(lines);
  } catch (e) {
    console.error(`[screen-talk] ${why}:`, e.message);
  } finally {
    running = false;
  }
}

console.log(`[screen-talk] every ${INTERVAL}s, ${WINDOW} Beijing, days=${DAYS.join(',')}, CN-holidays excluded; model=${MODEL} key=${KEY ? 'set' : 'MISSING'}`);
if (process.argv.includes('--gen')) {
  // 只生成不播出:走完整 tick 逻辑(模式轮盘+防重复+风格),但不锁宠不广播
  // ST_MODE=屏幕|热点 可钉死模式(ST_MODE=屏幕 = 永远看屏幕,不聊热搜)
  if (await anySleeping()) { console.log('有人睡着,跳过'); process.exit(0); }
  const a = await animPool().catch(() => []);
  const hot = await hotTopics().catch(() => '');
  const style = STYLES[Math.floor(Math.random() * STYLES.length)];
  const modeB = process.env.ST_MODE ? (process.env.ST_MODE === '热点' && !!hot) : (hot && Math.random() < HOT_MODE_RATIO);
  const mode = modeB ? '热点' : '屏幕';
  const b64 = modeB ? null : screenshot();
  const { saw, lines } = await improvise(b64, a, hot, loadRecentUsed(), style, mode);
  console.log(`[模式:${mode}] [路线:${style}]${saw ? ' 看到: ' + saw : ''}`);
  for (const l of lines) console.log(`${l.pet}: ${l.text} (${l.anim})`);
  recordUsed(lines);
  process.exit(0);
}
if (process.argv.includes('--once')) {
  await tick('once');
  process.exit(0);
}
for (;;) {
  await sleep(INTERVAL * 1000);
  if (!inWindow()) continue;
  await tick('auto');
}
