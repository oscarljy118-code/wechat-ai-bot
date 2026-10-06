// ============================================================
// 消息断句器 — 模拟真人打字/发消息节奏
// ============================================================

const ACTION_BRACKETS = /[（(][^）)]*[）)]/g;

function stripActions(text) {
  return text.replace(ACTION_BRACKETS, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^\s*…+\s*/, '')  // 清除段首的孤立省略号（括号动作删除后的残留）
    .trim();
}

function isBareEllipsis(text) {
  return /^[…\.]+$/.test(text.trim());
}

/**
 * 将 LLM 回复拆成多条短消息。
 *
 * 规则（按优先级）：
 *   1. 句号/感叹/问号/省略号处必断（含标点在前一段）
 *   2. 逗号/分号/破折号处等字符超过阈值再断
 *   3. 无标点的长句在 ~35 字处找安全断点
 *   4. 最终不超过 ~45 字
 */
export function splitReply(text) {
  if (!text || text.trim().length === 0) return [];

  const cleaned = stripActions(text);
  if (!cleaned) return [];

  const segments = [];
  const chars = [...cleaned]; // 按 Unicode 字符拆分，避免代理对问题
  const total = chars.length;

  let i = 0;
  while (i < total) {
    // 跳过段首空白
    while (i < total && /[\s\n\r]/.test(chars[i])) i++;
    if (i >= total) break;

    const segStart = i;
    let cut = -1;

    // 搜索窗口：从当前位置到 +45 字
    const searchEnd = Math.min(i + 45, total);

    for (let j = i; j < searchEnd; j++) {
      const ch = chars[j];

      // 强制断句符 → 立刻切（含标点）
      if (/[。！？!?…]/.test(ch)) {
        cut = j + 1;
        break;
      }

      // 逗号/分号/破折号 → 过了 10 字再切
      if (j - segStart >= 10 && /[，,；;、\-—]/.test(ch)) {
        cut = j + 1;
        // 不 break，继续往后找有没有更强的断点
      }
    }

    // 35 字以上还没找到断点 → 在任意标点处切
    if (cut < 0 || cut === segStart) {
      for (let j = i + 10; j < searchEnd; j++) {
        if (/[。，！？…,;!?、\n]/.test(chars[j])) {
          cut = j + 1;
          break;
        }
      }
    }

    // 40 字硬切
    if (cut < 0 || cut === segStart) {
      if (searchEnd - segStart >= 40) {
        cut = segStart + 40;
      }
    }

    // 剩余全部
    if (cut < 0 || cut === segStart) {
      cut = total;
    }

    const seg = chars.slice(i, cut).join('').trim();
    if (seg && !isBareEllipsis(seg)) {
      // 微信聊天习惯：非问句结尾的句号省略，更像真人
      // "知道了。" → "知道了"  "听过一点。" → "听过一点"
      // 保留问号、感叹号、省略号（带感情）
      const stripped = seg.replace(/[。，]$/, '');
      if (stripped) segments.push(stripped);
    }
    i = cut;
  }

  return segments;
}

/**
 * 打字延迟 — 模拟打完上一条后开始打下一条的间隔
 *
 * 中文手机输入约 3-5 字/秒。取 200ms/字，上限 3.5s。
 *
 * @param {number} charCount — 下一条消息的字数
 */
export function typingDelay(charCount = 0) {
  const think = 200 + Math.floor(Math.random() * 300);    // 想一下: 0.2-0.5s
  const typing = Math.min(charCount * 200, 3000);          // 打字: 200ms/字, 封顶 3s
  return think + typing;
}
