import { GoogleGenAI } from '@google/genai';

// ============================================================
// Vercel Serverless Function — POST /api/generate-books
// 環境変数: GEMINI_API_KEY
// 役割: 人生テーマ（棚）と関連記録から「本（関心テーマ）」を生成する
// v3.21: 固有名詞禁止・関心テーマ命名ルール適用
// ============================================================

const MODELS_TO_TRY = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
];

// ── モデル試行ヘルパー ─────────────────────────────────────────
async function tryGenerateContent(ai, modelList, generateConfig) {
  let lastErr;
  for (const model of modelList) {
    try {
      console.log(`[generate-books] trying model: ${model}`);
      const response = await ai.models.generateContent({ model, ...generateConfig });
      console.log(`[generate-books] model OK: ${model}`);
      return { response, usedModel: model };
    } catch (err) {
      const errMsg = err.message || '';
      const isNotFound = /not found|404|invalid model|unknown model/i.test(errMsg);
      console.warn(`[generate-books] model "${model}" failed:`, errMsg);
      lastErr = err;
      if (isNotFound) continue;
      throw err;
    }
  }
  throw lastErr || new Error('All models failed');
}

// ── ローカルフォールバック（固有名詞フィルター付き）──────────────
// ツール名・サービス名として判定するリスト
const PROPER_NOUN_PATTERNS = [
  /^chatgpt$/i, /^gemini$/i, /^claude$/i, /^cursor$/i, /^copilot$/i,
  /^vercel$/i, /^openai$/i, /^midjourney$/i, /^dall-?e$/i, /^notion$/i,
  /^slack$/i, /^discord$/i, /^github$/i, /^figma$/i, /^notion$/i,
];

function isProperNounOnly(name) {
  const trimmed = name.trim();
  return PROPER_NOUN_PATTERNS.some(p => p.test(trimmed));
}

// テーマ→本のデフォルトマッピング（フォールバック用）
const DEFAULT_BOOK_MAP = [
  {
    themeKeys: ['AI', '人工知能', '機械学習', '生成AI'],
    books: ['AIとの対話', 'AIを使った制作', 'AIエージェント', 'Webサービス開発', '創作支援AI']
  },
  {
    themeKeys: ['文化', '布', '伝統', '染め', '織'],
    books: ['日本の伝統布', 'ミャンマーパンツ', '民族衣装の記録', '手仕事の継承']
  },
  {
    themeKeys: ['認知症', '記憶', '介護', '忘れ'],
    books: ['認知症支援', '記憶のデザイン', 'ケアの記録']
  },
  {
    themeKeys: ['プログラミング', 'コード', '開発', 'エンジニア'],
    books: ['Webサービス開発', 'アプリ制作の記録', '技術探索']
  },
  {
    themeKeys: ['音楽', 'ライブ', 'バンド', 'プレイリスト'],
    books: ['音楽との出会い', 'ライブの記憶', '好きな音と言葉']
  },
  {
    themeKeys: ['旅行', '旅', '異文化', '海外'],
    books: ['旅で出会った風景', '文化交流の記録', '行きたい場所']
  },
];

function buildLocalBooks(theme, relatedEntries) {
  const themeText = (theme || '').toLowerCase();

  for (const group of DEFAULT_BOOK_MAP) {
    if (group.themeKeys.some(k => themeText.includes(k.toLowerCase()))) {
      return group.books.slice(0, 5);
    }
  }

  const entryTexts = (relatedEntries || [])
    .map(r => ((r.memo || '') + ' ' + (r.url || '')).trim())
    .filter(Boolean)
    .join(' ');

  if (entryTexts.includes('AI') || entryTexts.includes('GPT') || entryTexts.includes('Gemini')) {
    return ['AIとの対話', 'AIを使った制作', 'AIエージェント'];
  }

  return ['記録のまとまり', 'このテーマの探索'];
}

// ── 複数テーマ用ローカルフォールバック ──────────────────────────
function buildLocalFullShelf(themes, entries) {
  return (themes || []).map(theme => {
    const books = buildLocalBooks(theme, entries);
    return { title: theme, books };
  }).filter(s => s.title && s.books.length > 0);
}

