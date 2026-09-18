# 词境 LexiLoop · 雅思语境抗遗忘背词系统

> 极简语境，搞定雅思核心词。摆脱死记硬背，在真实生活画面里重建词汇记忆。

**LexiLoop（中文名「词境」）** 是一个面向雅思考生（目标 7.5+）的语境背词 Web 应用：快速过滤熟词 → 每凑齐一批生词 → AI 即时生成极简易读的情景短文 → 双语对照阅读 → 完形填空通关测试 → 间隔重复复习。

核心亮点：**难度阶梯**。文章与题目难度随等级递增，初级模式用简单词汇与短句、并减少每篇词量，避免「给药过猛」。

---

## ✨ 功能特性

- **极简语境记忆**：内置 100 个雅思高频核心词，先快速过滤熟词，只把生词送进情景短文。
- **难度阶梯（核心优化）**：
  - 🟢 初级 · 极简轻量：每 **5** 个生词生成一篇，简单短句、干扰项少。
  - 🟡 中级 · 标准语境：每 **8** 个生词生成一篇（默认）。
  - 🔴 高级 · 学术进阶：每 **10** 个生词生成一篇，长难句、干扰项多。
  - 难度偏好自动保存在浏览器（localStorage），可云端同步。
- **AI 情景短文**：通过 Supabase Edge Function 调用大模型（服务端持有 Key，前端零密钥暴露），在真实画面里锁定词义；高亮目标词，点击查看中英释义。
- **双语对照阅读**：长距离视觉屏障，避免无意识瞟中文；可一键解锁译文。
- **句子挖空通关测试**：为每个目标词生成一句语境例句并挖空，从选项中选出正确单词；答对的移除生词池，模糊的打回重练。
- **间隔重复（Spaced Repetition）**：基于简化 SM-2 算法计算下次复习时间，支持「温故知新」复习已掌握词。
- **游客模式（零门槛体验）**：登录页一键「游客免费体验」，无需注册即可完整体验「筛选生词 → AI 情景短文 → 双语阅读 → 完形填空 → 掌握报告」全流程。进度自动保存在本机浏览器（localStorage），刷新 / 次日重开仍保留，仅限当前设备。
- **云端同步 + 账号系统**：邮箱 / Google 登录，进度自动同步到云端，跨设备可用。游客随时可点「登录保存进度」升级为正式账号。
- **语音朗读**：内置 TTS 朗读单词、短文与题目。

---

## 📁 项目结构

```
.
├── index.html              # 主应用（背词主流程）
├── login.html              # 登录 / 注册页
└── js/
    ├── vocabulary-data.js  # 雅思核心词库（100 词，可扩展）
    ├── supabase-client.js  # 轻量 Supabase 客户端（auth + REST，零外部依赖）
    ├── auth.js             # 认证模块（注册 / 登录 / 登出 / 会话）
    ├── vocabulary.js       # 词库数据与云端进度同步、间隔重复算法
    ├── story.js            # 故事生成 + 完形填空挑战 + 复习/统计
    └── app.js              # 主控制器（UI 切换、事件、难度阶梯）
```

> 部署说明：本仓库为纯静态前端，后端依赖你自己的 **Supabase 项目**（数据库 + Edge Function）。前端不持有任何 API Key。

---

## ⚙️ 难度阶梯参数契约

前端在请求故事生成时，会向 Edge Function 发送如下负载：

```json
{
  "action": "generate_story",
  "words": ["Acknowledge", "Empower", "..."],
  "difficulty": "beginner | intermediate | advanced",
  "mode": "user | guest",
  "constraints": {
    "max_sentences": 3,
    "max_words_per_sentence": 12,
    "style": "simple",
    "tone": "daily",
    "no_dialogue": true
  }
}
```

| 难度 | 每篇目标词量 | 干扰项数量 | 文章特征 |
|------|-------------|-----------|---------|
| `beginner` | 5 | 2 | 简单词汇、短句、生活化 |
| `intermediate` | 8 | 3 | 标准雅思语境 |
| `advanced` | 10 | 4 | 学术长难句、高密度 |

Edge Function **必须读取 `difficulty` 字段** 来控制文章难度（前端已传递，服务端据此调炮制 prompt）。即使服务端暂不支持，`batchSize` 与干扰项数量仍由前端严格控制，保证「给药过猛」问题在客户端被解决。

`constraints` 为**文章硬性长度边界**：默认 `max_sentences=3`、`max_words_per_sentence=12`、`no_dialogue=true`。服务端读取后写入 prompt，强制 AI 产出「极简短句、日常生活场景、无对话、无宏大叙事」的短文。

`mode` 标识调用方身份：`user` 为已登录用户（携带 Bearer Token），`guest` 为游客（无 Token）。若希望游客也能获得 AI 短文，请在 Edge Function 中放行匿名 `generate_story` 请求并加 IP/频率限流（见下方「游客模式」一节）。若未放开，游客将自动回退到本地兜底短文，全流程仍可用。

---

## 🚪 游客模式

让 HR、访客或不愿注册的用户**免登录**完整体验产品，是转化注册的关键入口。

