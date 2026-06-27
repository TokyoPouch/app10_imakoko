import { GoogleGenAI } from '@google/genai';

// ============================================================
// Vercel Serverless Function — POST /api/analyze-photo
// 環境変数: GEMINI_API_KEY
// 役割: 写真から記憶を引き出すきっかけになる説明文を生成する
// 入力: { photoBase64: "data:image/jpeg;base64,..." }
// 出力: { photoAnalysis: { description: "..." } }
// ============================================================

const MODELS_TO_TRY = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
];

const SYSTEM_INSTRUCTION = `あなたはユーザーの記録写真を見て、短い説明文を生成するAIです。
以下のルールを必ず守ってください：

・1〜2文で説明する
・「人がいます」「空があります」「海です」だけの物体列挙は禁止
・写真から分かる事実と、写真から感じられる雰囲気は区別して書く
・ユーザーの気持ちを決めつけない
・「〜のようです」「〜かもしれません」という表現を使う
・読み取れない場合は「大切な一枚のようです。」と返す

悪い例：「特別な思い出ですね。」
良い例：「海辺で撮られた一枚のようです。穏やかな時間だったのかもしれません。」

写真の内容を説明することが目的ではありません。この写真を見たユーザーが、自分の記憶や感情を思い出すきっかけになる説明を生成してください。事実と推測を区別し、ユーザーの気持ちを決めつけないでください。`;

async function tryGenerateContent(ai, modelList, generateConfig) {
  let lastErr;
  for (const model of modelList) {
    try {
      console.log(`[analyze-photo] trying model: ${model}`);
      const response = await ai.models.generateContent({ model, ...generateConfig });
      console.log(`[analyze-photo] model OK: ${model}`);
      return { response, usedModel: model };
    } catch (err) {
      const errMsg = err.message || '';
      const isNotFound = /not found|404|invalid model|unknown model/i.test(errMsg);
      console.warn(`[analyze-photo] model "${model}" failed:`, errMsg);
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

  const { photoBase64 } = req.body || {};

  if (!photoBase64) {
    return res.status(400).json({ error: 'photoBase64 is required' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[analyze-photo] GEMINI_API_KEY not set → null description');
    return res.status(200).json({ photoAnalysis: { description: null } });
  }

  // data URL をパース: "data:image/jpeg;base64,/9j/..."
  let mimeType = 'image/jpeg';
  let base64Data = photoBase64;
  const dataUrlMatch = photoBase64.match(/^data:([^;]+);base64,(.+)$/);
  if (dataUrlMatch) {
    mimeType = dataUrlMatch[1];
    base64Data = dataUrlMatch[2];
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    const { response, usedModel } = await tryGenerateContent(ai, MODELS_TO_TRY, {
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: { mimeType, data: base64Data }
            },
            {
              text: 'この写真について、以下のJSONのみを返してください。マークダウン・前置き・説明文は禁止。\n{"description": "1〜2文の説明文"}'
            }
          ]
        }
      ],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            description: { type: 'string' }
          },
          required: ['description']
        },
        maxOutputTokens: 200,
        temperature: 0.6,
      },
    });

    console.log(`[analyze-photo] response (${usedModel}):`, response.text);

    let raw = (response.text || '').trim();
    if (!raw) {
      try {
        const parts = response?.candidates?.[0]?.content?.parts;
        if (parts && parts.length > 0) raw = parts.map(p => p.text || '').join('').trim();
      } catch (e) {
        console.warn('[analyze-photo] candidates access failed:', e.message);
      }
    }
    if (!raw) throw new Error('Empty response from Gemini');

    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const parsed = JSON.parse(raw);
    const description = (parsed.description || '').trim();
    if (!description) throw new Error('Empty description');

    console.log('[analyze-photo] success:', description);
    return res.status(200).json({ photoAnalysis: { description } });

  } catch (err) {
    console.warn('[analyze-photo] error → null description:', err.message || err);
    return res.status(200).json({ photoAnalysis: { description: null } });
  }
}