// ============================================================
// HANDLER
// ============================================================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { theme = '', relatedEntries = [], themes, entries, userTags } = req.body || {};

  const apiKey = process.env.GEMINI_API_KEY;

  // ── 複数テーマ（新形式）: { themes, entries, userTags } ────────
  if (Array.isArray(themes) && themes.length > 0) {
    if (!apiKey) {
      console.warn('[generate-books] GEMINI_API_KEY not set → local fallback (multi-theme)');
      return res.status(200).json({ shelf: buildLocalFullShelf(themes, entries || []) });
    }

    const safeEntries = Array.isArray(entries) ? entries.slice(0, 50) : [];
    const entriesText = safeEntries
      .map(r => [
        `・${r.date || '?'}`,
        r.memo   ? `メモ:${r.memo}` : null,
        (r.tags && r.tags.length) ? `タグ:[${r.tags.join(',')}]` : null,
        r.futureMeAnswer ? `深掘り:${r.futureMeAnswer}` : null,
      ].filter(Boolean).join(' / '))
      .join('\n') || 'なし';

    const userTagsText = (userTags || []).join('、') || 'なし';

    const userPromptMulti = `以下のJSONのみを返してください。
マークダウン（\`\`\`json 等の囲み）・前置き・説明文は一切禁止。

あなたはユーザーの記録から「好きの棚」を整理するAIです。
記録・タグ・深掘り回答を分析し、各棚（人生テーマ）の「本（関心テーマ）」を提案してください。

【棚について】
以下の棚名をそのまま使用してください（変更・省略禁止）：
${JSON.stringify(themes)}

【本の命名ルール】
・ツール名・サービス名のみの本は禁止（ChatGPT, Gemini, Vercel 等）
・活動テーマを表す名前を使う（例: AIとの対話, Webサービス開発, 創作支援AI）
・継続的な固有の活動テーマはOK（例: ミャンマーパンツ, 日本の伝統布, 認知症支援）
・各棚につき最大5個、重複禁止、短く分かりやすい名前

【出力フォーマット】
{
  "shelf": [
    { "title": "棚の名前（themesと完全一致）", "books": ["本1", "本2"] },
    { "title": "別の棚名", "books": ["本3"] }
  ]
}

【入力データ】

棚（人生テーマ）:
${JSON.stringify(themes)}

ユーザーのタグ:
${userTagsText}

記録:
${entriesText}`;

    try {
      const ai = new GoogleGenAI({ apiKey });

      console.log('[generate-books] multi-theme request, themes:', themes.length, 'entries:', safeEntries.length);

      const { response, usedModel } = await tryGenerateContent(ai, MODELS_TO_TRY, {
        contents: userPromptMulti,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'object',
            properties: {
              shelf: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    books: { type: 'array', items: { type: 'string' } }
                  },
                  required: ['title', 'books']
                }
              }
            },
            required: ['shelf']
          },
          maxOutputTokens: 1500,
          temperature: 0.4,
        },
      });

      console.log(`[generate-books] multi-theme response (${usedModel}):`, response.text);

      let raw = (response.text || '').trim();
      if (!raw) {
        try {
          const parts = response?.candidates?.[0]?.content?.parts;
          if (parts && parts.length > 0) raw = parts.map(p => p.text || '').join('').trim();
        } catch (e) {
          console.warn('[generate-books] candidates access failed:', e.message);
        }
      }
      if (!raw) throw new Error('Empty response from Gemini');

      raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      const parsed = JSON.parse(raw);

      const shelf = Array.isArray(parsed.shelf)
        ? parsed.shelf
            .map(item => ({
              title: (item.title || '').trim(),
              books: Array.isArray(item.books)
                ? item.books.map(b => (b || '').trim()).filter(b => b && !isProperNounOnly(b)).slice(0, 5)
                : []
            }))
            .filter(s => s.title && s.books.length > 0)
        : [];

      if (shelf.length === 0) throw new Error('Empty shelf after filtering');

      console.log('[generate-books] multi-theme success, shelves:', shelf.length);
      return res.status(200).json({ shelf });

    } catch (err) {
      console.warn('[generate-books] multi-theme API error → local fallback:', err.message || err);
      return res.status(200).json({ shelf: buildLocalFullShelf(themes, entries || []) });
    }
  }

  // ── 単一テーマ（旧形式）: { theme, relatedEntries } ───────────
  if (!apiKey) {
    console.error('[generate-books] GEMINI_API_KEY is not set → local fallback');
    const books = buildLocalBooks(theme, relatedEntries);
    return res.status(200).json({ books });
  }

  // ── Geminiプロンプト（v3.21: 本の命名ルール適用）──────────────
  const safeEntries = Array.isArray(relatedEntries) ? relatedEntries.slice(0, 20) : [];
  const entriesText = safeEntries
    .map(r => `・${r.date || '?'} / ${r.memo || 'メモなし'} / ${r.url || 'URLなし'}`)
    .join('\n') || 'なし';

  const userPrompt = `あなたは、ユーザーの記録から「関心テーマ（本）」を整理するAIです。

【目的】

提供された人生テーマ（棚）と関連する記録を分析し、

単なるツール名やサービス名ではなく、

ユーザーが継続的に関心を持っているテーマのまとまり

を抽出してください。

---

【本の定義】

本とは、

ユーザーが繰り返し記録している関心領域です。

本は単なるカテゴリではなく、

複数の記録を束ねる意味のまとまりです。

---

【重要ルール】

固有名詞だけの本は禁止です。

悪い例

・ChatGPT
・Gemini
・Claude
・Cursor
・Vercel

良い例

・AIとの対話
・AIを使った制作
・AIエージェント
・Webサービス開発
・創作支援AI

---

ただし、

以下のような継続的な活動テーマは、

そのまま本として使用して構いません。

例

・ミャンマーパンツ
・日本の伝統布
・認知症支援

---

【出力ルール】

・各棚につき最大5個
・重複禁止
・意味が近いものは統合
・短く分かりやすい名前にする

---

【出力形式】

JSONのみ

{
  "books": [
    "AIとの対話",
    "AIエージェント",
    "AIを使った制作"
  ]
}

---

【入力】

人生テーマ（棚）

${theme}

関連記録

${entriesText}`;

  // ── Gemini API 呼び出し ─────────────────────────────────────
  try {
    const ai = new GoogleGenAI({ apiKey });

    console.log('[generate-books] prompt length:', userPrompt.length);

    const { response, usedModel } = await tryGenerateContent(ai, MODELS_TO_TRY, {
      contents: userPrompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            books: {
              type: 'array',
              items: { type: 'string' }
            }
          },
          required: ['books']
        },
        maxOutputTokens: 400,
        temperature: 0.4,
      },
    });

    console.log(`[generate-books] response.text (${usedModel}):`, response.text);

    let effectiveRaw = (response.text || '').trim();

    // response.text が空なら candidates から直接取得
    if (!effectiveRaw) {
      try {
        const parts = response?.candidates?.[0]?.content?.parts;
        if (parts && parts.length > 0) {
          effectiveRaw = parts.map(p => p.text || '').join('').trim();
        }
      } catch (e) {
        console.warn('[generate-books] candidates access failed:', e.message);
      }
    }

    if (!effectiveRaw) throw new Error('Empty response from Gemini');

    // マークダウンコードブロックが含まれる場合は除去
    effectiveRaw = effectiveRaw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(effectiveRaw);
    } catch {
      throw new Error('JSON parse failed: ' + effectiveRaw.slice(0, 100));
    }

    // 固有名詞のみの本を除外 + 最大5個に制限
    let books = [];
    if (Array.isArray(parsed.books)) {
      books = parsed.books
        .filter(b => typeof b === 'string' && b.trim())
        .map(b => b.trim())
        .filter(b => !isProperNounOnly(b))
        .slice(0, 5);
    }

    // 空になった場合はフォールバック
    if (books.length === 0) {
      books = buildLocalBooks(theme, relatedEntries);
    }

    console.log('[generate-books] Gemini success, books count:', books.length);
    return res.status(200).json({ books });

  } catch (err) {
    console.warn('[generate-books] API error → local fallback:', err.message || err);
    const books = buildLocalBooks(theme, relatedEntries);
    return res.status(200).json({ books });
  }
}
