// ============================================================
// 消息处理管线 — 10 步精确编排
//
// 顺序（不可调换）：
//   1. 存消息
//   2. 取最近 4 条
//   3. LLM 对话分析 → delta
//   4. applyDelta
//   5. resetConnection
//   6. getStyleGuidance
//   7. 构建 system prompt
//   8. LLM 生成回复
//   9. 微信发送
//  10. 存回复
// ============================================================
import { insertMessage, getLastNMessages, getOutreachCount24h } from './db.js';
import { getJiwen } from './state.js';
import { getFullGuidance } from './profiles.js';
import { chat } from './llm.js';
import { analyzeChatSegment } from './analysis.js';
import { sendReply, sendTyping } from './wc-bot.js';
import { splitReply, typingDelay } from './splitter.js';
import { retrieveMemories, formatMemoriesForPrompt } from './retriever.js';
import { runMemoryExtraction } from './memory-extractor.js';
import { config } from './config.js';

// 角色基础提示词（不包含语调注入——语调由 CORE_PROFILES 动态叠加）
const CHARACTER = config.persona.characterName;
const SUBJECT = config.persona.subjectName;

const BASE_SYSTEM_PROMPT = `你叫${CHARACTER}。${SUBJECT} 在微信上和你聊天。

关于你：
- 你不是 AI，不是助手，不是客服。你就是${CHARACTER}——一个普通人。
- 你话少，但不是冷漠。有些事你懒得多说，有些事你会多讲两句。
- 你不负责让对话"完整"。说不完就说不完，懒得解释就跳过。
- 你对${SUBJECT}有感情，但这感情藏在语气里，不会直接说出来。

阅读对方消息的方式：
- 对方如果一次发了好几条（消息之间用换行分隔），那是在连续说话——不要逐条回复，把这几条当一整段来理解，挑你觉得有意思的点回应。

说话习惯：
- 默认回一句。一句能解决的事不要说两句。
- 不要说"我理解""我能感受到""你是说……"这类话。你不是心理咨询师。
- 不要重复对方刚说过的话。对方说"好无聊"，你不用回"是啊确实很无聊然后……"——你直接说你想说的。
- 不要总结。不要给对话收尾。不要替对方把话补完。
- 不要用修辞过度的比喻——"像齿轮里撒沙子""精神消毒室"这种你写出来自己都觉得假。
- 偶尔可以怼回去，可以不接茬，可以发一个"……"就完了。
- 不主动追问。你不是记者。

格式：
- 纯文字，像微信聊天框里打出来的。没有 markdown。
- 不用句号结尾。问号和感叹号可以用，省略号只在真的语塞时用。
- 情绪靠用词和语气传达，不是靠括号。`;

/**
 * 构建 system prompt，叠加当前情绪色调。
 * CORE_PROFILES 提供的是"你此刻的语气底色"，不是行为指令。
 * 只给一句话的色调提示，不给几段话的角色扮演指导。
 */
function buildSystemPrompt() {
  const jiwen = getJiwen();
  const style = jiwen.getStyleGuidance(); // 一句话的语气提示
  return `${BASE_SYSTEM_PROMPT}

此刻的语气：${style}`;
}

/**
 * 处理一条用户消息（可能是合并后的多条）。
 * @param {object} parsedMsg — weixin-bot-sdk 的 parsed message 对象，text 可能包含多条消息（合并后的）
 */
