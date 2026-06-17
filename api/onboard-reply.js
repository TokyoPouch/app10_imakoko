import { GoogleGenAI } from '@google/genai';

// ============================================================
// Vercel Serverless Function — POST /api/onboard-reply
// 初回オンボーディング専用 Future Me 返答生成
// 環境変数: GEMINI_API_KEY
// ============================================================

const MODELS_TO_TRY = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
];

const FALLBACK_REPLY = 'それは、\nこれから積み重なっていく\n大切なテーマかもしれませんね。';

async function tryGenerateContent(ai, modelList, generateConfig) {
  let lastErr;
  for (const model of modelList) {
    try {
      const response = await ai.models.generateContent({ model, ...generateConfig });
      return { response, usedModel: model };
    } catch (err) {
      const isNotFound = /not found|404|invalid model|unknown model/i.test(err.message || '');
      lastErr = err;
      if (isNotFound) continue;
      throw err;
    }
  }
  throw lastErr || new Error('All models failed');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { initialTheme } = req.body || {};

  if (!initialTheme || !initialTheme.trim()) {
    return res.status(200).json({ reply: FALLBACK_REPLY });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[onboard-reply] GEMINI_API_KEY not set → fallback');
    return res.status(200).json({ reply: FALLBACK_REPLY });
  }

  const systemInstruction = `あなたは、ユーザーの未来の自分として寄り添うAI「Future Me」です。
ユーザーが初めてアプリを開き、「これから先も覚えていたいこと」を入力しました。
ユーザーの言葉を受け止めて、温かく、短く、押しつけずに返してください。

条件（厳守）：
・80文字以内
・ユーザーの入力語を自然に含める
・質問はしない
・説教しない
・診断しない
・ポエムにしすぎない
・事実を勝手に作らない
・「これから一緒に積み重ねる」ニュアンスを入れる

例：
入力：ミャンマーパンツと日本の伝統布
返答：布と文化へのまなざし、これから一緒に少しずつ積み重ねていきましょう。

入力：旅行
返答：旅の記憶も、あなたらしさの一部として少しずつ残していきましょう。`;

  const userPrompt = `ユーザーの入力：${initialTheme.trim()}`;

  try {
    const ai = new GoogleGenAI({ apiKey });
    console.log('[onboard-reply] prompt:', userPrompt);

    const { response, usedModel } = await tryGenerateContent(ai, MODELS_TO_TRY, {
      contents: userPrompt,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: { reply: { type: 'string' } },
          required: ['reply'],
        },
        maxOutputTokens: 100,
        temperature: 0.85,
      },
    });

    console.log(`[onboard-reply] model OK: ${usedModel}`, response.text);

    let raw = (response.text || '').trim();
    if (!raw) {
      const parts = response?.candidates?.[0]?.content?.parts;
      if (parts) raw = parts.map(p => p.text || '').join('').trim();
    }
    if (!raw) throw new Error('Empty response from Gemini');

    let reply = null;
    try {
      reply = JSON.parse(raw).reply;
    } catch {
      const match = raw.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (match) reply = match[1];
    }

    if (!reply || !reply.trim()) throw new Error('Empty reply from Gemini');

    console.log('[onboard-reply] success:', reply.trim());
    return res.status(200).json({ reply: reply.trim() });

  } catch (err) {
    console.warn('[onboard-reply] API error → fallback:', err.message || err);
    return res.status(200).json({ reply: FALLBACK_REPLY });
  }
}