### 行为说明

| 维度 | 游客（Guest） | 登录用户（User） |
|------|--------------|-----------------|
| 入口 | 登录页「游客免费体验」按钮 | 邮箱 / Google 登录 |
| 进度存储 | 本机 `localStorage`（键 `lexiloop_guest_progress`） | Supabase 云端（跨设备） |
| 持久化 | 同一浏览器刷新 / 重开保留 | 任意设备登录即同步 |
| 间隔重复 / 复习 | ✅ 本机计算（基于本地 `next_review_at`） | ✅ 云端计算 |
| AI 短文 | 取决于 Edge Function 是否放行匿名（否则回退本地兜底） | ✅ 携带 Token 调用 |
| 升级为正式账号 | 右上角「登录保存进度」一键切换 | — |

### 前端实现要点

- `Auth.init()` 现在返回三态：`"user"` / `"guest"` / `"none"`。游客由 `localStorage` 键 `lexiloop_guest === "1"` 识别，优先级高于登录态。
- 游客模式下 `Vocabulary.loadGuestProgress()` 从本机恢复掌握状态，`StoryEngine.processResults()` 在挑战结束后通过 `Vocabulary.saveGuestProgress()` 写回本机。
- 游客已掌握的单词会在后续会话中被自动跳过（与不登录时每次都从零开始不同），体验更连贯。

### 让游客也获得真·AI 短文（可选）

默认情况下 Edge Function 可能因缺少 Token 而拒绝游客请求，此时前端自动回退到本地生成的兜底短文（含完形填空，流程不受影响）。若希望游客也调用大模型，在 Edge Function 中放行匿名 `generate_story` 并加限流：

```typescript
// supabase/functions/generate-story/index.ts (节选)
Deno.serve(async (req) => {
  const { action, words, difficulty = "intermediate", mode = "user" } = await req.json();

  // 游客：仅放行故事生成，且做简单频率限制，防止额度被盗刷
  if (mode === "guest" && action === "generate_story") {
    const ip = req.headers.get("x-forwarded-for") ?? "unknown";
    // 接入你的限流逻辑（如 Deno KV / Upstash），例如每 IP 每小时 20 次
    // if (await rateLimited(ip)) return new Response("rate limited", { status: 429 });
  }

  // 已登录用户仍建议校验 Token（原逻辑保留）
  // const authHeader = req.headers.get("Authorization"); ...
  // ... 调用大模型生成 ...
});
```

> 游客无法调用 `lookup_word`（查词）等需鉴权的 action，但词库内置词点击后可直接从本地展示释义，无需联网。

---

## 🛠️ 后端配置（Supabase）

### 1. 创建数据表（SQL）

在 Supabase 控制台的 SQL Editor 执行：

```sql
-- 单词掌握进度
create table if not exists public.word_progress (
  user_id          uuid        not null references auth.users(id) on delete cascade,
  word             text        not null,
  phonetic         text        default '',
  definition       text        default '',
  translation      text        default '',
  status           text        not null default 'unknown', -- unknown | learning | mastered
  correct_count    integer     not null default 0,
  wrong_count      integer     not null default 0,
  last_reviewed_at timestamptz,
  mastered_at      timestamptz,
  next_review_at   timestamptz,
  primary key (user_id, word)
);

-- 学习会话记录
create table if not exists public.learning_sessions (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references auth.users(id) on delete cascade,
  session_type text        not null,
  words_tested text[]      not null default '{}',
  score        numeric     not null default 0,
  detail       jsonb,
  created_at   timestamptz not null default now()
);

-- 用户统计（连续打卡、掌握总数等）
create table if not exists public.user_stats (
  user_id             uuid primary key references auth.users(id) on delete cascade,
  total_words_mastered integer not null default 0,
  total_sessions      integer not null default 0,
  streak_days         integer not null default 0,
  last_study_date     date
);
```

### 2. 启用行级安全（RLS）

每个用户只能读写自己的数据：

```sql
alter table public.word_progress      enable row level security;
alter table public.learning_sessions enable row level security;
alter table public.user_stats         enable row level security;

create policy "own_progress"  on public.word_progress
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own_sessions"  on public.learning_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own_stats"     on public.user_stats
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

### 3. Edge Function `generate-story`

大模型 Key（如 DeepSeek）**仅存于你的 Supabase 服务端环境变量**，**不要** 写进前端或 git 仓库。本前端只通过 `js/supabase-client.js` 中的 `SUPABASE_URL + "/functions/v1/generate-story"` 调用它，从不持有任何密钥。

> ⚠️ **重要：本仓库的 `functions/generate-story/index.ts` 仅作为「可选升级参考」，请勿直接部署覆盖。**
> 你的 Supabase 项目里**已经部署了一个正常工作的 `generate-story` 函数**（实测返回 HTTP 200 与完整的 DeepSeek 生成故事 JSON，含 `title` / `story` / `translation` / `questions`）。如果你去 Supabase 后台「New Function 并粘贴本仓库文件」部署，会**覆盖掉你现有的正常运行函数**。
> 只有在「原函数丢失 / 想重建 / 想升级（换模型、加限流、加超时）」时，才用本文件作为起点。
> 前端期望的函数返回契约见下方示例（保持 `title / story / translation / questions[]` 字段即可兼容）。

```typescript
// supabase/functions/generate-story/index.ts (Deno)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const DIFFICULTY_PROMPT = {
  beginner:      "Use very simple vocabulary and short sentences. CEFR A2 level.",
  intermediate:  "Use standard IELTS-context vocabulary and moderate sentences. CEFR B2.",
  advanced:      "Use academic, dense sentences similar to IELTS Reading. CEFR C1.",
};

