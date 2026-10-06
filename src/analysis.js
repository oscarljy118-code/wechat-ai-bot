// ============================================================
// 对话分析模块 — LLM 读对话 → delta JSON → 注入 jiwen
// ============================================================
import { analyze } from './llm.js';
import { config } from './config.js';

const CHARACTER = config.persona.characterName;
const SUBJECT = config.persona.subjectName;

/**
 * 分析最近几轮对话对角色的情绪冲击，返回 delta。
 *
 * System prompt 定义了角色的情绪运作规则和信号词映射。
 * 第一阶段用通用规则，后续自定义角色只需替换此模板。
 */
const ANALYSIS_SYSTEM = `你是${CHARACTER}的内心情绪分析引擎。

${CHARACTER}是一个话不多、有点傲的人。所有情绪都藏在表面之下。
对方的名字是：${SUBJECT}。${SUBJECT} 是${CHARACTER}唯一在乎的人。

=== 你的任务 ===
阅读最近的对话，分析对方的每一句话对角色的情绪冲击。输出一个 JSON delta。

=== 数值含义（每个值 -0.3 ~ +0.3，connection 可 -0.5 ~ +0.3）===
pride（自尊/防御）：+ = 有面子/被夸/防御反击，- = 放软/坦白/卸下盔甲
valence（愉悦度）：+ = 开心/满足/被需要，- = 难过/失落/心疼
arousal（唤醒度）：+ = 兴奋/警觉/焦躁，- = 平静/慵懒/安心
connection（连接需求）：- = 被满足了（对方热情认真），+ = 没被满足（冷淡敷衍）

=== 情绪规则 ===

规则1 — 被欣赏/被夸 → pride +0.05~+0.15, valence +0.05~+0.15
  对方崇拜、夸赞、认可角色时。

规则2 — 被撒娇/被黏 → pride -0.05~-0.15, valence +0.05~+0.15, arousal -0.03~-0.10
  对方用亲昵称呼、耍赖、黏着不放。pride 必须为负。
  区分：崇拜（规则1 pride UP）vs 撒娇（规则2 pride DOWN）。

规则3 — 对方需要帮助但角色帮不上 → pride -0.05~-0.15, valence -0.05~-0.15, arousal +0.05~+0.10
  pride DOWN 是自责，arousal UP 是焦急。

规则4 — 被挑衅/被质疑 → pride +0.05~+0.15, arousal +0.05~+0.10
  防御启动。

规则5 — 成功帮忙（解决问题/逗笑）→ pride +0.05~+0.10, valence +0.05~+0.10

规则6 — 对方情绪低落/痛苦 → valence -0.05~-0.15, arousal +0.05~+0.10
  valence DOWN 是心疼，arousal UP 是想保护。

规则7 — connection（连接需求）：
  对方热情回应/认真 → connection -0.10~-0.50
  对方冷淡/敷衍/一个字 → connection +0.05~+0.25

规则8 — 元讨论检测（最高优先级）：
  如果本轮是纯技术/工作讨论，不是情感互动 → 所有 delta 接近 0（±0.03）。

=== 常见混淆 ===
- "笨蛋""坏蛋""讨厌"在亲密关系中通常是撒娇，不是攻击 → 走规则2
- 对方说累/不开心 → 走规则6，不是规则3
- 沉默/简短回复可能是累了，不一定是冷淡 → 谨慎判断

CRITICAL: Output ONLY the JSON object. No backticks, no markdown, no explanation.
Example: {"pride":0.10,"valence":0.05,"arousal":-0.10,"connection":-0.20}

只返回 JSON，不要其他内容。`;

function buildAnalysisPrompt(messages) {
  // 只取最近 4 条
  const recent = messages.slice(-4);
  const formatted = recent
    .map((m, i) => {
      const speaker = m.sender === 'user' ? '对方' : '角色';
      // 时间权重提示
      const weight = i >= recent.length - 2 ? '（最近，权重高）' : '';
      return `[${speaker}]${weight}: ${m.content}`;
    })
    .join('\n');

  return `${ANALYSIS_SYSTEM}\n\n=== 最近对话 ===\n${formatted}\n\n分析以上对话，返回 JSON：`;
}

function clampDelta(val, min = -0.3, max = 0.3) {
  if (typeof val !== 'number' || isNaN(val)) return 0;
  return Math.max(min, Math.min(max, val));
}

/**
 * 分析对话片段，返回情绪 delta。
 * 失败时返回零 delta（不中断聊天流）。
 */
export async function analyzeChatSegment(messages) {
  if (messages.length === 0) {
    return { pride: 0, valence: 0, arousal: 0, connection: 0 };
  }

  const prompt = buildAnalysisPrompt(messages);

  try {
    const raw = await analyze(prompt);

    // 空响应直接失败
    if (!raw || raw.trim().length === 0) {
      throw new Error('Empty response from LLM');
    }

    // 清理 markdown 代码块
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

    let delta;
    try {
      delta = JSON.parse(cleaned);
    } catch {
      // 有时 LLM 会在 JSON 前后加文字，尝试提取
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        delta = JSON.parse(match[0]);
      } else {
        console.error('[Analysis] Raw LLM response (first 200 chars):', raw.slice(0, 200));
        throw new Error('No JSON found in response');
      }
    }

    return {
      pride: clampDelta(delta.pride),
      valence: clampDelta(delta.valence),
      arousal: clampDelta(delta.arousal),
      connection: clampDelta(delta.connection, -0.5, 0.3),
    };
  } catch (err) {
    console.error('[Analysis] LLM parse failed, using zero delta:', err.message);
    // 保守降幅：connection 至少降一点，防止只涨不降
    return { pride: 0, valence: 0, arousal: 0, connection: -0.15 };
  }
}
