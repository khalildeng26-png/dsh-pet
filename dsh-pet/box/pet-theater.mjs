// pet-theater.mjs — 姐妹小剧场: lock two pets, walk side-pet over, LLM-improvised dialogue, anims, walk back
// Env: TH_BASE (default https://api.deepseek.com) / TH_KEY / TH_MODEL (default deepseek-flash)
//   PET_MAIN (default main) / PET_SIDE (default maid-2)
// Usage: node pet-theater.mjs           -> menu mode (right-click 更多 -> 姐妹小剧场)
//        node pet-theater.mjs --once    -> play one scene immediately
import { readFileSync, openSync, closeSync, statSync, utimesSync } from 'node:fs';
import { hotTopics } from './hot.mjs';
import { fileURLToPath as __ftp } from 'node:url';
const __here = (p) => __ftp(new URL(p, import.meta.url));

// 单实例锁:已有活实例(90s 内有心跳)就退出,防双开
const LOCK_FILE = __here('./.pet-theater.lock');
try {
  if (Date.now() - statSync(LOCK_FILE).mtimeMs < 90000) { console.error('[theater] already running, exit'); process.exit(0); }
} catch {}
try { closeSync(openSync(LOCK_FILE, 'w')); } catch {}
setInterval(() => { try { utimesSync(LOCK_FILE, new Date(), new Date()); } catch { try { closeSync(openSync(LOCK_FILE, 'w')); } catch {} } }, 30000).unref?.();

const API = process.env.PET_API || 'http://127.0.0.1:3080/dsh-pet-7340';
const BASE = process.env.TH_BASE || 'https://api.deepseek.com';
const KEY = process.env.TH_KEY || '';
const MODEL = process.env.TH_MODEL || 'deepseek-flash';
const MAIN = process.env.PET_MAIN || 'main';
const SIDE = process.env.PET_SIDE || 'maid-2';
const OWNER = 'theater';
const LABEL = '姐妹小剧场';
const THEMES = ['今天主人的屏幕上有什么', '姐妹争论谁擦桌子更干净', '讨论午饭吃什么', '比谁的鲸鱼尾巴更软', '吐槽主人又熬夜', '商量给主人准备惊喜', '回忆上次打翻的火锅', '练习女仆礼仪谁更标准'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function j(method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t, status: r.status }; }
}

async function surfaceOf(pet) {
  const cfg = await j('GET', '/config');
  const p = (cfg?.main ?? cfg)?.pets?.find(x => x.id === pet);
  const d = p?.display || 'both';
  return d === 'none' ? 'any' : d;
}

async function lock(pet, surface) {
  const r = await j('POST', `/lock?pet=${pet}&surface=${surface}`, {});
  if (!r?.lockId) throw new Error(`lock ${pet} failed: ${JSON.stringify(r).slice(0, 120)}`);
  return r.lockId;
}
const unlock = (pet, lockId) => j('POST', `/lock/release?pet=${pet}`, { lockId });

async function pose(pet) {
  const p = await j('GET', `/pose?pet=${pet}`);
  if (typeof p?.x !== 'number') throw new Error(`pose ${pet} failed: ${JSON.stringify(p).slice(0, 100)}`);
  return p;
}

async function animPool() {
  const cfg = await j('GET', '/config');
  const m = cfg?.main ?? cfg;
  const a = m?.animations ?? {};
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
      if (Array.isArray(lines) && lines.length) return lines.filter(l => l && l.text).slice(0, 6);
    } catch {}
  }
  return null;
}

async function improvise(actions) {
  const theme = THEMES[Math.floor(Math.random() * THEMES.length)];
  const hot = await hotTopics().catch(() => '');
  const hotBlock = hot ? `\n【近期真实热搜】(妹妹玩梗的素材库,可挑1-2个自然融入,不合适就完全不用)\n${hot}\n` : '';
  const list = actions.slice(0, 40).join(',');
  const sys = `你是Q版鲸鱼女仆姐妹小剧场的导演,要写得有梗、好笑、像真人姐妹斗嘴。
姐姐「蓝毛小女仆」(代称${MAIN}):温柔皮囊毒舌芯,傲娇操心命,会给主人记"道歉账",玩梗慢半拍还一本正经,口头禅"真是的~""主人心里没点数吗"。
妹妹「小跟班」(代称${SIDE}):网络冲浪十级学者+吃货,热梗第一手,能为零食出卖姐姐,口头禅"家人们谁懂啊!""这波啊,这波是XX""姐姐听我说!"。
两人是亲姐妹,互怼是爱的语言,台词里互称姐姐/妹妹。${hotBlock}
只输出严格JSON,格式 {"lines":[{"pet":"${MAIN}|${SIDE}","anim":"动作名","text":"台词"}]},恰好4行且两人交替出现,妹妹负责玩梗、姐姐负责毒舌吐槽,text为不超过18个汉字的口语台词且不含引号,anim必须从: ${list} 中选,不要输出JSON以外的任何内容。`;
  for (const fmt of [{ type: 'json_object' }, null]) {
    const body = {
      model: MODEL,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: `即兴主题:${theme}` },
      ],
      max_tokens: 600, temperature: 1.0,
    };
    if (fmt) body.response_format = fmt;
    const r = await fetch(BASE.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => null);
    if (!d || d.error) { if (fmt) continue; throw new Error('api: ' + JSON.stringify(d).slice(0, 120)); }
    const raw = d?.choices?.[0]?.message?.content || '';
    const lines = tryParseLines(raw);
    if (lines) return lines;
    if (!fmt) throw new Error('unparseable reply: ' + raw.slice(0, 120));
  }
  throw new Error('improvise failed');
}

