// look-screen.mjs — dsh-pet companion: menu "看看屏幕" + optional auto-look timer
// Env config:
//   LOOK_BASE     OpenAI-compatible base (default https://api.deepseek.com)
//   LOOK_KEY      API key
//   LOOK_MODEL    vision-capable model (default deepseek-flash)
//   LOOK_INTERVAL auto-look seconds (default 60; 0 = manual menu only)
import { spawnSync } from 'node:child_process';
import { readFileSync, openSync, closeSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { current } from './personalities.mjs';
import { fileURLToPath as __ftp } from 'node:url';
const __here = (p) => __ftp(new URL(p, import.meta.url));

// 单实例锁:已有活实例(90s 内有心跳)就退出,防双击 vbs 双开(双开=双倍看屏计费)
const LOCK_FILE = __here('./.look-screen.lock');
try {
  if (Date.now() - statSync(LOCK_FILE).mtimeMs < 90000) { console.error('[look-screen] already running, exit'); process.exit(0); }
} catch {}
try { closeSync(openSync(LOCK_FILE, 'w')); } catch {}
setInterval(() => { try { utimesSync(LOCK_FILE, new Date(), new Date()); } catch { try { closeSync(openSync(LOCK_FILE, 'w')); } catch {} } }, 30000).unref?.();

const PET_API = process.env.PET_API || 'http://127.0.0.1:3080/dsh-pet-7340';
const BASE = process.env.LOOK_BASE || 'https://api.deepseek.com';
const KEY = process.env.LOOK_KEY || '';
const MODEL = process.env.LOOK_MODEL || 'deepseek-flash';
const INTERVAL = Number(process.env.LOOK_INTERVAL ?? 60);
const WINDOW = process.env.LOOK_WINDOW || ''; // e.g. "9:00-18:30" Beijing time; empty = all day
const DAYS = (process.env.LOOK_DAYS || '1,2,3,4,5').split(',').map(Number); // 1=Mon ... 7=Sun
const MAKEUP = process.env.LOOK_MAKEUP === '1'; // treat 调休补班日 as workdays
const HOLIDAYS_FILE = process.env.LOOK_HOLIDAYS_FILE || __here('./holidays.json');
const PET = process.env.LOOK_PET || 'main';

const OWNER = 'look-screen';
const LABEL = '看看屏幕';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 分宠人设:谁触发看屏就用谁的口吻;互相认识,不说分身。
// 性格段随右键「更多→性格」切换动态取(.personality.json,每次看屏现读,切换立即生效)。
const LOOK_TAIL = '看不清的内容绝不编造,宁可只聊能看清的。不要解释你是AI,不要emoji,不要每句都说"屏幕"。';
const personaFor = (pet) => {
  const isSide = pet === 'maid-2';
  const p = current(isSide ? 'maid-2' : 'main') || { persona: '', styleTail: '' };
  if (!isSide) {
    return `你是主人桌面上的Q版蓝发小女仆,名叫「蓝毛小女仆」,是姐姐。${p.persona}你有个亲妹妹叫「小跟班」——屏幕上若出现另一只更小只的同款鲸鱼女仆,那就是她,是妹妹本人,绝不是你的分身、克隆或倒影,提到她要叫妹妹或小跟班。刚瞥了一眼主人的电脑屏幕,用一两句话(35字以内)以姐姐口吻吐槽或关心。俏皮口语化。${LOOK_TAIL}`;
  }
  return `你是主人的Q版鲸鱼女仆,名叫「小跟班」,是妹妹。${p.persona}你姐姐叫「蓝毛小女仆」——屏幕上若出现另一只更大只的同款鲸鱼女仆,那就是她,是姐姐本人,绝不是你的分身或克隆,提到她要叫姐姐。刚瞥了一眼主人的电脑屏幕,用一两句话(35字以内)以妹妹口吻吐槽或撒娇。活泼俏皮。${LOOK_TAIL}`;
};

async function j(method, path, body) {
  const r = await fetch(PET_API + path, {
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

async function vision(b64, pet) {
  // 手动看屏开思考:先真看懂再开口(关思考=扫一眼凭直觉瞎编,小字看不清就开始幻觉);
  // 思考路失败再退关闭路
  for (const think of [{ type: 'enabled', budget_tokens: 2500 }, { type: 'disabled' }]) {
    const body = {
      model: MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
          { type: 'text', text: personaFor(pet) },
        ],
      }],
      max_tokens: 3500, // 思考 token 计入 max_tokens——budget 限思考,正文留保底(按实际用量计费)
      temperature: 0.9,
    };
    if (think) body.thinking = think;
    const r = await fetch(BASE.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => null);
    if (!d || d.error) { if (think) continue; throw new Error('api: ' + JSON.stringify(d).slice(0, 120)); }
    const m = d?.choices?.[0]?.message ?? {};
    const text = m.content || (Array.isArray(m.content) ? m.content.map(c => c.text || '').join('') : '');
    if (text && text.trim()) return String(text).trim().replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 60);
    if (!think) throw new Error('vision reply empty: ' + JSON.stringify(d).slice(0, 150));
  }
  throw new Error('vision failed');
}

