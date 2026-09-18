// ============================================================
// Supabase Edge Function: generate-story
// 项目：词境 LexiLoop（雅思语境抗遗忘背词）
//
// ⚠️ ⚠️ 重要：本文件是「可选升级参考」，请勿直接部署！
//   你的 Supabase 项目里【已经部署了一个正常工作的 generate-story 函数】
//   （实测返回 HTTP 200 与完整 DeepSeek 故事 JSON，前端完全兼容）。
//   若你到 Supabase 后台粘贴本文件「新建/覆盖」同名函数，会覆盖掉现有的
//   正常运行的函数。只有在「原函数丢失 / 想重建 / 想升级」时才用本文件作起点。
//
// 安全原则：
//   ⚠️ DeepSeek API Key 仅通过「服务端密钥」注入，本文件 NEVER 写死任何 Key。
//   部署方在 Supabase 后台设置密钥  DEEPSEEK_API_KEY = sk-xxxx
//   前端只调用本函数，永远拿不到真实 Key。
//
// 功能：
//   接收 { action, words, difficulty, mode }
//   调用 DeepSeek 生成「情景短文 + 句子挖空题」，返回前端所需 JSON：
//   { title, story(HTML), translation, questions[] }
// ============================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// ── CORS（CloudStudio 静态站跨域调用本函数必须） ──
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 难度只影响词汇复杂度；长度由 constraints 硬性约束，避免「给药过猛」
const DIFFICULTY_PROMPT: Record<string, string> = {
  beginner:
    "词汇：只许用 CEFR A2 级别日常词，禁止使用雅思长词、抽象名词、专业术语。",
  intermediate:
    "词汇：标准雅思高频词，句式简单直接，允许少量常见从句。",
  advanced:
    "词汇：学术/正式语体，可适度使用书面表达，但句子长度仍受下面硬性约束限制。",
};

// 简单 IP 级限流（游客模式 best-effort，需在 Supabase 后台为该 Function 启用 Deno KV）
async function rateLimitAllowed(ip: string, isGuest: boolean): Promise<boolean> {
  const LIMIT = isGuest ? 8 : 30; // 每窗口最大请求数
  const WINDOW_MS = 60_000;
  try {
    const kv = await Deno.openKv();
    const key = ["rl", ip, Math.floor(Date.now() / WINDOW_MS)];
    const res = await kv.get<number>(key);
    const count = (res.value ?? 0) + 1;
    await kv.set(key, count, { expireIn: WINDOW_MS });
    return count <= LIMIT;
  } catch {
    // KV 不可用时放行，依赖 Supabase 后台的「函数限流」兜底
    return true;
  }
}

function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

