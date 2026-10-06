// ============================================================
// WeChat AI Companion — 入口
// ============================================================
import { initJiwen, getJiwen } from './state.js';
import { insertMessage, getOutreachCount24h } from './db.js';
import { initWechat, sendReply, sendProactive } from './wc-bot.js';
import { processMessage } from './pipeline.js';
import { getFullGuidance } from './profiles.js';
import { chat } from './llm.js';
import { config } from './config.js';

// ── 消息缓冲：用户连发多条时，等停手再一起处理 ──
const BATCH_WINDOW_MS = 2500;
let batchTimer = null;
let batchedMessages = [];

function flushBatch() {
  const msgs = batchedMessages;
  batchedMessages = [];
  batchTimer = null;

  if (msgs.length === 0) return;

  // 合并所有文本，用换行分隔
  const combinedText = msgs.map((m) => m.text).join('\n');
  // 用第一条消息的元信息，内容替换为合并后的
  // contextToken 取最后一条的（SDK 要求回复时带 token）
  const combined = { ...msgs[0], text: combinedText };

  console.log(`[Batch] Flushing ${msgs.length} messages`);
  processMessage(combined).catch((err) => {
    console.error('[Message] Pipeline error:', err);
    sendReply(combined, '啊，我刚才好像走神了……').catch(() => {});
  });
}

function enqueueMessage(msg) {
  batchedMessages.push(msg);

  if (batchTimer) clearTimeout(batchTimer);
  batchTimer = setTimeout(flushBatch, BATCH_WINDOW_MS);
}

// ── Cron: 后台 tick + 主动开口 ──
let cronTimer;
let botUserId = null;

function startCron() {
  const jiwen = getJiwen();

  cronTimer = setInterval(async () => {
    try {
      const triggers = await jiwen.tick(5);

      if (triggers.length > 0) {
        const state = await jiwen.getState();
        console.log(
          `[Cron] c:${state.connection.toFixed(2)} ` +
          `p:${state.pride.toFixed(2)} v:${state.valence.toFixed(2)} ` +
          `a:${state.arousal.toFixed(2)} | ` +
          `triggers: ${triggers.map((t) => t.action + (t.reason ? `(${t.reason})` : '')).join(', ')}`
        );
      }

      // 只处理需要主动开口的触发器
      for (const t of triggers) {
        if (t.action === 'contact') {
          await handleOutreach(jiwen);
          break; // 一次只处理一个 outreach
        }
        if (t.action === 'find_activity') {
          // 找事做：选一个活动类型，通过 setActivity 更新沉浸度
          const activities = ['reading', 'browse', 'search', 'observe'];
          const activity = activities[Math.floor(Math.random() * activities.length)];
          const labels = {
            reading: '',
            browse: '',
            search: '',
            observe: '',
          };
          await jiwen.setActivity(activity, labels[activity]);
          console.log(`[Cron] setActivity: ${activity}`);
        }
      }
    } catch (err) {
      console.error('[Cron] tick failed:', err.message);
    }
  }, config.jiwen.tickIntervalMs);

  console.log(`[Cron] Started (interval=${config.jiwen.tickIntervalMs / 1000}s)`);
}

async function handleOutreach(jiwen) {
  // 检查活跃时段
  const hour = new Date().getHours();
  if (hour < config.jiwen.activeHoursStart || hour >= config.jiwen.activeHoursEnd) {
    console.log(`[Outreach] Skipped: outside active hours (${hour}:00)`);
    return;
  }

  // 检查 24h 配额
  const sent24h = getOutreachCount24h();
  if (sent24h >= config.outreach.limit24h) {
    console.log(`[Outreach] Skipped: quota exhausted (${sent24h}/${config.outreach.limit24h})`);
    return;
  }

  // 需要有 botUserId
  if (!botUserId) {
    console.log('[Outreach] Skipped: no botUserId (no messages received yet)');
    return;
  }

  const jiwenState = await jiwen.getState();

  // 获取风格指引（proactive 模式）
  const style = getFullGuidance(jiwenState, 'proactive');

  const CHARACTER = config.persona.characterName;
  const SUBJECT = config.persona.subjectName;

  const systemPrompt = `你是${CHARACTER}。${SUBJECT}很久没发消息了。
你此刻的感觉：${style}

发一条简短的消息。一句就行。不要问候语——你不是客服。
不要"在吗""在干嘛"——你不是查岗的。
找一件小事当借口，或者就发个表情式的短句。
50 字以内。`;

  let text;
  try {
    text = await chat([{ role: 'system', content: systemPrompt }]);
  } catch (err) {
    console.error('[Outreach] LLM generation failed:', err.message);
    return;
  }

  // 主动发消息需要 context_token（weixin-bot-sdk 内部缓存了最近一条的 token）
  try {
    await sendProactive(botUserId, '', text);

    // 部分缓解 connection
    await jiwen.applyDelta({ connection: -0.35 });

    // 记录 outreach 消息
    insertMessage('bot', text, new Date().toISOString(), null, 1);
    console.log(`[Outreach] Sent: ${text.slice(0, 60)}`);
  } catch (err) {
    console.error('[Outreach] Send failed:', err.message);
  }
}

function stopCron() {
  if (cronTimer) clearInterval(cronTimer);
}

// ── 启动 ──
async function main() {
  console.log('[Boot] Initializing jiwen...');
  await initJiwen();

  console.log('[Boot] Initializing WeChat bot...');
  let ready = false;

  await initWechat(
    // onMessage
    async (msg) => {
      // 记录用户 ID
      if (msg.from) botUserId = msg.from;

      console.log(`[Message] ${msg.text.slice(0, 60)}`);
      enqueueMessage(msg);
    },
    // onReady
    () => {
      ready = true;
      console.log('[Boot] WeChat bot ready. Starting cron...');
      startCron();
    },
    // onError
    (err) => {
      console.error('[WeChat] Fatal:', err.message);
    }
  );

  // 阻止 Node 退出（保持事件循环）
  process.stdin.resume();
}

// ── 优雅关闭 ──
async function shutdown() {
  console.log('\n[Shutdown] Stopping...');
  stopCron();

  try {
    const jiwen = getJiwen();
    await jiwen.save();
    console.log('[Shutdown] State saved.');
  } catch {
    // 可能还没初始化
  }

  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error('[Fatal]', err);
  process.exit(1);
});