async function isSleeping(pet) {
  try {
    const st = await j('GET', '/state');
    return st?.pets?.[pet]?.sleep?.sleeping === true;
  } catch { return false; }
}

async function surfaceOf(pet) {
  const cfg = await j('GET', '/config');
  const p = (cfg?.main ?? cfg)?.pets?.find(x => x.id === pet);
  const d = p?.display || 'both';
  return d === 'none' ? 'any' : d;
}

async function say(pet, text) {
  const sf = await surfaceOf(pet);
  const lock = await j('POST', `/lock?pet=${pet}&surface=${sf}`, {});
  const id = lock?.lockId;
  try {
    await j('POST', `/broadcast?pet=${pet}&surface=${sf}${id ? `&lock=${id}` : ''}`, { text, seconds: 8 });
    // 锁握满整句话的显示时长:说话期间宠物完全静止,随机动作/碎碎念/工作状态全部让路,说完才放
    await sleep(8200);
  } finally {
    if (id) await j('POST', `/lock/release?pet=${pet}`, { lockId: id });
  }
}

async function handle(pet, why) {
  pet = pet || PET;
  if (await isSleeping(pet)) { console.log(`[look-screen] ${pet} sleeping, skip (${why})`); return; }
  try {
    const text = await vision(screenshot(), pet);
    await say(pet, text);
    console.log(`[${new Date().toLocaleTimeString()}] (${why}) ${pet}: ${text}`);
  } catch (e) {
    console.error(`[look-screen] ${why} error:`, e.message);
    if (why === 'menu') { try { await say(pet, '呜,我眼睛进沙子了,没看清……'); } catch {} }
  }
}

async function menuLoop() {
  for (;;) {
    try {
      await j('POST', '/menu/item', { owner: OWNER, labels: [LABEL], target: 'both' });
      const ev = await j('GET', `/menu/events?owner=${OWNER}&wait=25000`);
      for (const [label, pet] of Object.entries(ev?.events ?? {})) {
        if (pet && typeof pet === 'string') { console.log(`[look-screen] menu click: ${label} on ${pet}`); await handle(pet, 'menu'); }
      }
    } catch (e) {
      console.error('[look-screen] menu loop:', e.message, '- retry 5s');
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

function loadCalendar() {
  try {
    const d = JSON.parse(readFileSync(HOLIDAYS_FILE, 'utf8'));
    return { holidays: new Set(d.holidays || []), workdays: new Set(d.workdays || []) };
  } catch { return { holidays: new Set(), workdays: new Set() }; }
}

const DT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const WD = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' });
const TM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: 'numeric', minute: 'numeric', hour12: false });
const WDN = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function inWindow(now = new Date()) {
  const date = DT.format(now);                      // YYYY-MM-DD Beijing
  const wd = WDN[WD.format(now)] ?? 1;              // 1=Mon..7=Sun
  const [ch, cm] = TM.format(now).split(':').map(Number);
  const cur = (ch % 24) * 60 + cm;
  const cal = loadCalendar();
  if (cal.holidays.has(date)) return false;         // 法定节假日不看
  const makeup = cal.workdays.has(date);            // 调休补班日
  if (!(MAKEUP && makeup) && !DAYS.includes(wd)) return false; // 周末不看(补班日按 LOOK_MAKEUP)
  if (WINDOW) {
    const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
    const [a, b] = WINDOW.split('-');
    const s = toMin(a), e = toMin(b);
    const inT = s <= e ? (cur >= s && cur < e) : (cur >= s || cur < e);
    if (!inT) return false;
  }
  return true;
}

async function autoLoop() {
  if (!(INTERVAL > 0)) { console.log('[look-screen] auto-look disabled (LOOK_INTERVAL<=0)'); return; }
  console.log(`[look-screen] auto-look every ${INTERVAL}s on "${PET}"${WINDOW ? `, ${WINDOW} Beijing` : ', all day'}, days=${DAYS.join(',')}${MAKEUP ? ' +makeup-workdays' : ''}, CN-holidays excluded (${HOLIDAYS_FILE})`);
  let wasIn = inWindow();
  for (;;) {
    await new Promise(r => setTimeout(r, INTERVAL * 1000));
    const isIn = inWindow();
    if (isIn !== wasIn) { console.log(`[look-screen] auto-look ${isIn ? 'ACTIVE' : 'PAUSED'}`); wasIn = isIn; }
    if (!isIn) continue;
    await handle(PET, 'auto');
  }
}

console.log(`[look-screen] pet=${PET} model=${MODEL} base=${BASE} key=${KEY ? 'set' : 'MISSING'}`);
if (!KEY) console.warn('[look-screen] WARNING: LOOK_KEY empty - vision calls will fail');
await Promise.all([menuLoop(), autoLoop()]);
