import OpenAI from 'openai';
import { config } from './config.js';

const client = new OpenAI({
  apiKey: config.deepseek.apiKey,
  baseURL: config.deepseek.baseURL,
});

/**
 * Generate a chat reply.
 * @param {Array<{role: string, content: string}>} messages  - system prompt + conversation history
 * @param {object} [options]
 * @returns {Promise<string>} reply text
 */
export async function chat(messages, options = {}) {
  const response = await client.chat.completions.create({
    model: config.deepseek.chatModel,
    messages,
    temperature: options.temperature ?? 0.85,
    max_tokens: options.maxTokens ?? 1000,
    top_p: options.topP ?? 0.92,
  });
  let content = response.choices[0].message.content || '';

  // deepseek-v4-flash 是推理模型，reasoning 可能吃掉所有 token
  if (!content || content.trim().length === 0) {
    const rc = response.choices[0].message.reasoning_content || '';
    if (rc) {
      console.error('[LLM] chat warning: empty content, using reasoning_content fallback');
      content = rc;
    }
  }

  return content;
}

/**
 * Analyze conversation and return raw LLM output (expected JSON delta).
 * Uses low temperature for consistent structured output.
 * @param {string} userPrompt — assembled analysis prompt with conversation embedded
 * @returns {Promise<string>} raw LLM response text
 */
export async function analyze(userPrompt) {
  const response = await client.chat.completions.create({
    model: config.deepseek.analysisModel,
    messages: [{ role: 'user', content: userPrompt }],
    temperature: 0.1,
    max_tokens: 1500,
    top_p: 0.85,
  });
  let content = response.choices[0].message.content || '';

  // deepseek-v4-flash 是推理模型，reasoning 可能吃掉所有 token
  // 兜底：从 reasoning_content 中尝试提取 JSON
  if (!content || content.trim().length === 0) {
    const rc = response.choices[0].message.reasoning_content || '';
    console.error('[LLM] analyze warning: empty content, trying reasoning_content fallback');
    content = rc;
  }

  console.error('[LLM] analyze raw:', JSON.stringify(content.slice(0, 300)));
  return content;
}
