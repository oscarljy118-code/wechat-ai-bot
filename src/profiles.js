// ============================================================
// CORE_PROFILES 语调网格 — 极简版
// 每个格子只给一个语气词/短句，不是行为指令。
// 模型用它来调"色彩"，不是用它来指导"怎么演"。
// ============================================================

const CORE_PROFILES = {
  excited: {
    1: '兴奋得像小孩，想到什么说什么',
    2: '心情好，话比平时多一点',
    3: '带着点优越感的调侃',
    4: '愉悦但克制',
    5: '嘴硬，明明在开心',
  },
  content: {
    1: '像吃饱的猫，黏糊糊的',
    2: '松弛温和',
    3: '礼貌但疏离',
    4: '内心舒坦外表自持',
    5: '高高在上的默许',
  },
  agitated: {
    1: '焦虑，带刺',
    2: '坐不住，话冲',
    3: '冷冰冰的刻薄',
    4: '烦躁但傲慢',
    5: '死寂般的愤怒',
  },
  depressed: {
    1: '卑微，溺水感',
    2: '沉沉地疲惫，有气无力',
    3: '消极怠工，能少说就少说',
    4: '心碎了也要站直',
    5: '拒绝靠近，死气沉沉',
  },
  neutral: {
    1: '随性自然',
    2: '基本不端着',
    3: '典型社交面具，滴水不漏',
    4: '有点端着',
    5: '高冷简练',
  },
};

const URGENCY_BOOST = {
  desperate: {
    proactive: '很久没动静了，有点在意',
    reactive: '终于回了，但有种距离感',
  },
  urgent: {
    proactive: '挺久没动静了，想知道她在干嘛',
    reactive: '能感觉到没那么亲密了',
  },
  aware: {
    proactive: '有点想她，但还好',
    reactive: '稍微有点距离，不过问题不大',
  },
  none: { proactive: '', reactive: '' },
};

export function getUnifiedGuidance(state) {
  const { valence: v, arousal: a, pride: p } = state;

  let cluster;
  if (v > 0.3 && a > 0.3) cluster = 'excited';
  else if (v > 0.3 && a < -0.3) cluster = 'content';
  else if (v < -0.3 && a > 0.3) cluster = 'agitated';
  else if (v < -0.3 && a < -0.3) cluster = 'depressed';
  else cluster = 'neutral';

  let tier;
  if (p > 0.8) tier = 5;
  else if (p > 0.5) tier = 4;
  else if (p > 0.3) tier = 3;
  else if (p > 0.1) tier = 2;
  else tier = 1;

  const profile = CORE_PROFILES[cluster] || CORE_PROFILES.neutral;
  // 极简：只返回一个语气短句，不是几段话的行为指导
  return profile[tier] || profile[3];
}

export function getFullGuidance(state, mode = 'reactive') {
  const core = getUnifiedGuidance(state);
  const c = state.connection;

  let urgency;
  if (c >= 0.50) urgency = 'desperate';
  else if (c >= 0.35) urgency = 'urgent';
  else if (c >= 0.20) urgency = 'aware';
  else urgency = 'none';

  const urgencyLine = URGENCY_BOOST[urgency]?.[mode];
  // 极简拼接：语气底色 + 急迫感提示（都是短句）
  return [core, urgencyLine].filter(Boolean).join('。');
}
