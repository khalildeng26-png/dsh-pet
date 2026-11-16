// screen-talk.mjs — 姐妹同屏会(合并版自动):每 N 秒截一次屏,两只一起看,
// 一次 LLM 生成围绕屏幕内容的姐妹对话,原地(不走位)播出 2-3 句。
// 取代 look-screen 的每分钟自动看屏 与 theater 的随机自动触发(两者自动均关闭,手动保留)。
// Env: ST_KEY(必填) / ST_BASE / ST_MODEL / ST_INTERVAL(秒,默认120)
//      ST_WINDOW / ST_DAYS / ST_HOLIDAYS_FILE —— 与看屏同一套时间规则
import { spawnSync } from 'node:child_process';
import { readFileSync, openSync, closeSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hotTopics } from './hot.mjs';

// 单实例锁(路径可用 ST_LOCK_FILE 覆盖,供测试并行跑)
const LOCK_FILE = process.env.ST_LOCK_FILE || 'D:/dsh/bin/.screen-talk.lock';
try {
  if (Date.now() - statSync(LOCK_FILE).mtimeMs < 90000) { console.error('[screen-talk] already running, exit'); process.exit(0); }
} catch {}
try { closeSync(openSync(LOCK_FILE, 'w')); } catch {}
setInterval(() => { try { utimesSync(LOCK_FILE, new Date(), new Date()); } catch { try { closeSync(openSync(LOCK_FILE, 'w')); } catch {} } }, 30000).unref?.();

const API = process.env.PET_API || 'http://127.0.0.1:3080/dsh-pet-7340';
const BASE = process.env.ST_BASE || 'https://api.deepseek.com';
const KEY = process.env.ST_KEY || '';
const MODEL = process.env.ST_MODEL || 'deepseek-flash';
const INTERVAL = Number(process.env.ST_INTERVAL ?? 120);
const MAIN = process.env.ST_MAIN || 'main';
const SIDE = process.env.ST_SIDE || 'maid-2';
const WINDOW = process.env.ST_WINDOW || '9:00-18:30';
const DAYS = (process.env.ST_DAYS || '1,2,3,4,5').split(',').map(Number);
const HOLIDAYS_FILE = process.env.ST_HOLIDAYS_FILE || __here('./holidays.json');
const PERSONA = `你是Q版鲸鱼女仆姐妹(桌面宠物)的小剧场导演。写她们围绕主人屏幕的拌嘴,要有梗、好笑、像真人姐妹斗嘴。

【角色卡·姐姐「蓝毛小女仆」】温柔贤惠的皮囊,毒舌傲娇的芯子。操心命:嘴上"真是的~主人又在作死",身体却诚实帮忙收拾烂摊子。会记账(主人欠她几次道歉记得门儿清),对妹妹是严师+慈母混合双打。玩梗慢半拍,爱一本正经地用过气的梗,被妹妹嘲"姐这梗都凉了"。口头禅:"真是的~"、"主人心里没点数吗"、"妹妹,坐好"。

【角色卡·妹妹「小跟班」】网络冲浪十级学者,热梗第一手,家里唯一跟上时代的人。吃货,行动力全点在吃上,会为了一口零食出卖姐姐。爱抢镜头,撒娇逃避劳动成功率极高。口头禅:"家人们谁懂啊!"、"这波啊,这波是XX"、"姐姐听我说!"(急着分享新梗但常讲不明白)。

【关系动力学】亲姐妹,互怼是爱的语言,但绝不允许外人说对方半句。妹妹闯祸姐姐兜底,姐姐过时妹妹补课。屏幕中出现两只鲸鱼女仆就是她们本人(更大只=姐姐,更小只=妹妹),台词互称姐姐/妹妹,绝不说"分身/克隆"。主人是她们共同吐槽又共同关心的对象(吐槽他的代码/熬夜/折腾,但真出bug了会心疼)。`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      const lines = JSON.parse(cand).lines;
      if (Array.isArray(lines) && lines.length) return lines.filter((l) => l && l.text).slice(0, 3);
    } catch {}
  }
  return null;
}

async function improvise(b64, actions, hot) {
  const list = actions.slice(0, 40).join(',');
  const hotBlock = hot
    ? `\n【近期真实热搜/热点】(妹妹玩梗的主要来源,可挑最多1-2个自然融入;不合适就完全不用,永远以屏幕内容为主,严禁生硬报菜名)\n${hot}\n`
    : '';
  for (const fmt of [{ type: 'json_object' }, null]) {
    const body = {
      model: MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
          { type: 'text', text: `${PERSONA}${hotBlock}\n只输出严格JSON {"lines":[{"pet":"${MAIN}"|"${SIDE}","anim":"动作名","text":"台词"}]}:恰好3行、两人交替出现、都要开口,围绕屏幕里实际看到的内容拌嘴(吐槽/接梗/互怼),妹妹负责玩热梗、姐姐负责毒舌吐槽,text为不超过18个汉字的口语且不含引号,anim必须从: ${list} 中选。不要输出JSON以外的任何内容。` },
        ],
      }],
      max_tokens: 900,
      temperature: 1.0,
    };
    if (fmt) body.response_format = fmt;
    for (const think of [{ type: 'disabled' }, null]) {
      const b = { ...body };
      if (think) b.thinking = think; else delete b.thinking;
      const r = await fetch(BASE.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
        body: JSON.stringify(b),
      });
      const d = await r.json().catch(() => null);
      if (!d || d.error) continue;
      const raw = d?.choices?.[0]?.message?.content || '';
      const lines = tryParseLines(raw);
      if (lines) return lines;
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
    const pet = l.pet === SIDE ? SIDE : MAIN;
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
async function tick(why) {
  if (running) return;
  running = true;
  try {
    if (await anySleeping()) { console.log(`[${why}] 有人睡着,跳过`); return; }
    const actions = await animPool().catch(() => []);
    const hot = await hotTopics().catch(() => '');
    const lines = await improvise(screenshot(), actions, hot);
    console.log(`[${new Date().toLocaleTimeString()}] (${why}) 姐妹同屏会:`);
    await playLines(lines, actions);
  } catch (e) {
    console.error(`[screen-talk] ${why}:`, e.message);
  } finally {
    running = false;
  }
}

console.log(`[screen-talk] every ${INTERVAL}s, ${WINDOW} Beijing, days=${DAYS.join(',')}, CN-holidays excluded; model=${MODEL} key=${KEY ? 'set' : 'MISSING'}`);
if (process.argv.includes('--gen')) {
  // 只生成不播出:验证 LLM 是否给两只都分配了台词
  const a = await animPool().catch(() => []);
  const hot = await hotTopics().catch(() => '');
  const lines = await improvise(screenshot(), a, hot);
  for (const l of lines) console.log(`${l.pet}: ${l.text} (${l.anim})`);
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
