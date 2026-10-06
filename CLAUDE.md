# WeChat AI Companion (wx-companion) — 工作规范

## 项目定位

微信 AI 伴侣 — jiwen 状态引擎驱动的有情绪惯性的聊天角色。纯微信通道，DeepSeek 做模型。

## 架构

```
微信 → weixin-bot-sdk → pipeline.js → jiwen + DeepSeek
                             ↓
                       SQLite (消息全量)
```

## 核心模块

| 文件 | 职责 |
|------|------|
| `src/index.js` | 入口：启动 bot + cron + 优雅关闭 |
| `src/config.js` | .env 加载 + 必填验证 |
| `src/db.js` | SQLite 封装：建表、消息增查、jiwen 状态存取 |
| `src/wc-bot.js` | weixin-bot-sdk 封装：登录/消息/回复/typing |
| `src/pipeline.js` | 消息处理管线（10 步顺序） |
| `src/state.js` | jiwen 实例：参数配置 + 持久化 |
| `src/profiles.js` | CORE_PROFILES 语调网格 |
| `src/llm.js` | DeepSeek API（chat + analyze） |
| `src/analysis.js` | 对话分析 prompt + delta 解析 |
| `src/jiwen.js` | 积温引擎（vendored from github.com/ClaraShafiq/jiwen） |

## 消息处理顺序（不可调换）

```
1. 存消息 → 2. 取最近 4 条 → 3. LLM 分析 → delta
4. applyDelta → 5. resetConnection → 6. getStyleGuidance
7. 构建 system prompt → 8. LLM 回复 → 9. 微信发送 → 10. 存回复
```

先分析再 reset：分析需要 pre-reset 的状态作为参照。

## 关键约定

- **所有消息全量留存** SQLite，不做物理删除
- **jiwen API**：tick 自动漂移，applyDelta 注入变化，resetConnection 只在对方回复后调
- **对话分析用轻量配置**：低 temp (0.1)，只读最近 4 条，输出纯 JSON
- **CORE_PROFILES 是行为指令**，不是角色设定 — 每格 1-2 句
- **错误不 crash**：分析失败 → 零 delta，回复失败 → 兜底文字

## 五轴范围

| 轴 | 范围 | 含义 |
|---|---|---|
| connection | [0, 1] | 连接需求 |
| pride | [-1, 1] | 骄傲/防御 |
| valence | [-1, 1] | 愉悦度 |
| arousal | [-1, 1] | 唤醒度 |
| immersion | [0, 1] | 沉浸度 |
