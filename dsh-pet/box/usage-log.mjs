// usage-log.mjs — LLM 调用用量落盘:每笔一行 jsonl,四个脚本共用。
// 背景:用户问「为什么烧了十几块」时只能靠考古推理——从今往后每笔调用的
// prompt/completion/缓存命中都记账,screen-talk --usage 直接出报表。
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const F = fileURLToPath(new URL('./.llm-usage.jsonl', import.meta.url));

/**
 * @param {string} tag 场景标签,如 'screen-talk:屏幕' / 'look-screen' / 'memes' / 'theater'
 * @param {object|null} usage API 响应里的 usage 对象(deepseek 字段:prompt_tokens /
 *   completion_tokens / prompt_cache_hit_tokens / prompt_cache_miss_tokens)
 * @param {object} extra 附加字段(如 mode/model)
 */
export function logUsage(tag, usage, extra = {}) {
  try {
    if (!usage || typeof usage !== 'object') return;
    appendFileSync(F, JSON.stringify({
      ts: new Date().toISOString(),
      tag,
      pt: usage.prompt_tokens ?? 0,
      ct: usage.completion_tokens ?? 0,
      hit: usage.prompt_cache_hit_tokens ?? 0,
      miss: usage.prompt_cache_miss_tokens ?? 0,
      ...extra,
    }) + '\n');
  } catch { /* 记账失败不影响业务 */ }
}
