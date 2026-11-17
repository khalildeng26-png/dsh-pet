// hot.mjs — 近期热点抓取(60s API:微博/知乎热榜 + 每日新闻),文件缓存 45 分钟,失败退旧缓存
// 供 screen-talk / pet-theater 注入提示词:模型由此获得"近半月的梗",不靠硬编码
// 话题级轮换:同一份缓存池里,最近两场喂过的条目优先排除——否则模型每场都挑池子里
// "最有梗"的那两三条,45 分钟缓存期内翻来覆去就那几个话题(用户实测吐槽过)。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CACHE_FILE = fileURLToPath(new URL('./.hot-cache.json', import.meta.url));
const RECENT_FILE = fileURLToPath(new URL('./.hot-recent.json', import.meta.url));
const TTL_MS = 45 * 60 * 1000;

async function fetchJson(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
    const d = await r.json();
    return d?.data ?? null;
  } catch { return null; }
}

/** 读缓存(新鲜才返回) */
function freshCache() {
  try {
    const st = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, 'utf8')) : null;
    if (st?.text && Date.now() - st.at < TTL_MS) return st.text;
  } catch {}
  return null;
}

/** 过期但有货也先返回(断网兜底) */
function staleCache() {
  try {
    const st = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, 'utf8')) : null;
    if (st?.text) return st.text;
  } catch {}
  return null;
}

/** 洗牌(每次调用都不同的素材组合,防模型翻来覆去玩同一批梗) */
function sample(arr, n) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

/** 读/写「最近喂过的条目」(按渠道,滚动两场量;坏文件=没有轮换约束,不影响出料) */
function loadRecent() {
  try { return JSON.parse(readFileSync(RECENT_FILE, 'utf8')); } catch { return {}; }
}
function saveRecent(map) {
  try { writeFileSync(RECENT_FILE, JSON.stringify(map)); } catch {}
}

/** 对「完整池文本」随机抽样成「本场素材」:各渠道抽样数 + 排除最近两场喂过的条目(不够再回填) */
function sampleRows(poolText) {
  const TAKE = { '微博': 6, '知乎': 4, 'B站热搜': 5, 'B站热门': 4, '头条': 5, '抖音': 5, '贴吧': 4 };
  const recent = loadRecent();
  const rows = poolText.split('\n').filter(Boolean);
  const out = rows.map((row) => {
    const sep = row.indexOf(': ');
    const head = sep >= 0 ? row.slice(0, sep) : '';
    const items = [...new Set((sep >= 0 ? row.slice(sep + 2) : row).split(' / ').filter(Boolean))];
    const hit = Object.keys(TAKE).find((k) => head.includes(k));
    const take = hit ? TAKE[hit] : 5;
    const used = new Set(Array.isArray(recent[head]) ? recent[head] : []);
    let fresh = items.filter((x) => !used.has(x));
    if (fresh.length < take) fresh = fresh.concat(items.filter((x) => used.has(x))); // 池子小就回填,宁重不空
    const picked = sample(fresh, Math.min(fresh.length, take));
    recent[head] = picked.slice(); // 记录本场所选;按渠道滚动截断
    return head + ': ' + picked.join(' / ');
  });
  // 滚动截断:每渠道只留最近两场(2×take)的量,过期自然放回可选池
  for (const [head, arr] of Object.entries(recent)) {
    const hit = Object.keys(TAKE).find((k) => head.includes(k));
    const cap = 2 * (hit ? TAKE[hit] : 5);
    if (Array.isArray(arr) && arr.length > cap) recent[head] = arr.slice(-cap);
  }
  saveRecent(recent);
  return out.join('\n');
}

/**
 * 返回一段紧凑的热点文本,失败返回 ''(调用方跳过注入即可)。
 * 缓存存完整池(宽抓);每次调用随机抽样 → 同一份数据,每场对话看到不同子集。
 * @param {{ fresh?: boolean }} opts fresh=true 跳过缓存(模型主动搜索时用,保证最新)
 * @returns {Promise<string>}
 */
export async function hotTopics(opts = {}) {
  const cached = opts.fresh ? null : freshCache();
  if (cached) return sampleRows(cached);
  const [weibo, zhihu, news, biliHot, biliRank, toutiao, douyin, tieba] = await Promise.all([
    fetchJson('https://60s.viki.moe/v2/weibo'),
    fetchJson('https://60s.viki.moe/v2/zhihu'),
    fetchJson('https://60s.viki.moe/v2/60s'),
    // B站官方公开接口直连(60s 的 bili 端点已死:上游被反爬);带 UA 防风控
    fetchJson('https://api.bilibili.com/x/web-interface/search/square?limit=16'),
    fetchJson('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all'),
    // 头条/贴吧官方接口直连;抖音走移动端端点(要手机 UA,且 word_list 在顶层不在 data 里)
    fetchJson('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc'),
    (async () => { try { const r = await fetch('https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/', { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)' } }); const d = await r.json(); return Array.isArray(d?.word_list) ? d.word_list : null; } catch { return null; } })(),
    fetchJson('https://tieba.baidu.com/hottopic/browse/topicList'),
  ]);
  const lines = [];
  if (Array.isArray(weibo) && weibo.length) {
    lines.push('微博热榜: ' + weibo.slice(0, 25).map((x) => String(x.title || '').trim()).filter(Boolean).join(' / '));
  }
  if (Array.isArray(zhihu) && zhihu.length) {
    lines.push('知乎热议: ' + zhihu.slice(0, 12).map((x) => String(x.title || '').trim()).filter(Boolean).join(' / '));
  }
  if (news && Array.isArray(news.news) && news.news.length) {
    lines.push('今日新闻: ' + news.news.slice(0, 12).map((x) => String(x).trim()).filter(Boolean).join(' / '));
  }
  const bh = biliHot?.trending?.list;
  if (Array.isArray(bh) && bh.length) {
    lines.push('B站热搜: ' + bh.slice(0, 16).map((x) => String(x.keyword || '').trim()).filter(Boolean).join(' / '));
  }
  const br = biliRank?.list;
  if (Array.isArray(br) && br.length) {
    lines.push('B站热门: ' + br.slice(0, 10).map((x) => String(x.title || '').replace(/【[^】]*】/g, '').trim()).filter(Boolean).join(' / '));
  }
  if (Array.isArray(toutiao) && toutiao.length) {
    lines.push('头条热榜: ' + toutiao.slice(0, 15).map((x) => String(x.Title || '').trim()).filter(Boolean).join(' / '));
  }
  if (Array.isArray(douyin) && douyin.length) {
    lines.push('抖音热搜: ' + douyin.slice(0, 15).map((x) => String(x.word || '').trim()).filter(Boolean).join(' / '));
  }
  const tb = tieba?.bang_topic?.topic_list;
  if (Array.isArray(tb) && tb.length) {
    lines.push('贴吧热议: ' + tb.slice(0, 12).map((x) => String(x.topic_name || '').trim()).filter(Boolean).join(' / '));
  }
  const text = lines.join('\n');
  if (text) {
    try { writeFileSync(CACHE_FILE, JSON.stringify({ at: Date.now(), text })); } catch {}
    return sampleRows(text);
  }
  const stale = staleCache();
  return stale ? sampleRows(stale) : '';
}

/**
 * 完整池文本(不抽样,原样全量):给梗提取等二次加工用。
 * 缓存新鲜直接回;过期就复用 hotTopics 的抓取路径现抓一次,再把缓存原文读回来。
 * @returns {Promise<string>}
 */
export async function rawPool() {
  const cached = freshCache();
  if (cached) return cached;
  await hotTopics();
  return freshCache() || staleCache() || '';
}
