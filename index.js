// =========================================================
// 1. IMPOR MODUL DAN SETUP AWAL
// =========================================================
import 'dotenv/config';
import express from 'express';
import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
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
// 4. HELPER: YOUTUBE VIA COBALT API
// =========================================================
async function getYoutubeCobalt(url, isAudioOnly = false, quality = '720') {
  const response = await fetch('https://api.cobalt.tools/api/json', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      url,
      vQuality: quality,
      isAudioOnly
    })
  });

  if (!response.ok) throw new Error(`Cobalt API error: ${response.status}`);

  const data = await response.json();
  if (data.status === 'error') throw new Error(data.text || 'Cobalt gagal memproses.');

  return data;
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
app.post('/generate', async (req, res) => {
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
app.get('/response', async (req, res) => {
  const prompt = req.query.message;
  const userName = req.query.username || 'Pengguna';
  const customName = req.query.name || 'Poly';
  const customDesc = req.query.desc || 'asisten AI yang ramah, pintar, dan membantu';

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
app.get('/tiktok', async (req, res) => {
  const url = req.query.url;

  if (!url) return res.status(400).json({ status: 'error', message: 'Parameter "url" diperlukan.' });
  if (!url.includes('tiktok.com')) return res.status(400).json({ status: 'error', message: 'URL harus TikTok' });

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
app.get('/ytmp3', async (req, res) => {
  const url = req.query.url;

  if (!url) return res.status(400).json({ status: 'error', message: 'Parameter "url" diperlukan.' });

  const isYT = url.includes('youtube.com') || url.includes('youtu.be');
  if (!isYT) return res.status(400).json({ status: 'error', message: 'URL harus YouTube.' });

  try {
    const data = await getYoutubeCobalt(url, true);

    res.json({
      status: 'success',
      result: {
        audioUrl: data.url,
        filename: data.filename || 'audio.mp3'
      }
    });
  } catch (error) {
    console.error('Error GET /ytmp3:', error);
    res.status(500).json({ status: 'error', message: error.message || 'Gagal mengambil audio YouTube.' });
  }
});

// =========================================================
// 12. ENDPOINT: GET /ytmp4
// =========================================================
app.get('/ytmp4', async (req, res) => {
  const url = req.query.url;
  const quality = req.query.quality || '720';

  if (!url) return res.status(400).json({ status: 'error', message: 'Parameter "url" diperlukan.' });

  const isYT = url.includes('youtube.com') || url.includes('youtu.be');
  if (!isYT) return res.status(400).json({ status: 'error', message: 'URL harus YouTube.' });

  try {
    const data = await getYoutubeCobalt(url, false, quality);

    res.json({
      status: 'success',
      result: {
        videoUrl: data.url,
        filename: data.filename || 'video.mp4',
        quality: quality + 'p'
      }
    });
  } catch (error) {
    console.error('Error GET /ytmp4:', error);
    res.status(500).json({ status: 'error', message: error.message || 'Gagal mengambil video YouTube.' });
  }
});

// =========================================================
// 13. HANDLE ERROR
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