Deno.serve(async (req: Request) => {
  // 预检
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }

  // ── 解析并校验输入 ──
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const words: string[] = Array.isArray(body.words) ? body.words : [];
  const difficulty: string = DIFFICULTY_PROMPT[body.difficulty]
    ? body.difficulty
    : "intermediate";
  const mode: string = body.mode === "guest" ? "guest" : "user";
  const isGuest = mode === "guest" || !req.headers.get("authorization");

  // 文章长度边界：前端传入，服务端写入 prompt 强制约束
  // （句数上限放宽到 12：8-10 个目标词要在「一个连贯场景」里自然出现，
  //   3-5 句根本装不下，AI 只能写出「一句一词、句句无关」的词典式拼凑）
  const rawConstraints = body.constraints || {};
  const constraints = {
    max_sentences: Math.min(
      Math.max(parseInt(rawConstraints.max_sentences, 10) || 8, 3),
      12
    ),
    max_words_per_sentence: Math.min(
      Math.max(parseInt(rawConstraints.max_words_per_sentence, 10) || 14, 6),
      25
    ),
    style: String(rawConstraints.style || "simple"),
    tone: String(rawConstraints.tone || "daily"),
    no_dialogue: rawConstraints.no_dialogue !== false,
  };

  // 入参护栏：防止滥用 / prompt injection
  if (words.length === 0 || words.length > 10) {
    return new Response(
      JSON.stringify({ error: "words 数量需在 1-10 之间" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
  const cleanWords = words
    .map((w) => String(w).trim())
    .filter((w) => w.length > 0 && w.length <= 40);

  // 游客限流
  const allowed = await rateLimitAllowed(clientIp(req), isGuest);
  if (!allowed) {
    return new Response(JSON.stringify({ error: "请求过于频繁，请稍后再试" }), {
      status: 429,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const apiKey = Deno.env.get("DEEPSEEK_API_KEY");
  if (!apiKey) {
    // 密钥未配置 → 返回 503，前端会自动回退到本地例句挖空
    return new Response(
      JSON.stringify({ error: "AI 服务未配置（缺少 DEEPSEEK_API_KEY）" }),
      {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  // ── 构造 Prompt ──
  const boundaryLines = [
    `【硬性长度边界】必须遵守，不可突破：`,
    `- 全文约 ${constraints.max_sentences} 句（可在 ±1 句内浮动），必须足够容纳所有目标词自然出场。`,
    `- 每句话最多 ${constraints.max_words_per_sentence} 个英文单词。`,
    `- 只能使用 1 个简单段落；禁止分段；禁止换行。`,
    constraints.no_dialogue ? `- 禁止出现任何引号或对话。` : "",
    `- 目标词 HTML 高亮格式：<span class="target-word" data-word="WORD">WORD</span>。`,
  ]
    .filter(Boolean)
    .join("\n");

  const sys = `你是一位专为雅思考生写「情景记忆短文」的导师。你要写的不是例句清单，而是一个真实、连贯、极易读懂的生活小场景。

1) 一篇连贯的英文迷你故事（必须遵守下方【硬性长度边界】）：
   - 全文必须围绕【唯一一个场景】展开（例如：一个下雨的早晨赶公交、一次超市采购、一次课堂展示、一次朋友聚餐），从头到尾不换场景。
   - 句与句之间用时间或因果衔接（First... / Then... / Because... / So... / After...），读起来是一个完整的小故事。
   - 所有目标词都必须在情节中自然出现；允许多个目标词出现在同一句；读者能通过上下文猜出每个目标词的意思。
   - 严禁「一句一词、句句无关」的词典式拼凑——每个句子孤立成立、句间没有故事联系，就是失败的作品。

2) 短文的标准简体中文翻译：通顺、自然、符合中文表达习惯，读起来像人话，禁止逐词直译的翻译腔。

3) 每个目标词一道「句子挖空」题：一句自然的英文例句，在目标词该出现的位置用 _____ 占位；给出 3 个干扰项（拼写/词义易混淆的雅思词汇，不能是正确答案），以及每个选项的简体中文释义。

${DIFFICULTY_PROMPT[difficulty]}

${boundaryLines}

严格要求：只返回如下结构的 JSON 对象，不要任何 markdown 代码块、不要多余文字：
{
  "title": "短文标题（4词以内）",
  "story": "HTML 字符串，目标词用 <span class=\\"target-word\\" data-word=\\"WORD\\">WORD</span> 高亮",
  "translation": "整篇中文翻译",
  "questions": [
    {
      "target_word": "Word",
      "cloze_sentence": "一句自然的英文，目标词位置用 _____ 占位",
      "options": ["Word", "distractor1", "distractor2", "distractor3"],
      "options_translation": ["正确词中文", "干扰项1中文", "干扰项2中文", "干扰项3中文"],
      "correct_answer": "Word"
    }
  ]
}`;

  const user = `目标词（共 ${cleanWords.length} 个，${difficulty} 难度，约束：${constraints.max_sentences}句/每句≤${constraints.max_words_per_sentence}词）：
${cleanWords.map((w, i) => `${i + 1}. ${w}`).join("\n")}

请生成严格遵守上述长度边界的 JSON。`;

  // ── 调用 DeepSeek ──
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);

    const dsRes = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        temperature: 0.7,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!dsRes.ok) {
      const txt = await dsRes.text();
      console.error("DeepSeek error", dsRes.status, txt);
      return new Response(
        JSON.stringify({ error: "AI 服务调用失败" }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const dsJson = await dsRes.json();
    const content = dsJson?.choices?.[0]?.message?.content;
    if (!content) {
      return new Response(
        JSON.stringify({ error: "AI 返回为空" }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // 解析 AI 返回的 JSON（容错：去掉可能的 ``` 包裹）
    let parsed: any;
    try {
      parsed = JSON.parse(content.trim().replace(/^```(?:json)?|```$/g, "").trim());
    } catch {
      return new Response(
        JSON.stringify({ error: "AI 返回格式异常" }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // 基本字段校验，保证前端不崩
    if (!parsed.title || !parsed.story || !Array.isArray(parsed.questions)) {
      return new Response(
        JSON.stringify({ error: "AI 返回结构不完整" }),
        {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    return new Response(JSON.stringify(parsed), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    console.error("generate-story failed:", e);
    return new Response(
      JSON.stringify({ error: "AI 服务暂不可用" }),
      {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
