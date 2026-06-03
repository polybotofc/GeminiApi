// =========================================================
// 1. IMPOR MODUL DAN SETUP AWAL
// =========================================================
import 'dotenv/config';
import express from 'express';
import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';

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
function extractYoutubeId(url) {
  const regex = /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

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
// 4b. HELPER: INPUT SANITIZATION
// =========================================================
function sanitizeParam(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/[<>"'`${}\\]/g, '').trim().slice(0, maxLength);
}

function isValidDomainUrl(input, expectedDomain) {
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    return parsed.hostname === expectedDomain || parsed.hostname.endsWith('.' + expectedDomain);
  } catch {
    return false;
  }
}

// =========================================================
// 5. MIDDLEWARE DASAR
// =========================================================
app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.disable('x-powered-by');

// =========================================================
// 5b. RATE LIMITING
// =========================================================
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Terlalu banyak permintaan, coba lagi nanti.' }
});
app.use('/generate', apiLimiter);
app.use('/response', apiLimiter);
app.use('/tiktok', apiLimiter);
app.use('/ytmp3', apiLimiter);
app.use('/ytmp4', apiLimiter);

// =========================================================
// 5c. API KEY AUTHENTICATION
// =========================================================
const API_KEYS = new Set(
  (process.env.API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean)
);

function requireApiKey(req, res, next) {
  if (API_KEYS.size === 0) return next();

  const key = req.query.apikey || req.headers['x-api-key'];
  if (!key || !API_KEYS.has(key)) {
    return res.status(401).json({ status: 'error', message: 'API key tidak valid atau tidak diberikan.' });
  }
  next();
}

// =========================================================
// 6. CORS
// =========================================================
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin || '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// =========================================================
// 7. SERVE DASHBOARD HTML
// =========================================================
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// =========================================================
// 8. ENDPOINT: POST /generate
// =========================================================
app.post('/generate', requireApiKey, async (req, res) => {
  const { prompt } = req.body;

  if (!prompt) return res.status(400).json({ status: 'error', message: 'Parameter "prompt" diperlukan.' });
  if (prompt.length > 2000) return res.status(400).json({ status: 'error', message: 'Prompt terlalu panjang.' });

  try {
    const text = await generateAI(prompt);
    res.json({ status: 'success', generated_text: text });
  } catch (error) {
    console.error('Error POST /generate:', error);
    res.status(500).json({ status: 'error', message: 'Gagal memproses AI' });
  }
});

// =========================================================
// 9. ENDPOINT: GET /response
// =========================================================
app.get('/response', requireApiKey, async (req, res) => {
  const prompt = req.query.message;
  const userName = sanitizeParam(req.query.username, 50) || 'Pengguna';
  const customName = sanitizeParam(req.query.name, 50) || 'Poly';
  const customDesc = sanitizeParam(req.query.desc, 200) || 'asisten AI yang ramah, pintar, dan membantu';

  if (!prompt) return res.status(400).json({ status: 'error', message: 'Parameter "message" diperlukan.' });
  if (prompt.length > 2000) return res.status(400).json({ status: 'error', message: 'Pesan terlalu panjang.' });

  const systemPrompt = `Anda adalah ${customName}, seorang ${customDesc}.
Anda sedang berbicara dengan ${userName}.
Jawab dengan ramah dan singkat.`;

  try {
    const text = await generateAI(prompt, systemPrompt);
    res.json({ status: 'success', generated_text: text });
  } catch (error) {
    console.error('Error GET /response:', error);
    res.status(500).json({ status: 'error', message: 'Gagal memproses AI' });
  }
});