let running = false;

async function runScene(why) {
  if (running) { console.log('[theater] scene already running, skip'); return; }
  running = true;
  console.log(`[theater] scene start (${why}) ${new Date().toLocaleTimeString()}`);
  let lockMain = null, lockSide = null;
  try {
    // ① 先把台词写好、信息备齐(此阶段宠物自由活动,不锁不僵直)
    const actions = await animPool().catch(() => []);
    const lines = await improvise(actions);
    const [sMain, sSide] = await Promise.all([surfaceOf(MAIN), surfaceOf(SIDE)]);
    const homeSide = await pose(SIDE).catch(() => null);
    const mp = await pose(MAIN).catch(() => ({ x: 0.82, y: 0.2 }));
    // ② 开场:锁双宠 → 妹妹走过去 → 立刻开演(锁上到第一句台词之间只有走位时间)
    lockMain = await lock(MAIN, sMain);
    lockSide = await lock(SIDE, sSide);
    const tx = Math.max(0.02, Math.min(0.86, mp.x - 0.13)), ty = Math.max(0.05, Math.min(0.9, mp.y + 0.04));
    await j('POST', `/position?pet=${SIDE}&surface=${sSide}&lock=${lockSide}`, { x: tx, y: ty, mode: 'spring' });
    await sleep(2200);
    for (const l of lines) {
      const pet = l.pet === SIDE ? SIDE : MAIN;
      const lk = pet === SIDE ? lockSide : lockMain;
      const sf = pet === SIDE ? sSide : sMain;
      await j('POST', `/broadcast?pet=${pet}&surface=${sf}&lock=${lk}`, { text: String(l.text).slice(0, 40), seconds: 6, anim: actions.includes(l.anim) ? l.anim : false });
      console.log(`[theater] ${pet}: ${l.text}  (${l.anim})`);
      await sleep(6500);
    }
    // ③ 收场:妹妹回家
    if (homeSide) {
      await j('POST', `/position?pet=${SIDE}&surface=${sSide}&lock=${lockSide}`, { x: homeSide.x, y: homeSide.y, mode: 'spring' });
    }
    console.log(`[theater] scene end, all clear`);
  } catch (e) {
    console.error('[theater] scene error:', e.message);
  } finally {
    if (lockSide) await unlock(SIDE, lockSide).catch(() => {});
    if (lockMain) await unlock(MAIN, lockMain).catch(() => {});
    running = false;
  }
}

// —— 时间窗(与看屏同一套规则:北京时间 + 工作日 + 法定节假日排除)——
const WINDOW = process.env.TH_WINDOW || '9:00-18:30';
const DAYS = (process.env.TH_DAYS || '1,2,3,4,5').split(',').map(Number);
const HOLIDAYS_FILE = process.env.TH_HOLIDAYS_FILE || __here('./holidays.json');
const AUTO_MIN = Number(process.env.TH_AUTO_MIN ?? 20); // 随机触发间隔下限(分钟)
const AUTO_MAX = Number(process.env.TH_AUTO_MAX ?? 60); // 上限

function loadCalendar() {
  try {
    const d = JSON.parse(readFileSync(HOLIDAYS_FILE, 'utf8'));
    return { holidays: new Set(d.holidays || []), workdays: new Set(d.workdays || []) };
  } catch { return { holidays: new Set(), workdays: new Set() }; }
}

const TH_DT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const TH_WD = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' });
const TH_TM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: 'numeric', minute: 'numeric', hour12: false });
const TH_WDN = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function inWindow(now = new Date()) {
  const date = TH_DT.format(now);
  const wd = TH_WDN[TH_WD.format(now)] ?? 1;
  const [ch, cm] = TH_TM.format(now).split(':').map(Number);
  const cur = (ch % 24) * 60 + cm;
  const cal = loadCalendar();
  if (cal.holidays.has(date)) return false;
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

async function autoLoop() {
  if (!(AUTO_MIN > 0)) { console.log('[theater] auto trigger disabled'); return; }
  console.log(`[theater] auto trigger: every ${AUTO_MIN}-${AUTO_MAX}min within ${WINDOW} Beijing, days=${DAYS.join(',')}, CN-holidays excluded`);
  for (;;) {
    const waitMin = AUTO_MIN + Math.random() * Math.max(0, AUTO_MAX - AUTO_MIN);
    await sleep(waitMin * 60000);
    try {
      if (!inWindow()) { console.log('[theater] auto tick outside window, skip'); continue; }
      if (running) continue;
      await runScene('auto');
    } catch (e) {
      console.error('[theater] auto:', e.message);
    }
  }
}

if (process.argv.includes('--once')) {
  if (!KEY) { console.error('TH_KEY not set'); process.exit(1); }
  await runScene('once');
} else {
  console.log(`[theater] menu "${LABEL}" @ ${API}; key=${KEY ? 'set' : 'MISSING'}`);
  await Promise.all([
    (async () => {
      for (;;) {
        try {
          await j('POST', '/menu/item', { owner: OWNER, labels: [LABEL], target: 'both' });
          const ev = await j('GET', `/menu/events?owner=${OWNER}&wait=25000`);
          for (const [label, pet] of Object.entries(ev?.events ?? {})) {
            if (pet && typeof pet === 'string') { console.log(`[theater] menu click: ${label} (on ${pet})`); await runScene('menu'); }
          }
        } catch (e) {
          console.error('[theater] loop:', e.message, '- retry 5s');
          await sleep(5000);
        }
      }
    })(),
    autoLoop(),
  ]);
}
