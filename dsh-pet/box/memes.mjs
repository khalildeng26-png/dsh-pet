// memes.mjs — 网络梗学习层:和热点(事件新闻)分开的另一条管道。
// 妹妹「玩梗」此前全靠模型训练自带的老梗(翻来覆去家人们谁懂啊),没有学习通道;
// 这里从 8 渠道原始素材(B站热门标题/抖音热词等梗浓度高)让模型提取「真·流行语梗」,
// 每个带含义+用法示例,缓存 2 小时,供 screen-talk/theater 注入当小抄。
// Env: MEME_KEY / MEME_BASE / MEME_MODEL(缺省回落 ST_* 再回落官方 flash)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rawPool } from './hot.mjs';

const MEME_FILE = fileURLToPath(new URL('./.meme-cache.json', import.meta.url));
const TTL_MS = 2 * 60 * 60 * 1000; // 梗的保鲜期比热点长:2 小时一学
const BASE = (process.env.MEME_BASE || process.env.ST_BASE || 'https://api.deepseek.com').replace(/\/$/, '');
const KEY = process.env.MEME_KEY || process.env.ST_KEY || '';
const MODEL = process.env.MEME_MODEL || 'deepseek-flash';

function readCache() {
  try { return JSON.parse(readFileSync(MEME_FILE, 'utf8')); } catch { return null; }
}

function extractMemes(raw) {
  const m = /\{[\s\S]*\}/.exec(raw || '');
  if (!m) return [];
  for (const cand of [m[0], m[0].replace(/,\s*([}\]])/g, '$1')]) {
    try {
      const arr = JSON.parse(cand).memes;
      if (!Array.isArray(arr)) continue;
      const memes = arr
        .filter((x) => x && typeof x.name === 'string' && typeof x.meaning === 'string' && x.name.trim() && x.meaning.trim())
        .map((x) => ({ name: x.name.trim().slice(0, 24), meaning: x.meaning.trim().slice(0, 40), usage: String(x.usage || '').trim().slice(0, 40) }))
        .slice(0, 8);
      if (memes.length) return memes;
    } catch {}
  }
  return [];
}

/**
 * 返回本期梗小抄 [{name, meaning, usage}],拿不到返回 [](调用方跳过注入)。
 * 提取失败退旧缓存(过期也用,总比让妹妹翻老本强)。
 */
export async function memeSheet() {
  const cached = readCache();
  if (cached && Array.isArray(cached.memes) && cached.memes.length && Date.now() - cached.at < TTL_MS) {
    return cached.memes;
  }
  if (!KEY) return cached?.memes ?? [];
  const pool = await rawPool();
  if (!pool) return cached?.memes ?? [];
  // 开思考:「这条是不是真梗(流行语)而非新闻事件」需要一点分辨力;一天 12 次调用,耗得起
  const sys = `你是网络梗研究员。从下面的各平台热榜/热门素材里,提取最近真实流行的网络梗/流行语。
梗 = 正在流传的流行语、句式、谐音、缩写、二创用语(例如「红温」「偷感很重」「city不city」这一类),新闻事件本身不算梗。
只要新近的:「破防」「拉满」「出圈」「YYDS」「绝绝子」这类存在多年的通用老网词不要——主人抱怨的就是翻来覆去老梗。
每个梗给:name(梗名,尽量短)、meaning(含义,20字内)、usage(一句口语用法示例,20字内)。
只提取素材里真实出现或明显正在流传的,宁缺毋滥,最少2个最多8个。
输出严格JSON {"memes":[{"name":"...","meaning":"...","usage":"..."}]},不要输出JSON以外的任何内容。

【素材】
${pool}`;
  try {
    const r = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: sys }],
        // 坑:这套 API 思考 token 计入 max_tokens(实测 reasoning 5.7k~10.4k 吃光任何额度,正文 0 字);
        // budget_tokens 名义收下实际不封顶。提取=扫清单做分类,不是深度推理——直接关思考,稳且快
        max_tokens: 1400,
        thinking: { type: 'disabled' },
      }),
      signal: AbortSignal.timeout(45000),
    });
    const d = await r.json().catch(() => null);
    if (!d || d.error) { console.error('[memes] api error:', JSON.stringify(d).slice(0, 200)); return cached?.memes ?? []; }
    const msg = d?.choices?.[0]?.message;
    const memes = extractMemes(msg?.content || '');
    if (!memes.length) {
      console.error('[memes] parse empty. finish=', d?.choices?.[0]?.finish_reason, 'reasoning len=', (msg?.reasoning_content || '').length, 'content len=', (msg?.content || '').length, 'head=', JSON.stringify((msg?.content || '').slice(0, 120)));
      return cached?.memes ?? [];
    }
    try { writeFileSync(MEME_FILE, JSON.stringify({ at: Date.now(), memes })); } catch {}
    return memes;
  } catch (e) {
    console.error('[memes] extract failed:', e.message);
    return cached?.memes ?? [];
  }
}
