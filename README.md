# 微信 AI 伴侣 · WeChat AI Companion

> 一个有「情绪惯性」、能主动开口、带 RAG 记忆检索的微信 AI 角色。
> 纯 Node.js 全栈实现，零框架，DeepSeek 驱动，SQLite 持久化。

这是一个把「大模型 + Agent 状态机 + RAG 记忆 + 工程化落地」揉进一个真实可运行产品的项目。它不只是一个"聊天机器人"，而是一套完整的 AI 应用技术链路：**后端服务 → 大模型集成 → Agent 状态编排 → 检索增强生成 → 上线调优**。

---

## ✨ 核心特性

| 能力 | 说明 |
|------|------|
| 🎭 情绪惯性 | 角色情绪由 **jiwen 五轴状态引擎** 连续计算，不是每句话随机生成 |
| 🗣️ 主动开口 | 后台 cron 检测"连接需求"阈值，到点主动找话题发消息 |
| 🧠 RAG 记忆 | FTS5 关键词召回 + LLM 重排序，聊过的事能跨对话记住 |
| 🧬 三层记忆 | 记忆碎片 + 滚动摘要 + 全量留存，异步后台提取不阻塞回复 |
| ⌨️ 拟真节奏 | 断句分条发送 + 按字数计算打字延迟，模拟真人聊天节奏 |
| 🛡️ 容错降级 | LLM 失败、分析失败、检索失败均不 crash，逐级兜底 |

---

## 🧠 技术架构

```
                        ┌─────────────────────────────┐
   微信消息 ──────────▶ │      pipeline.js（10步管线）    │
   weixin-bot-sdk       │  存消息 → LLM情绪分析 → 注入状态 │
                        │  → RAG记忆检索 → 生成 → 分条发送 │
                        └───────┬─────────────┬─────────┘
                                │             │
                 ┌──────────────▼───┐   ┌─────▼──────────────┐
                 │   jiwen 状态引擎   │   │  DeepSeek (LLM)     │
                 │  五轴连续情绪状态    │   │  chat / analyze     │
                 │  数学漂移+阈值触发   │   └─────┬──────────────┘
                 └──────────────┬───┘         │
                                │             │
                 ┌──────────────▼─────────────▼──────────────┐
                 │  SQLite + FTS5（消息全量 + 记忆碎片 + 摘要）  │
                 └────────────────────────────────────────────┘
```

### 五轴情绪状态（Agent 的"意识"）

角色情绪不是随机数，而是一个**连续状态向量**，每 5 分钟按速率数学漂移，收到消息时由 LLM 分析产生增量注入：

| 轴 | 范围 | 语义 |
|---|---|---|
| `connection` | [0,1] | 连接需求 —— 越久没聊越想对方，到阈值触发主动开口 |
| `pride` | [-1,1] | 骄傲/防御 —— 被夸↑，被撒娇↓ |
| `valence` | [-1,1] | 愉悦度 —— 开心/难过 |
| `arousal` | [-1,1] | 唤醒度 —— 兴奋焦躁/平静慵懒 |
| `immersion` | [0,1] | 沉浸度 —— 专注时连接需求涨得慢 |

情绪之间存在耦合关系（低落时想要安慰、被冷落时骄傲防御、想念太重时盔甲侵蚀），让角色行为有"心理逻辑"而非随机反应。

### 记忆系统（无向量数据库的 RAG）

DeepSeek **没有 embedding API**（已实测 404），因此没有硬上 ChromaDB，而是设计了 **FTS5 关键词召回 + LLM 重排序** 的检索方案：

```
用户消息
  ├─ FTS5 搜索记忆碎片（trigram 分词，支持中文）
  ├─ FTS5 搜索历史消息
  ├─ Jaccard 相似度去重
  ├─ LLM 重排序（挑最相关 3-5 条）
  └─ 注入 system prompt
```

记忆分四类：**事实 / 偏好 / 情绪 / 事件**。每 50 条消息生成一段滚动摘要作为兜底。

---

## 🛠️ 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Node.js (ESM) |
| LLM | DeepSeek（`deepseek-v4-flash`，OpenAI 兼容协议） |
| 存储 | better-sqlite3（同步 SQLite + FTS5 全文检索） |
| 通道 | weixin-bot-sdk（个人微信扫码登录） |
| 依赖总数 | **4 个**，零框架零中间件 |

---

## 🚀 快速开始

### 前置条件
- Node.js ≥ 18
- 一个 DeepSeek API Key

