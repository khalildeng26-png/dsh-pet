// personality-menu.mjs — 右键「更多→性格」切换守护。
// 常驻轮询:注册 6 个菜单项(姐姐/妹妹各 3 种性格,✓ 标当前),点击 →
//   1. 改写 main-config.jsonc 对应宠物的 whisperPrompt(文件写入=软生效,宿主热加载,不重启助手、宠物不闪;
//      千万别走 PUT /config——那条路必重启 Helper)
//   2. 写 .personality.json 状态(screen-talk/look-screen/theater 每轮现读,下一场对话立即换声线)
//   3. 弹一句该性格的切换台词(不调模型,即时)
// Env: PERS_CONFIG(配置文件路径;缺省 DSH_HOME/dsh-pet/main-config.jsonc → ~/.dsh/dsh-pet/main-config.jsonc)
import { readFileSync, writeFileSync, openSync, closeSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath as __ftp } from 'node:url';
import { PERSONALITIES, PET_NAMES, PERS_FILE, readPersonality, renderWhisperPrompt, current } from './personalities.mjs';
const __here = (p) => __ftp(new URL(p, import.meta.url));

// 单实例锁(90s 心跳,与三件套同一套姿势)
const LOCK_FILE = process.env.PERS_LOCK_FILE || __here('./.personality-menu.lock');
try {
  if (Date.now() - statSync(LOCK_FILE).mtimeMs < 90000) { console.error('[personality] already running, exit'); process.exit(0); }
} catch {}
try { closeSync(openSync(LOCK_FILE, 'w')); } catch {}
setInterval(() => { try { utimesSync(LOCK_FILE, new Date(), new Date()); } catch { try { closeSync(openSync(LOCK_FILE, 'w')); } catch {} } }, 30000).unref?.();

const API = process.env.PET_API || 'http://127.0.0.1:3080/dsh-pet-7340';
// 定向 owner(`分支名@petId`):fork 渲染端只在本宠物的右键菜单里显示并收进「更多→性格」子菜单
// ——右键姐姐只出姐姐的 3 项,右键妹妹只出妹妹的 3 项。老渲染端(不认约定)退化为全部平铺,点击仍正确。
const OWNER_OF = (pet) => `性格@${pet}`;
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const CONFIG = process.env.PERS_CONFIG || join(dshHome, 'dsh-pet', 'main-config.jsonc');

async function j(method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t, status: r.status }; }
}

// 菜单项:当前性格带 ✓ 前缀(注册是 owner 级整体覆盖,切换后重注册,下一次右键即见新 ✓)。
// 子菜单已按宠物分流,不再需要「姐姐·」前缀。
function labels(pet) {
  const st = readPersonality();
  return PERSONALITIES[pet].map((p) => (st[pet] === p.key ? '✓ ' : '') + p.label);
}

async function surfaceOf(pet) {
  const cfg = await j('GET', '/config');
  const p = (cfg?.main ?? cfg)?.pets?.find((x) => x.id === pet);
  const d = p?.display || 'both';
  return d === 'none' ? 'any' : d;
}

// 微锁播出:只在写气泡的一瞬拿锁,写完即放(与 screen-talk 同姿势,宠物全程自由)
async function say(pet, text) {
  try {
    const sf = await surfaceOf(pet);
    const lk = await j('POST', `/lock?pet=${pet}&surface=${sf}`, {});
    const id = lk?.lockId;
    if (!id) return;
    try {
      await j('POST', `/broadcast?pet=${pet}&surface=${sf}&lock=${id}`, { text: String(text).slice(0, 40), seconds: 7, anim: false });
    } finally {
      await j('POST', `/lock/release?pet=${pet}`, { lockId: id }).catch(() => {});
    }
  } catch (e) {
    console.error('[personality] say failed:', e.message);
  }
}

// 切换:改 whisperPrompt + 写状态。配置是宿主也会写的文件——这里读改写整份,
// 与宿主写入撞车是极小概率事件(宿主只在用户改设置时写),可接受。
function switchTo(pet, key) {
  const pers = PERSONALITIES[pet].find((p) => p.key === key);
  if (!pers) throw new Error('unknown personality: ' + key);
  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
  const ent = cfg?.pets?.find((p) => p?.id === pet);
  if (!ent) throw new Error(`pet ${pet} not found in ${CONFIG}`);
  ent.whisperPrompt = renderWhisperPrompt(pet, pers);
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  const st = readPersonality();
  st[pet] = key;
  writeFileSync(PERS_FILE, JSON.stringify(st), 'utf8');
}

// 每只宠物一条独立循环:注册自己的定向 owner → 长轮询自己的事件 → 处理。
// 两条循环互不等待,点谁切谁,零串扰。
async function petLoop(pet) {
  for (;;) {
    try {
      await j('POST', '/menu/item', { owner: OWNER_OF(pet), labels: labels(pet), target: 'both' });
      const ev = await j('GET', `/menu/events?owner=${encodeURIComponent(OWNER_OF(pet))}&wait=9000`);
      for (const [label, clickedOn] of Object.entries(ev?.events ?? {})) {
        // poll 返回的是全量 label 映射,没被点的值是 null——必须过滤,否则每个轮询周期
        // 都会把全部性格空走一遍(气泡刷屏+✓永远收敛在最后一项,实测踩过)
        if (!clickedOn || typeof clickedOn !== 'string') continue;
        const pers = PERSONALITIES[pet].find((p) => p.label === label.replace(/^✓ /, ''));
        if (!pers) continue;
        if (current(pet).key === pers.key) {
          await say(pet, `人家本来就是「${pers.label}」啦!`);
          continue;
        }
        try {
          switchTo(pet, pers.key);
          console.log(`[personality] ${PET_NAMES[pet]} → ${pers.label} (点击自 ${clickedOn})`);
          await say(pet, pers.switchLine);
        } catch (e) {
          console.error('[personality] switch failed:', e.message);
          await say(pet, '呜,性格切换卡住了,再点一次试试……');
        }
      }
    } catch (e) {
      console.error(`[personality] loop(${pet}):`, e.message, '- retry 5s');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function main() {
  console.log(`[personality] config=${CONFIG} state=${PERS_FILE}`);
  // 清掉旧版无标记 owner(避免旧渲染端同时看到 6 项平铺 + 定向子菜单两份)
  await j('DELETE', '/menu/item?owner=' + encodeURIComponent('性格')).catch(() => {});
  await Promise.all(Object.keys(PERSONALITIES).map((pet) => petLoop(pet)));
}
main();
