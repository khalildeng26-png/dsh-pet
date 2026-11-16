// hot.mjs — 近期热点抓取(60s API:微博/知乎热榜 + 每日新闻),文件缓存 45 分钟,失败退旧缓存
// 供 screen-talk / pet-theater 注入提示词:模型由此获得"近半个月的梗",不靠硬编码
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CACHE_FILE = fileURLToPath(new URL('./.hot-cache.json', import.meta.url));
const TTL_MS = 45 * 60 * 1000;

async function fetchJson(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
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

/**
 * 返回一段紧凑的热点文本(约 300-500 字),失败返回 ''(调用方跳过注入即可)。
 * @param {{ fresh?: boolean }} opts fresh=true 跳过缓存(模型主动搜索时用,保证最新)
 * @returns {Promise<string>}
 */
export async function hotTopics(opts = {}) {
  const cached = opts.fresh ? null : freshCache();
  if (cached) return cached;
  const [weibo, zhihu, news] = await Promise.all([
    fetchJson('https://60s.viki.moe/v2/weibo'),
    fetchJson('https://60s.viki.moe/v2/zhihu'),
    fetchJson('https://60s.viki.moe/v2/60s'),
  ]);
  const lines = [];
  if (Array.isArray(weibo) && weibo.length) {
    lines.push('微博热榜: ' + weibo.slice(0, 8).map((x) => String(x.title || '').trim()).filter(Boolean).join(' / '));
  }
  if (Array.isArray(zhihu) && zhihu.length) {
    lines.push('知乎热议: ' + zhihu.slice(0, 5).map((x) => String(x.title || '').trim()).filter(Boolean).join(' / '));
  }
  if (news && Array.isArray(news.news) && news.news.length) {
    lines.push('今日新闻: ' + news.news.slice(0, 8).map((x) => String(x).trim()).filter(Boolean).join(' / '));
  }
  const text = lines.join('\n');
  if (text) {
    try { writeFileSync(CACHE_FILE, JSON.stringify({ at: Date.now(), text })); } catch {}
    return text;
  }
  return staleCache() || '';
}