// =========================================================
// 10. ENDPOINT: GET /tiktok
// =========================================================
app.get('/tiktok', requireApiKey, async (req, res) => {
  const url = req.query.url;

  if (!url) return res.status(400).json({ status: 'error', message: 'Parameter "url" diperlukan.' });
  if (!isValidDomainUrl(url, 'tiktok.com')) return res.status(400).json({ status: 'error', message: 'URL harus TikTok' });

  try {
    const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`;
    const response = await fetch(apiUrl);
    const data = await response.json();

    if (data.code !== 0) return res.status(404).json({ status: 'error', message: 'Video tidak ditemukan' });

    res.json({
      status: 'success',
      result: {
        title: data.data.title,
        author: data.data.author.nickname,
        videoUrl: data.data.play,
        noWatermark: data.data.wmplay,
        audio: data.data.music,
        thumbnail: data.data.cover
      }
    });
  } catch (error) {
    console.error('Error GET /tiktok:', error);
    res.status(500).json({ status: 'error', message: 'Gagal mengambil video' });
  }
});

// =========================================================
// 11. ENDPOINT: GET /ytmp3
// =========================================================
app.get('/ytmp3', requireApiKey, async (req, res) => {
  const url = req.query.url;

  if (!url) return res.status(400).json({ status: 'error', message: 'Parameter "url" diperlukan.' });

  const isYT = isValidDomainUrl(url, 'youtube.com') || isValidDomainUrl(url, 'youtu.be');
  if (!isYT) return res.status(400).json({ status: 'error', message: 'URL harus YouTube.' });

  const videoId = extractYoutubeId(url);
  if (!videoId) return res.status(400).json({ status: 'error', message: 'Video ID tidak ditemukan.' });

  try {
    const result = await getYoutubeLinks(videoId, 'mp3');
    res.json({
      status: 'success',
      result: {
        title: result.title,
        thumbnail: result.thumbnail,
        quality: result.quality,
        size: result.size,
        audioUrl: result.downloadUrl
      }
    });
  } catch (error) {
    console.error('Error GET /ytmp3:', error);
    res.status(500).json({ status: 'error', message: 'Gagal mengambil audio YouTube.' });
  }
});

// =========================================================
// 12. ENDPOINT: GET /ytmp4
// =========================================================
app.get('/ytmp4', requireApiKey, async (req, res) => {
  const url = req.query.url;
  const quality = req.query.quality || '720p';

  if (!url) return res.status(400).json({ status: 'error', message: 'Parameter "url" diperlukan.' });

  const isYT = isValidDomainUrl(url, 'youtube.com') || isValidDomainUrl(url, 'youtu.be');
  if (!isYT) return res.status(400).json({ status: 'error', message: 'URL harus YouTube.' });

  const videoId = extractYoutubeId(url);
  if (!videoId) return res.status(400).json({ status: 'error', message: 'Video ID tidak ditemukan.' });

  try {
    const result = await getYoutubeLinks(videoId, 'mp4');
    res.json({
      status: 'success',
      result: {
        title: result.title,
        thumbnail: result.thumbnail,
        quality: result.quality,
        size: result.size,
        videoUrl: result.downloadUrl
      }
    });
  } catch (error) {
    console.error('Error GET /ytmp4:', error);
    res.status(500).json({ status: 'error', message: 'Gagal mengambil video YouTube.' });
  }
});

// =========================================================
// 13. 404 CATCH-ALL — semua route tidak dikenal → 404.html
// =========================================================
app.use((req, res, next) => {
  // Kalau request ke /api atau Accept: application/json → JSON error
  if (req.path.startsWith('/generate') ||
      req.path.startsWith('/response') ||
      req.path.startsWith('/tiktok') ||
      req.path.startsWith('/ytmp3') ||
      req.path.startsWith('/ytmp4') ||
      req.headers.accept?.includes('application/json')) {
    return res.status(404).json({ status: 'error', message: 'Endpoint tidak ditemukan.' });
  }
  // Semua route lain → serve 404.html dengan status 404
  res.status(404).sendFile(path.join(__dirname, '404.html'));
});

// =========================================================
// 13b. ERROR HANDLER
// =========================================================
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ status: 'error', message: 'Internal Server Error' });
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
