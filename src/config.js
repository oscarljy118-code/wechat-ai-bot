import dotenv from 'dotenv';
import { existsSync } from 'node:fs';

dotenv.config();

// Warn if no .env file found at root
if (!existsSync('.env')) {
  console.warn('[Config] No .env file found. Copy .env.example to .env and fill in your keys.');
}

function required(key) {
  const val = process.env[key];
  if (!val) {
    throw new Error(`Missing required env var: ${key}. Check your .env file.`);
  }
  return val;
}

export const config = {
  deepseek: {
    apiKey: required('DEEPSEEK_API_KEY'),
    baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
    chatModel: process.env.DEEPSEEK_CHAT_MODEL || 'deepseek-chat',
    analysisModel: process.env.DEEPSEEK_ANALYSIS_MODEL || 'deepseek-chat',
  },

  wechat: {
    credentialsPath: process.env.WECHAT_CREDENTIALS_PATH || './data/wx-credentials.json',
  },

  jiwen: {
    tickIntervalMs: parseInt(process.env.JIWEN_TICK_INTERVAL_MS, 10) || 300000,
    activeHoursStart: parseInt(process.env.JIWEN_CRON_ACTIVE_HOURS_START, 10) || 8,
    activeHoursEnd: parseInt(process.env.JIWEN_CRON_ACTIVE_HOURS_END, 10) || 23,
  },

  sqlite: {
    path: process.env.SQLITE_PATH || './data/companion.db',
  },

  outreach: {
    limit24h: parseInt(process.env.OUTREACH_24H_LIMIT, 10) || 10,
  },

  persona: {
    characterName: process.env.CHARACTER_NAME || '凌',
    subjectName: process.env.SUBJECT_NAME || '对方',
  },

  memory: {
    summaryInterval: parseInt(process.env.MEMORY_SUMMARY_INTERVAL, 10) || 50,
    retrievalTopK: parseInt(process.env.MEMORY_RETRIEVAL_TOPK, 10) || 5,
    rerankCandidates: parseInt(process.env.MEMORY_RERANK_CANDIDATES, 10) || 20,
  },
};
