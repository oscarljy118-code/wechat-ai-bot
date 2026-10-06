// ============================================================
// 记忆检索器 — FTS5 关键词召回 + LLM 重排序
// ============================================================
import { searchFragments, searchMessages, touchFragments, getLatestSummaries } from './db.js';
import { analyze } from './llm.js';
import { config } from './config.js';

const SUBJECT = config.persona.subjectName;

/**
 * 计算两条文本的简单 Jaccard 相似度（基于字符 bigram）
 */
function jaccardSimilarity(a, b) {
  const bigrams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const sa = bigrams(a);
  const sb = bigrams(b);
  let intersection = 0;
  for (const bg of sa) {
    if (sb.has(bg)) intersection++;
  }
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 去重：相似度 > 0.7 的只保留第一个（rank 更高的）
 */
function dedupeBySimilarity(items, threshold = 0.7) {
  const kept = [];
  for (const item of items) {
    const isDup = kept.some((k) => jaccardSimilarity(k.content, item.content) > threshold);
    if (!isDup) kept.push(item);
  }
  return kept;
}

/**
 * LLM 重排序：给定候选记忆 + 当前用户消息 → 选出最相关的
 */
async function rerankWithLLM(userMessage, candidates) {
  if (candidates.length === 0) return [];

  const topK = config.memory.retrievalTopK;
  if (candidates.length <= topK) return candidates;

  const numbered = candidates.map((c, i) => `[${i + 1}] [${c.type || c.sender || 'msg'}] ${c.content}`).join('\n');

  const rerankPrompt = `你是一个记忆筛选器。

当前对方发来的消息：
「${userMessage.slice(0, 200)}」

候选记忆（带编号）：
${numbered}

选出和当前对话最相关的记忆（最多 ${topK} 条）。
只返回 JSON 数组，如 [2,5,7]。
如果没有相关的，返回 []。`;

  try {
    const raw = await analyze(rerankPrompt);
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    let indices;
    try {
      indices = JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\[[\d,\s]*\]/);
      if (match) indices = JSON.parse(match[0]);
      else return candidates.slice(0, topK);
    }
    if (!Array.isArray(indices) || indices.length === 0) return candidates.slice(0, topK);

    return indices
      .map((i) => candidates[i - 1])
      .filter(Boolean)
      .slice(0, topK);
  } catch {
    return candidates.slice(0, topK);
  }
}

/**
 * 将记忆格式化为注入 prompt 的文本块
 */
export function formatMemoriesForPrompt(memories) {
  if (memories.length === 0) return '';

  const lines = memories.map((m) => {
    const label = m.type
      ? { fact: '事实', preference: '偏好', emotion: '情绪', event: '事件' }[m.type] || '记忆'
      : '对话';
    return `- [${label}] ${m.content}`;
  });

  return `\n\n对 ${SUBJECT} 已知的信息（如果和当前对话无关，忽略即可）：\n${lines.join('\n')}`;
}

/**
 * 同步检索：FTS5 搜索 → 合并去重 → LLM 重排序 → 返回 topK 记忆
 */
export async function retrieveMemories(userMessage) {
  const rerankCandidates = config.memory.rerankCandidates;

  // FTS5 关键词召回
  const fragHits = searchFragments(userMessage, rerankCandidates);
  const msgHits = searchMessages(userMessage, Math.floor(rerankCandidates / 2));

  // 合并：记忆碎片优先（已经过人工筛选），再混合原始消息
  const merged = [...fragHits, ...msgHits.map((m) => ({ ...m, type: null }))];

  // 去重
  const deduped = dedupeBySimilarity(merged, 0.7);

  if (deduped.length === 0) {
    // FTS5 没命中时，注入最近摘要作为兜底
    const summaries = getLatestSummaries(2);
    if (summaries.length > 0) {
      return summaries.map((s) => ({ type: null, content: s }));
    }
    return [];
  }

  // LLM 重排序
  const ranked = await rerankWithLLM(userMessage, deduped);

  // 记录访问
  const fragmentIds = ranked.filter((r) => r.type).map((r) => r.id);
  if (fragmentIds.length > 0) {
    touchFragments(fragmentIds);
  }

  // 混入最近摘要（如果有）
  const summaries = getLatestSummaries(1);
  for (const s of summaries) {
    if (!ranked.some((r) => jaccardSimilarity(r.content, s) > 0.5)) {
      ranked.push({ type: null, content: s });
    }
  }

  return ranked.slice(0, config.memory.retrievalTopK);
}
