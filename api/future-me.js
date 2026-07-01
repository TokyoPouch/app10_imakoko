import { GoogleGenAI } from '@google/genai';

// ============================================================
// Vercel Serverless Function — POST /api/future-me
// 環境変数: GEMINI_API_KEY
// STEP1: comment と question を1回のAPI呼び出しで同時生成
//
// app10_imakoko v6
// STEP2.1 Future Me文脈理解改善
// STEP2.2 Geminiモデルフォールバック
// ============================================================

const MODELS_TO_TRY = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
];

// ── ローカルフォールバック：コメント生成 ──────────────────────
function buildLocalComment(currentEntry) {
  const memo = (currentEntry.memo || '').trim();
  const url  = (currentEntry.url  || '').trim();
  const date = (currentEntry.date || '');
  const tags = Array.isArray(currentEntry.tags) ? currentEntry.tags.join(' ') : '';
  const location = (currentEntry.location || '').trim();
  // キーワード判定はメモ・URLのみを対象にする（タグの断片が別ジャンルの
  // キーワードに偶然マッチしてしまうのを避けるため）。タグ・場所は
  // メモが無い場合の専用フォールバック分岐でのみ使う。
  const text = (memo + ' ' + url).toLowerCase();

  let urlHint = '';
  if (url) {
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, '');
      const service  = hostname.split('.')[0].toLowerCase();
      const svcMap = {
        makuake: 'Makuake', campfire: 'CAMPFIRE', youtube: 'YouTube',
        twitter: 'X(Twitter)', instagram: 'Instagram', note: 'note',
        facebook: 'Facebook', amazon: 'Amazon', spotify: 'Spotify',
      };
      urlHint = svcMap[service] || hostname;
    } catch { /* ignore */ }
  }

  const short = memo.length > 20 ? memo.slice(0, 20) + '…' : memo;

  if (/makuake|campfire|クラファン|クラウドファンディング/.test(text)) {
    return `${urlHint || 'Makuake'}に挑戦していましたね。今も新しい展開を考えていますか？`;
  }
  const yearMatch = memo.match(/(\d+)\s*年/);
  if (yearMatch) {
    return urlHint
      ? `${urlHint}、${yearMatch[1]}年続いているんですね。今も育てたいテーマですか？`
      : `「${short}」${yearMatch[1]}年経った今も続いていますか？`;
  }
  if (/音楽|プレイリスト|ライブ|コンサート|アルバム|バンド|歌|曲/.test(text) || urlHint === 'Spotify') {
    return 'この曲、今も聴いていますか？最近のお気に入りは変わりましたか？';
  }
  if (/アニメ|マンガ|漫画|コミック/.test(text)) {
    return memo ? `「${short}」今も好きですか？印象に残っている場面はありますか？` : 'この作品、今も好きですか？';
  }
  if (/映画|ドラマ/.test(text)) {
    return memo ? `「${short}」今も印象に残っていますか？` : 'この映画、もう一度見たいと思いますか？';
  }
  if (urlHint === 'YouTube' || /youtube|動画/.test(text)) {
    return 'この動画、今も参考にしていますか？';
  }
  if (/旅行|旅|観光|温泉|景色|trip/.test(text)) {
    return memo ? `「${short}」また行きたいと思いますか？` : 'この場所、また訪れたいですか？';
  }
  if (/アイデア|構想|企画|やりたい|したい/.test(text)) {
    return memo ? `「${short}」そのアイデア、今も温めていますか？` : 'このアイデア、今も続いていますか？';
  }
  if (memo) return `「${short}」今も気になっていますか？`;
  if (Array.isArray(currentEntry.tags) && currentEntry.tags.length > 0) {
    const firstTag = currentEntry.tags[0];
    return `「${firstTag}」につながる記録ですね。今も大切にしたいですか？`;
  }
  if (location) return `${location}の記録ですね。今も思い出すことはありますか？`;
  if (urlHint) return `${urlHint}に保存していましたね。今も参考にしていますか？`;
  if (url) return 'このURL、今見ても気になりますか？';

  const month = parseInt(date.slice(5, 7), 10);
  if (month >= 3  && month <= 5)  return 'この春の記録、今見ると何を思い出しますか？';
  if (month >= 6  && month <= 8)  return 'この夏の記録、当時何を考えていましたか？';
  if (month >= 9  && month <= 11) return 'この秋の記録、あの頃と今で変わりましたか？';
  return 'この記録、今も気になっていますか？';
}