export async function processMessage(parsedMsg) {
  const jiwen = getJiwen();
  const timestamp = new Date().toISOString();

  // Step 1: 存用户消息
  insertMessage('user', parsedMsg.text, timestamp, parsedMsg.contextToken);

  // ── Debug hook: /status 返回完整诊断信息 ──
  // 只匹配纯 /status，合并后的多行文本不会触发
  if (parsedMsg.text.trim() === '/status') {
    const s = await jiwen.getState();
    const sent24h = getOutreachCount24h();
    const hour = new Date().getHours();
    const activeWindow = hour >= config.jiwen.activeHoursStart && hour < config.jiwen.activeHoursEnd;
    const style = await jiwen.getStyleGuidance();

    const statusReport = [
      `【系统状态】`,
      `模型: DeepSeek (${config.deepseek.chatModel})`,
      `分析模型: ${config.deepseek.analysisModel}`,
      ``,
      `五轴状态:`,
      `  connection  ${s.connection.toFixed(3)}  (${s.connection < 0.35 ? '刚聊完' : s.connection < 0.50 ? '有点想了' : '很想念'})`,
      `  pride       ${s.pride >= 0 ? '+' : ''}${s.pride.toFixed(3)}  (${s.pride > 0.5 ? '端着' : s.pride > 0.1 ? '中间' : '放软'})`,
      `  valence     ${s.valence >= 0 ? '+' : ''}${s.valence.toFixed(3)}  (${s.valence > 0.3 ? '开心' : s.valence < -0.3 ? '低落' : '中性'})`,
      `  arousal     ${s.arousal >= 0 ? '+' : ''}${s.arousal.toFixed(3)}  (${s.arousal > 0.3 ? '兴奋/焦躁' : s.arousal < -0.3 ? '平静懒散' : '中性'})`,
      `  immersion   ${s.immersion.toFixed(3)}  (${s.immersion > 0.3 ? '专注中' : '空闲'})`,
      ``,
      `当前语调: ${style.split('\n')[0]}`,
      `24h已主动开口: ${sent24h}/${config.outreach.limit24h}`,
      `活跃窗口: ${activeWindow ? '是' : '否'} (${config.jiwen.activeHoursStart}:00-${config.jiwen.activeHoursEnd}:00)`,
      `上一次 tick: ${s.lastTick || '无'}`,
    ].join('\n');

    insertMessage('bot', statusReport, new Date().toISOString());
    await sendReply(parsedMsg, statusReport);
    return;
  }

  // Step 2: 取最近对话（分析用）
  const recentMessages = getLastNMessages(4);

  // Step 3: LLM 对话分析 → delta
  const delta = await analyzeChatSegment(recentMessages);
  console.log('[Pipeline] Delta:', delta);

  // Step 4: 注入 jiwen
  await jiwen.applyDelta(delta);

  // Step 5: 连接需求归零（她回了）
  await jiwen.resetConnection();

  // Step 6: 获取当前语调指引（已在 buildSystemPrompt 内部使用，这里仅日志）
  const style = jiwen.getStyleGuidance();
  console.log('[Pipeline] Style guidance:', style.slice(0, 80));

  // Step 7: 构建 system prompt
  let systemPrompt = buildSystemPrompt();

  // Step 7.5: 检索相关记忆
  try {
    const memories = await retrieveMemories(parsedMsg.text);
    if (memories.length > 0) {
      systemPrompt += formatMemoriesForPrompt(memories);
      console.log(`[Memory] Retrieved ${memories.length} memories`);
    }
  } catch (err) {
    console.error('[Memory] Retrieval failed:', err.message);
  }

  // 构建消息历史（最近 8 条用作 LLM 上下文）
  const history = getLastNMessages(8);
  const llmMessages = [
    { role: 'system', content: systemPrompt },
    ...history.map((m) => ({
      role: m.sender === 'user' ? 'user' : 'assistant',
      content: m.content,
    })),
  ];

  // Step 8: 发送 typing 指示器 + LLM 生成回复
  await sendTyping(parsedMsg.from);

  let replyText;
  try {
    replyText = await chat(llmMessages);
  } catch (err) {
    console.error('[Pipeline] LLM chat failed:', err.message);
    replyText = '抱歉，刚才走神了……你再说一遍？';
  }

  // Step 9: 断句 + 模拟真人分次发送
  const segments = splitReply(replyText);
  if (segments.length === 0) {
    segments.push(replyText); // fallback: 整段发送
  }

  const replyTimestamp = new Date().toISOString();
  for (let i = 0; i < segments.length; i++) {
    await sendReply(parsedMsg, segments[i]);

    // Step 9.5: 打字延迟 = 思考停顿 + 下一条字数 × 每字打字时间（模拟输入法）
    if (i < segments.length - 1) {
      const nextLen = segments[i + 1].length;
      await new Promise((resolve) => setTimeout(resolve, typingDelay(nextLen)));
    }
  }

  // Step 10: 存 Bot 回复
  insertMessage('bot', replyText, replyTimestamp);

  // Step 10.5: 后台记忆提取（fire-and-forget，不阻塞聊天流）
  setImmediate(() => {
    runMemoryExtraction().catch((err) =>
      console.error('[Memory] Extraction failed:', err.message)
    );
  });

  // 打印完整状态变化轨迹（每轮对话后）
  const endState = await jiwen.getState();
  console.log(
    `[Pipeline] 五轴: ` +
    `connection=${endState.connection.toFixed(3)} ` +
    `pride=${endState.pride.toFixed(3)} ` +
    `valence=${endState.valence.toFixed(3)} ` +
    `arousal=${endState.arousal.toFixed(3)} ` +
    `immersion=${endState.immersion.toFixed(3)}`
  );
}
