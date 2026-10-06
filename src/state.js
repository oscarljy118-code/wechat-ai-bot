// ============================================================
// jiwen 状态引擎 — 实例化与配置
// 将通用 jiwen 引擎与 SQLite 持久化、消息源、语调网格连接
// ============================================================
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createJiwen } = require('./jiwen.cjs');
import { getLastUserMessage, loadJiwenState, saveJiwenState } from './db.js';
import { getFullGuidance } from './profiles.js';
import { config } from './config.js';

let jiwenInstance = null;

/**
 * 对方最后一条消息 → 连接需求增长速率。
 * jiwen 每一分钟 tick 都会调这个函数。
 * 数值含义：每分钟 connection 的增加量。
 */
function connectionRateFn(lastMsg) {
  if (!lastMsg) return 0.007;

  const text = lastMsg.content || '';

  // 睡了 — 不急
  if (/晚安|去睡了|睡了|睡觉|困了/.test(text)) return 0.001;
  // 出门了 — 比睡觉急一点
  if (/出门|上班|开会|在路上|到了/.test(text)) return 0.005;
  // 短消息 — 中断得突然，稍快
  if (text.length < 10) return 0.010;
  // 正常对话中断
  return 0.007;
}

export async function initJiwen() {
  const instance = createJiwen({
    // ── 消息源 ──
    getLastMessage: () => getLastUserMessage(),

    connectionRateFn,

    // ── 持久化 ──
    onSave: async (state) => {
      saveJiwenState(state);
    },
    onLoad: async () => {
      const saved = loadJiwenState();
      // 冷启动：返回一个温暖的初始状态，而不是全零
      if (!saved) {
        return {
          connection: 0.10,
          pride: 0.0,
          valence: 0.05,
          arousal: -0.05,
          immersion: 0,
        };
      }
      return saved;
    },

    // ── 角色参数 ──
    rates: {
      valenceSetpoint: -0.1,  // 角色天生偏冷
    },

    // ── 自定义语调指引（覆盖 jiwen 默认中文文案）──
    getStyleGuidance: (state) => getFullGuidance(state, 'reactive'),
    getPromptContext: (state) => getFullGuidance(state, 'proactive'),

    // ── 角色人称 ──
    persona: {
      subjectName: config.persona.subjectName,
      selfName: config.persona.characterName,
      subjectPronoun: '她',
    },
  });

  await instance.load();
  console.log('[jiwen] State loaded:', await instance.getState());

  jiwenInstance = instance;
  return instance;
}

export function getJiwen() {
  if (!jiwenInstance) throw new Error('jiwen not initialized. Call initJiwen() first.');
  return jiwenInstance;
}
