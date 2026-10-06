// ============================================================
// 微信 Bot 层 — weixin-bot-sdk 封装
// ============================================================
import { WeixinBot } from 'weixin-bot-sdk';
import { config } from './config.js';

const bot = new WeixinBot({
  credentialsPath: config.wechat.credentialsPath,
});

/**
 * 初始化并启动微信 Bot。
 * @param {Function} onMessage — async (parsedMsg) => void
 * @param {Function} onReady — () => void
 * @param {Function} onError — (err) => void
 */
export async function initWechat(onMessage, onReady, onError) {
  bot.on('message', (msg) => {
    // msg 结构:
    // { messageId, from, to, timestamp, contextToken, text, type, raw }
    onMessage(msg);
  });

  bot.on('login', () => {
    console.log('[WeChat] Logged in');
    onReady();
  });

  bot.on('session:expired', async (errcode) => {
    console.error(`[WeChat] Session expired (errcode=${errcode}). Auto re-login...`);
    try {
      // 清除旧 token，重新扫码
      bot.api.token = null;
      await bot.login({
        onQrCode: (url) => {
          console.log('┌─────────────────────────────────────────────┐');
          console.log('│  Session 过期，请重新扫码登录                   │');
          console.log(`│  ${url}`);
          console.log('└─────────────────────────────────────────────┘');
        },
      });
      bot.start();
      console.log('[WeChat] Re-login successful.');
    } catch (err) {
      console.error('[WeChat] Re-login failed:', err.message);
      onError(new Error(`Session expired + relogin failed: ${errcode}`));
    }
  });

  bot.on('error', (err) => {
    console.error('[WeChat] Error:', err.message);
    onError(err);
  });

  await bot.login({
    onQrCode: (url) => {
      console.log('┌─────────────────────────────────────────────┐');
      console.log('│  请用手机微信扫描以下二维码登录 Bot            │');
      console.log(`│  ${url}`);
      console.log('└─────────────────────────────────────────────┘');
    },
  });

  bot.start();
  console.log('[WeChat] Bot started, polling for messages...');
}

/**
 * 发送回复。SDK 自动携带 context_token。
 */
export async function sendReply(originalMsg, text) {
  await bot.reply(originalMsg, text);
}

/**
 * 发送"正在输入"状态。
 */
export async function sendTyping(userId) {
  try {
    await bot.sendTyping(userId);
  } catch {
    // typing 失败不阻塞
  }
}

/**
 * 获取 Bot 的用户 ID（对方）。
 */
export function getBotUserId() {
  return bot._credentials?.userId || null;
}

/**
 * 主动发消息（无 context_token 的情况）。
 * 仅在 outreach 场景使用。
 */
export async function sendProactive(toUserId, contextToken, text) {
  await bot.sendText(toUserId, text, contextToken);
}