### 步骤

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY，可自定义 CHARACTER_NAME / SUBJECT_NAME

# 3. 启动
npm start
```

首次启动会打印二维码，用手机微信扫码登录后即可开始对话。

### 配置项（.env）

```ini
DEEPSEEK_API_KEY=          # 必填
CHARACTER_NAME=凌           # AI 角色名
SUBJECT_NAME=Karls          # 对方昵称
MEMORY_SUMMARY_INTERVAL=50  # 每 N 条消息生成一次摘要
MEMORY_RETRIEVAL_TOPK=5     # 每次检索返回的记忆数
```

---

## 📁 项目结构

```
src/
├── index.js             # 入口：启动 + 消息批处理 + cron + 优雅关闭
├── pipeline.js          # 核心：10 步消息处理管线
├── jiwen.cjs            # 积温状态引擎（vendored，713行）
├── state.js             # jiwen 实例化 + 角色参数 + 持久化
├── profiles.js          # CORE_PROFILES 语调网格（4情绪×5骄傲档）
├── llm.js               # DeepSeek 封装（chat + analyze）
├── analysis.js          # 对话分析 → 情绪 delta JSON
├── db.js                # SQLite 封装 + FTS5 + 记忆表
├── retriever.js         # 记忆检索：FTS5 召回 + LLM 重排序
├── memory-extractor.js  # 记忆提取：碎片 + 滚动摘要（异步）
├── splitter.js          # 回复断句 + 打字延迟 + 括号动作剥离
├── wc-bot.js            # 微信 SDK 封装
└── config.js            # .env 加载 + 参数配置
```

---

## 🔬 技术亮点（面试重点）

### 1. 推理模型 token 分配问题
`deepseek-v4-flash` 是**推理模型**，`reasoning_content`（内部思维链）和 `content`（最终输出）共享 `max_tokens`。早期配置 `max_tokens: 200` 时，思维链吃光全部预算，导致 `content` 为空、分析失败。

**解法**：提高 token 预算 + 增加 `reasoning_content` 兜底，并让分析/生成/记忆三个任务各自使用独立的温度与预算配置。

### 2. 中文 FTS5 分词陷阱
SQLite FTS5 的 `unicode61` 分词器对中文按单字切分，`MATCH '咖啡'` 直接返回空。实测 `trigram` 分词器可用但要求查询 ≥3 字。

**解法**：主用 `trigram`，短关键词（<3 字）回退到 `LIKE '%xx%'`，混合召回。

### 3. 结构化输出的鲁棒提取
LLM 输出 JSON delta 时经常夹带 markdown 代码块或前后文字。解析层做了三级兜底：直接 `JSON.parse` → 正则提取 `{...}` → 零 delta 降级，保证分析失败不阻断聊天。

### 4. 同步 / 异步路径分离
- **同步路径（~3s）**：消息 → 分析 → 状态更新 → FTS5 检索 → 生成回复 → 发送
- **异步路径（后台）**：`setImmediate` fire-and-forget 触发记忆提取，不阻塞用户看到的回复

### 5. 拟真延迟模拟
回复按标点断句分条发送，延迟 = 思考停顿(0.2-0.5s) + 字数×200ms（封顶 3s），模拟真人打字节奏。

### 6. Prompt 工程即系统设计
四个 LLM 角色各司其职：**对话情绪分析**（低温度输出 JSON）、**聊天生成**（高温度 + 人设）、**记忆碎片提取**（结构化分类）、**记忆重排序**（返回索引数组）。每个角色的 prompt 都是针对其任务单独调优的。

---

## 📊 消息处理管线

```
1. 存消息
2. 取最近 4 条
3. LLM 分析情绪 → delta
4. 注入 jiwen（applyDelta）
5. 连接需求归零（对方回复了）
6. 取当前语气（getStyleGuidance）
7. 构建 system prompt（人设 + 情绪色调）
7.5 检索相关记忆（RAG）
8. LLM 生成回复
9. 断句 + 打字延迟分条发送
10. 存回复 + 后台异步提取记忆
```

---

## 🙏 致谢

- **jiwen 积温引擎**：[github.com/ClaraShafiq/jiwen](https://github.com/ClaraShafiq/jiwen)（vendored，作为情绪状态机的核心，已按本项目角色定制）
- 灵感来源：Sanctuary/Draco 的 AI 伴侣架构思路

---

## 📄 License

[MIT](./LICENSE)