Deno.serve(async (req) => {
  const { action, words, word, difficulty = "intermediate" } = await req.json();

  if (action === "lookup_word") {
    // 调用词典 API 或返回本地释义，返回 { word, phonetic, definition, translation }
    return new Response(JSON.stringify({ word, phonetic: "/.../", definition: "...", translation: "..." }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const sys = `You are an IELTS tutor. Write a tiny coherent story (3-5 sentences) that naturally uses EVERY word in the list as a <span class="target-word" data-word="Word">Word</span> highlight. ${DIFFICULTY_PROMPT[difficulty] || ""}`;
  const user = `Words: ${words.join(", ")}.
For EACH word, create ONE cloze sentence: a natural, contextual English sentence with the target word replaced by exactly five underscores "_____". Do NOT use the target word itself in the sentence.
Return strictly JSON:
{
  "title": "short story title",
  "story": "HTML string with highlighted target words",
  "translation": "Chinese translation of the whole story",
  "questions": [
    {
      "target_word": "Word",
      "cloze_sentence": "A contextual English sentence with _____ where the word fits",
      "options": ["Word", "distractor1", "distractor2", "distractor3"],
      "options_translation": ["中文", "干扰项中文", "..."],
      "correct_answer": "Word"
    }
  ]
}`;

  const apiKey = Deno.env.get("DEEPSEEK_API_KEY");
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      response_format: { type: "json_object" },
    }),
  });
  const data = await r.json();
  const result = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
});
```

> **（仅当你决定重建/替换现有函数时才需要执行以下要点）部署要点：**
> 1. 函数名必须为 `generate-story`，部署后 URL = `${SUPABASE_URL}/functions/v1/generate-story`，须与前端 `js/supabase-client.js` 的 `SUPABASE_URL` 一致。
> 2. **关闭该函数的 JWT 校验（Verify JWT = OFF）**，否则游客（无 token）调用会被 401 拒绝；CLI 用 `supabase functions deploy generate-story --no-verify-jwt`。
> 3. 在 **Project Settings → Edge Functions → Secrets** 新增 `DEEPSEEK_API_KEY`（值填你的 Key，**只填这里，不进代码**）；游客限流建议在同页开启（约 8 次/分/IP）。
>
> 若 AI 服务不可用（函数未部署 / 未设密钥 / 跨域被拦 / JWT 未关闭），前端会自动使用 `js/vocabulary-data.js` 中每个词条的 `example` 字段（含 `_____` 占位符）生成本地兜底句子挖空题，保证游客/未登录用户也能完整体验。
>
> **关于「文章太长」**：本仓库参考实现 `functions/generate-story/index.ts` 已读取前端传入的 `constraints` 字段并写入 prompt，强制 AI 产出 **最多 3 句、每句 ≤12 词、日常生活场景、无对话** 的极简短文。若你 Supabase 上现有函数生成的文章仍偏长，可在后台编辑该函数，把同样边界写进 prompt；或备份后部署本仓库参考文件覆盖（注意：部署会覆盖你现有函数）。

### 4. 前端客户端配置

编辑 `js/supabase-client.js`，替换为你的项目地址与 anon key（**publishable key，可公开**，安全由 RLS 保证）：

```javascript
const SUPABASE_URL = "https://your-project.supabase.co";
const SUPABASE_ANON_KEY = "your-anon-key";
```

---

## 🚀 本地运行

任意静态服务器即可（无需构建）：

```bash
# 任选其一
python3 -m http.server 8080
# 或
npx serve .
```

打开 `http://localhost:8080/` 即可。首次使用点击右上角注册一个账号（或配置 Google OAuth）。

---

## ☁️ 部署

纯静态产物，可部署到任意静态托管（CloudStudio、Vercel、Netlify、GitHub Pages 等）。确保 `index.html` 与 `login.html` 及 `js/` 目录一同上传。若托管平台对未知路径做 SPA 回退（fallback 到 index.html），不影响功能，但请勿依赖不存在的 `manifest.json` / `css/style.css` 等路径。

---

## 📝 词库扩展

词库位于 `js/vocabulary-data.js` 的 `IELTS_VOCABULARY_FULL`，每条格式：

```javascript
{ word: "Acknowledge", phonetic: "/əkˈnɒl.ɪdʒ/", definition: "英文释义...", translation: "中文释义" }
```

可自由扩充至 300+ 词；`index.html` 的「词汇大纲」下拉亦可接入多套词表。

---

## 📄 许可

MIT License. 仅供学习与交流使用。