// ── ローカルフォールバック：質問生成 ──────────────────────────
function buildLocalQuestion(currentEntry) {
  const tags = Array.isArray(currentEntry.tags) ? currentEntry.tags.join(' ') : '';
  const location = (currentEntry.location || '').trim();
  // buildLocalComment と同様、キーワード判定はメモ・URLのみを対象にする
  const text = ((currentEntry.memo || '') + ' ' + (currentEntry.url || '')).toLowerCase();

  if (/旅行|旅|観光|場所|温泉|景色/.test(text)) return 'また行きたいと思いましたか？';
  if (/友|出会い|会った|会い/.test(text)) return 'その場の空気、どんな感じでしたか？';
  if (/音楽|ライブ|コンサート|曲|歌/.test(text)) return 'どんな気持ちで聴いていましたか？';
  if (/映画|ドラマ|アニメ|マンガ/.test(text)) return '印象に残っているシーンはありますか？';
  if (/アイデア|企画|やりたい/.test(text)) return '今もそのアイデア、続いていますか？';
  if (!(currentEntry.memo || '').trim() && tags) return '今も大切にしたいテーマですか？';
  if (!(currentEntry.memo || '').trim() && !tags && location) return 'その場所は、今も残っている場所ですか？';
  return 'どんな気持ちでしたか？';
}

