// =========================================================
// 1. IMPOR MODUL DAN SETUP AWAL
// =========================================================
import 'dotenv/config';
import express from 'express';
import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendSuccess, sendError } from './utils/response.js';
import { asyncHandler } from './utils/asyncHandler.js';
import { requireParam, maxLength, validateYouTubeUrl } from './utils/validators.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// =========================================================
// 2. AI SETUP
// =========================================================
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// =========================================================
// 3. HELPER: GENERATE AI DENGAN FALLBACK
// =========================================================
async function generateAI(prompt, systemPrompt = '') {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { systemInstruction: systemPrompt }
    });
    console.log('[AI] Gemini berhasil');
    return response.text;
  } catch (geminiError) {
    const isQuotaError = geminiError?.status === 429 ||
      geminiError?.message?.includes('quota') ||
      geminiError?.message?.includes('RESOURCE_EXHAUSTED');

    if (!isQuotaError) throw geminiError;

    console.warn('[AI] Gemini quota habis, fallback ke Groq...');

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    const groqRes = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages
    });

    console.log('[AI] Groq berhasil (fallback)');
    return groqRes.choices[0].message.content;
  }
}

// =========================================================
// 4. HELPER: YOUTUBE VIA Y2MATE API
// =========================================================
async function getYoutubeLinks(videoId, type = 'mp4') {
  // Step 1: Analyze
  const analyzeRes = await fetch('https://www.y2mate.com/mates/analyzeV2/ajax', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    body: new URLSearchParams({
      k_query: `https://www.youtube.com/watch?v=${videoId}`,
      k_page: 'home',
      hl: 'en',
      q_auto: '0'
    }),
    signal: AbortSignal.timeout(10000)
  });

  const analyzeData = await analyzeRes.json();
  if (!analyzeData?.vid) throw new Error('Gagal menganalisis video.');

  const vid = analyzeData.vid;

  // Pilih kualitas: untuk mp3 ambil 128kbps, mp4 ambil 720p atau fallback
  const links = analyzeData?.links?.[type];
  if (!links) throw new Error(`Format ${type} tidak tersedia.`);

  // Ambil key berdasarkan preferensi
  let chosenKey = null;
  let chosenData = null;

  if (type === 'mp3') {
    // Prefer 128kbps
    for (const [key, val] of Object.entries(links)) {
      if (val?.q?.includes('128') || !chosenKey) {
        chosenKey = key;
        chosenData = val;
      }
    }
  } else {
    // Prefer 720p, fallback ke tertinggi
    const preferred = ['720p', '480p', '360p', '1080p'];
    for (const q of preferred) {
      const found = Object.entries(links).find(([, v]) => v?.q === q);
      if (found) {
        chosenKey = found[0];
        chosenData = found[1];
        break;
      }
    }
    if (!chosenKey) {
      const first = Object.entries(links)[0];
      chosenKey = first[0];
      chosenData = first[1];
    }
  }

  if (!chosenKey) throw new Error('Tidak ada format yang cocok.');

  // Step 2: Convert
  const convertRes = await fetch('https://www.y2mate.com/mates/convertV2/index', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    body: new URLSearchParams({
      vid,
      k: chosenKey
    }),
    signal: AbortSignal.timeout(15000)
  });

  const convertData = await convertRes.json();
  if (!convertData?.dlink) throw new Error('Gagal mendapatkan link download.');

  return {
    title: analyzeData.title,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    quality: chosenData?.q || '',
    size: chosenData?.size || '',
    downloadUrl: convertData.dlink
  };
}

// =========================================================
// 5. MIDDLEWARE DASAR
// =========================================================
app.use(express.json({ limit: '1mb' }));
app.disable('x-powered-by');

// =========================================================
// 6. CORS
// =========================================================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// =========================================================
// 7. SERVE DASHBOARD HTML
// =========================================================
app.use(express.static(path.join(__dirname, '.')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// =========================================================
// 8. ENDPOINT: POST /generate
// =========================================================
app.post('/generate',
  requireParam('prompt', 'body'),
  maxLength('prompt', 2000, 'body'),
  asyncHandler('POST /generate', async (req, res) => {
    const text = await generateAI(req.body.prompt);
    sendSuccess(res, { generated_text: text });
  })
);

// =========================================================
// 9. ENDPOINT: GET /response
// =========================================================
app.get('/response',
  requireParam('message'),
  maxLength('message', 2000),
  asyncHandler('GET /response', async (req, res) => {
    const { message, username = 'Pengguna', name = 'Poly', desc = 'asisten AI yang ramah, pintar, dan membantu' } = req.query;

    const systemPrompt = `Anda adalah ${name}, seorang ${desc}.
Anda sedang berbicara dengan ${username}.
Jawab dengan ramah dan singkat.`;

    const text = await generateAI(message, systemPrompt);
    sendSuccess(res, { generated_text: text });
  })
);

// =========================================================
// 10. ENDPOINT: GET /tiktok
// =========================================================
app.get('/tiktok',
  requireParam('url'),
  asyncHandler('GET /tiktok', async (req, res) => {
    const { url } = req.query;
    if (!url.includes('tiktok.com')) return sendError(res, 400, 'URL harus TikTok');

    const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`;
    const response = await fetch(apiUrl);
    const data = await response.json();

    if (data.code !== 0) return sendError(res, 404, 'Video tidak ditemukan');

    sendSuccess(res, {
      result: {
        title: data.data.title,
        author: data.data.author.nickname,
        videoUrl: data.data.play,
        noWatermark: data.data.wmplay,
        audio: data.data.music,
        thumbnail: data.data.cover
      }
    });
  })
);

// =========================================================
// 11. ENDPOINT: GET /ytmp3
// =========================================================
app.get('/ytmp3',
  validateYouTubeUrl(),
  asyncHandler('GET /ytmp3', async (req, res) => {
    const result = await getYoutubeLinks(req.videoId, 'mp3');
    sendSuccess(res, {
      result: {
        title: result.title,
        thumbnail: result.thumbnail,
        quality: result.quality,
        size: result.size,
        audioUrl: result.downloadUrl
      }
    });
  })
);

// =========================================================
// 12. ENDPOINT: GET /ytmp4
// =========================================================
app.get('/ytmp4',
  validateYouTubeUrl(),
  asyncHandler('GET /ytmp4', async (req, res) => {
    const result = await getYoutubeLinks(req.videoId, 'mp4');
    sendSuccess(res, {
      result: {
        title: result.title,
        thumbnail: result.thumbnail,
        quality: result.quality,
        size: result.size,
        videoUrl: result.downloadUrl
      }
    });
  })
);

// =========================================================
// 13. 404 CATCH-ALL — semua route tidak dikenal → 404.html
// =========================================================
const API_PATHS = ['/generate', '/response', '/tiktok', '/ytmp3', '/ytmp4'];

app.use((req, res, next) => {
  const isApiRequest = API_PATHS.some(p => req.path.startsWith(p)) ||
    req.headers.accept?.includes('application/json');

  if (isApiRequest) return sendError(res, 404, 'Endpoint tidak ditemukan.');
  res.status(404).sendFile(path.join(__dirname, '404.html'));
});

// =========================================================
// 13b. ERROR HANDLER
// =========================================================
app.use((err, req, res, _next) => {
  console.error(err);
  sendError(res, 500, 'Internal Server Error');
});
// =========================================================
// 14. START SERVER (LOCAL)
// =========================================================
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`Server berjalan di port ${PORT}`));
}

// =========================================================
// 15. EXPORT UNTUK VERCEL
// =========================================================
export default app;
