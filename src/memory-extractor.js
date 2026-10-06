// ============================================================
// 记忆提取器 — 异步后台提取记忆碎片 + 滚动摘要生成
// ============================================================
import {
  getExtractionCursor,
  updateExtractionCursor,
  getUnprocessedMessages,
  getNewMessageCountSince,
  getMaxMessageIdValue,
  insertFragment,
  insertSummary,
} from './db.js';
import { analyze } from './llm.js';
import { config } from './config.js';

const CHARACTER = config.persona.characterName;
const SUBJECT = config.persona.subjectName;

// ── 记忆碎片提取 ──

const FRAGMENT_EXTRACTION_PROMPT = `你是一个记忆提取引擎。阅读以下对话片段，从中提取关于 ${SUBJECT} 的"记忆碎片"。

碎片类型：
- fact: 事实信息（工作、生活状态、经历、身份）
- preference: 喜好/厌恶（"喜欢X""讨厌X""觉得X很好/很烂"）
- emotion: 情绪时刻（对方表达了强烈的情绪反应——焦虑、兴奋、难过、愤怒、委屈）
- event: 重要事件（发生了什么事——换了工作、去了哪里、开始/结束什么、认识了谁）

每一条碎片 1-2 句话，独立、可检索。写清楚和 ${SUBJECT} 的关联。

不要提取：
- 闲聊寒暄（"在吗""吃了吗""嗯""哦"）
- ${CHARACTER} 说的话或做的事（只关心 ${SUBJECT}）
- 过于宽泛的信息（"今天心情还行""还行吧"）
- 已经在最近对话中反复出现、毫无新意的内容

返回 JSON 数组。如果没有可提取的，返回 []。
格式：[{"type":"preference","content":"K 觉得冰美式比热咖啡好喝","confidence":0.85}, ...]

只返回 JSON 数组，不要其他内容。`;

async function extractFragments(messages) {
  if (messages.length === 0) return [];

  const formatted = messages
    .filter((m) => m.sender === 'user')
    .map((m) => `${SUBJECT}: ${m.content}`)
    .join('\n');

  if (!formatted) return [];

  const prompt = `${FRAGMENT_EXTRACTION_PROMPT}\n\n=== 最近对话 ===\n${formatted}\n\n提取记忆碎片（JSON 数组）：`;

  try {
    const raw = await analyze(prompt);
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    let fragments;
    try {
      fragments = JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\[[\s\S]*\]/);
      if (match) fragments = JSON.parse(match[0]);
      else return [];
    }
    if (!Array.isArray(fragments)) return [];
    return fragments.filter(
      (f) => f.type && f.content && ['fact', 'preference', 'emotion', 'event'].includes(f.type)
    );
  } catch (err) {
    console.error('[MemoryExtractor] Fragment extraction failed:', err.message);
    return [];
  }
}

// ── 滚动摘要生成 ──

const SUMMARY_PROMPT = `你是一个对话摘要引擎。阅读以下 ${SUBJECT} 和 ${CHARACTER} 的最近对话，写一段中文摘要。

摘要要求：
- 2-4 句话，覆盖这段时间的重要话题、情绪变化、关键事件
- 重点写 ${SUBJECT}：说了什么、状态如何、有什么新信息
- 简要带过 ${CHARACTER} 的回应方式（语气基调），不要逐句复述
- 用第三人称

只返回摘要文本，不要 markdown，不要标题。`;

async function generateSummary(messages) {
  if (messages.length === 0) return null;

  const formatted = messages
    .map((m) => `${m.sender === 'user' ? SUBJECT : CHARACTER}: ${m.content}`)
    .join('\n');

  const prompt = `${SUMMARY_PROMPT}\n\n=== 对话 ===\n${formatted}\n\n摘要：`;

  try {
    const raw = await analyze(prompt);
    return raw.replace(/```\s*/g, '').trim();
  } catch (err) {
    console.error('[MemoryExtractor] Summary generation failed:', err.message);
    return null;
  }
}

// ── 主入口（fire-and-forget 调用） ──

let extractionRunning = false;

export async function runMemoryExtraction() {
  if (extractionRunning) return;
  extractionRunning = true;

  try {
    const cursor = getExtractionCursor();
    const maxId = getMaxMessageIdValue();

    // 没有新消息，跳过
    if (maxId <= cursor.last_processed_message_id) return;

    const messages = getUnprocessedMessages(cursor.last_processed_message_id);

    // ── 提取记忆碎片 ──
    const fragments = await extractFragments(messages);
    let savedCount = 0;
    for (const f of fragments) {
      const sourceMsg = messages.find((m) => m.sender === 'user' && m.content.includes(f.content.slice(0, 20)));
      insertFragment(f.type, f.content, sourceMsg?.id || null, f.confidence || 0.6);
      savedCount++;
    }
    if (savedCount > 0) {
      console.log(`[MemoryExtractor] Saved ${savedCount} fragments`);
    }

    // ── 检查是否需要生成摘要 ──
    const newMsgCount = getNewMessageCountSince(cursor.last_summary_message_id);
    let newSummaryId = cursor.last_summary_message_id;

    if (newMsgCount >= config.memory.summaryInterval) {
      const summaryMessages = getUnprocessedMessages(cursor.last_summary_message_id);
      const summary = await generateSummary(summaryMessages);

      if (summary) {
        const startId = summaryMessages[0].id;
        const endId = summaryMessages[summaryMessages.length - 1].id;
        insertSummary(startId, endId, summary);
        newSummaryId = maxId;
        console.log(`[MemoryExtractor] Generated summary (msgs ${startId}-${endId})`);
      }
    }

    // 更新游标
    updateExtractionCursor(maxId, newSummaryId);
  } catch (err) {
    console.error('[MemoryExtractor] Extraction run failed:', err.message);
  } finally {
    extractionRunning = false;
  }
}