// ── Geminiへのコンテンツ生成（モデルを順番に試す）─────────────
// STEP2.2: 404/invalid model だけでなく、503/UNAVAILABLE/overloaded/timeout
// のような一時的な不調でも次のモデルへフォールバックする。
// 429/quota はモデルを変えても改善しにくいためローカルフォールバックへ委ねる。
async function tryGenerateContent(ai, modelList, generateConfig) {
  let lastErr;

  for (const model of modelList) {
    try {
      console.log(`[future-me] trying model: ${model}`);
      const response = await ai.models.generateContent({ model, ...generateConfig });
      console.log(`[future-me] model OK: ${model}`);
      return { response, usedModel: model };
    } catch (err) {
      const errMsg = err.message || '';
      const status = err.status || err.statusCode || err.code;

      const isNotFound = /not found|404|invalid model|unknown model/i.test(errMsg)
        || status === 404;

      const isRetryable = /503|UNAVAILABLE|overloaded|temporarily|timeout|ETIMEDOUT|ECONNRESET/i.test(errMsg)
        || status === 503
        || status === 504;

      const isQuota = /429|RESOURCE_EXHAUSTED|quota/i.test(errMsg)
        || status === 429;

      console.warn(`[future-me] model "${model}" failed:`, errMsg);

      lastErr = err;

      if (isNotFound || isRetryable) {
        continue;
      }

      if (isQuota) {
        throw err;
      }

      throw err;
    }
  }

  throw lastErr || new Error('All models failed');
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

  const { currentEntry, memoryThemes = [], photoAnalysis } = req.body || {};

  if (!currentEntry) {
    return res.status(400).json({ error: 'currentEntry is required' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[future-me] GEMINI_API_KEY is not set → local fallback');
    return res.status(200).json({
      comment:  buildLocalComment(currentEntry),
      question: buildLocalQuestion(currentEntry),
    });
  }

  // ── プロンプト構築 ────────────────────────────────────────
  // photoAnalysis はリクエストボディまたは currentEntry のどちらから来ても対応
  const effectivePhotoAnalysis = photoAnalysis || currentEntry.photoAnalysis || null;

  const tagsText = Array.isArray(currentEntry.tags) && currentEntry.tags.length > 0
    ? currentEntry.tags.join(', ')
    : 'なし';

  // STEP2.1: メモ・タグ・場所・URLのいずれかがあれば「主情報あり」とし、
  // 写真（補助情報）だけを根拠にコメント・質問を作らせないようにする
  const hasPrimaryContext = Boolean(
    (currentEntry.memo && currentEntry.memo.trim()) ||
    (Array.isArray(currentEntry.tags) && currentEntry.tags.length > 0) ||
    (currentEntry.location && currentEntry.location.trim()) ||
    (currentEntry.url && currentEntry.url.trim())
  );

  const currentText = [
    '現在の記録：',
    `主情報あり: ${hasPrimaryContext ? 'はい' : 'いいえ'}`,
    `日付: ${currentEntry.date     || 'なし'}`,
    `メモ: ${currentEntry.memo     || 'なし'}`,
    `タグ: ${tagsText}`,
    `場所: ${currentEntry.location || 'なし'}`,
    `URL: ${currentEntry.url       || 'なし'}`,
    effectivePhotoAnalysis && effectivePhotoAnalysis.description
      ? `写真（補助情報）: ${effectivePhotoAnalysis.description}`
      : null,
  ].filter(Boolean).join('\n');

  // memoryThemes は文字列配列またはオブジェクト配列のどちらでも対応
  const safeMemory = Array.isArray(memoryThemes) ? memoryThemes.slice(0, 20) : [];
  const memoryText = safeMemory.length > 0
    ? '\n\n人生テーマメモリー：\n' + safeMemory.map(t =>
        typeof t === 'string' ? `・${t}` : `・${t.theme || ''}（重要度: ${t.strength || 1}）`
      ).filter(line => line !== '・').join('\n')
    : '';

  const userPrompt = currentText + memoryText;

  const systemInstruction = `あなたはFuture Meです。
ユーザーが積み重ねてきた記録全体から、その人らしい問いかけを返してください。

あなたは写真認識AIではありません。
写真の説明ではなく、ユーザーの記憶・感情・価値観を思い出すきっかけを作ってください。

以下のJSONのみを返してください。マークダウン・前置き・説明文は禁止。

{
  "comment": "80文字以内のコメント",
  "question": "30文字以内の深掘り質問"
}

【情報の優先順位】
質問・コメントを生成するとき、次の順で情報を重視してください。

① メモ（最優先）
② タグ
③ 場所
④ URL
⑤ 写真（補助情報）

写真（補助情報）は記録を補完するだけです。
メモ・タグ・場所・URLがある場合、写真だけを根拠に質問を作らないでください。
メモもタグも場所もURLもない場合にのみ、写真から問いを立ててよいです。

「主情報あり: はい」の場合、commentとquestionは必ずメモ・タグ・場所・URLのどれかを根拠にしてください。
「主情報あり: はい」の場合、写真の見た目だけに反応してはいけません。

【禁止】
・写真に写る人物の感情を断定しない
・メモにない限り「笑顔」「楽しそう」「幸せそう」などを使わない
・写真の見た目だけに反応しない
・「この写真は〜」で始めない
・写真説明で終わらせない
・診断しない
・説教しない
・ポエムにしない

commentの条件：
・80文字以内
・説教禁止・診断禁止・ポエム禁止
・人生テーマとのつながりが明確な場合のみ言及する
・無理な関連付けは禁止
・メモやタグがある場合、必ずそれに言及する
・場所やURLが重要な場合は、それも自然に含める

questionの条件：
・30文字以内
・質問は1つだけ
・「なぜ」より「どんな気持ち」を聞く
・答えやすい問いにする
・写真ではなく、記録の意味や感情をたずねる
・例：「その場の空気、どんな感じでしたか？」「また行きたいと思いましたか？」「今も大切にしたいテーマですか？」`;

  // ── Gemini API 呼び出し ───────────────────────────────────
  try {
    const ai = new GoogleGenAI({ apiKey });

    console.log('[future-me] prompt:', userPrompt);

    const { response, usedModel } = await tryGenerateContent(ai, MODELS_TO_TRY, {
      contents: userPrompt,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            comment:  { type: 'string' },
            question: { type: 'string' },
          },
          required: ['comment', 'question'],
        },
        maxOutputTokens: 200,
        temperature: 0.8,
      },
    });

    console.log(`[future-me] response.text (${usedModel}):`, response.text);

    let effectiveRaw = (response.text || '').trim();

    if (!effectiveRaw) {
      try {
        const parts = response?.candidates?.[0]?.content?.parts;
        if (parts && parts.length > 0) {
          effectiveRaw = parts.map(p => p.text || '').join('').trim();
        }
      } catch (e) {
        console.warn('[future-me] candidates access failed:', e.message);
      }
    }

    if (!effectiveRaw) {
      throw new Error('Empty response from Gemini');
    }

    let comment  = null;
    let question = null;
    try {
      const parsed = JSON.parse(effectiveRaw);
      comment  = parsed.comment;
      question = parsed.question;
    } catch {
      const cm = effectiveRaw.match(/"comment"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      const qm = effectiveRaw.match(/"question"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (cm) comment  = cm[1];
      if (qm) question = qm[1];
    }

    if (!comment || comment.trim() === '') {
      throw new Error('Empty comment from Gemini');
    }

    console.log('[future-me] Gemini success:', comment.trim(), '/', question);
    return res.status(200).json({
      comment:  comment.trim(),
      question: (question || '').trim() || null,
    });

  } catch (err) {
    const isQuota = /429|RESOURCE_EXHAUSTED|quota/i.test(err.message || '');
    console.warn(
      isQuota ? '[future-me] 429 quota → local fallback' : '[future-me] API error → local fallback:',
      err.message || err
    );

    return res.status(200).json({
      comment:  buildLocalComment(currentEntry),
      question: buildLocalQuestion(currentEntry),
    });
  }
}
