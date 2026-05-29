// =========================================================
// 1. IMPOR MODUL DAN SETUP AWAL
// =========================================================
import 'dotenv/config';
import express from 'express';
import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import ytdl from '@distube/ytdl-core';
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
// 4. MIDDLEWARE DASAR
// =========================================================
app.use(express.json({ limit: '1mb' }));
app.disable('x-powered-by');

// =========================================================
// 5. CORS
// =========================================================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// =========================================================
// 6. SERVE DASHBOARD HTML
// =========================================================
app.use(express.static(path.join(__dirname, '.')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// =========================================================
// 7. ENDPOINT: POST /generate
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
// 8. ENDPOINT: GET /response
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
// 9. ENDPOINT: GET /tiktok
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
// 10. ENDPOINT: GET /ytmp3
// =========================================================
app.get('/ytmp3', async (req, res) => {
  const url = req.query.url;

  if (!url) return res.status(400).json({ status: 'error', message: 'Parameter "url" diperlukan.' });

  const isYT = url.includes('youtube.com') || url.includes('youtu.be');
  if (!isYT) return res.status(400).json({ status: 'error', message: 'URL harus YouTube.' });

  try {
    const info = await ytdl.getInfo(url);
    const videoDetails = info.videoDetails;

    const audioFormat = ytdl.chooseFormat(info.formats, {
      quality: 'highestaudio',
      filter: 'audioonly'
    });

    if (!audioFormat) return res.status(404).json({ status: 'error', message: 'Format audio tidak ditemukan.' });

    res.json({
      status: 'success',
      result: {
        title: videoDetails.title,
        author: videoDetails.author.name,
        duration: videoDetails.lengthSeconds,
        thumbnail: videoDetails.thumbnails.at(-1)?.url,
        audioUrl: audioFormat.url,
        mimeType: audioFormat.mimeType,
        bitrate: audioFormat.averageBitrate
      }
    });
  } catch (error) {
    console.error('Error GET /ytmp3:', error);
    res.status(500).json({ status: 'error', message: 'Gagal mengambil audio YouTube.' });
  }
});

// =========================================================
// 11. ENDPOINT: GET /ytmp4
// =========================================================
app.get('/ytmp4', async (req, res) => {
  const url = req.query.url;
  const quality = req.query.quality || '720p';

  if (!url) return res.status(400).json({ status: 'error', message: 'Parameter "url" diperlukan.' });

  const isYT = url.includes('youtube.com') || url.includes('youtu.be');
  if (!isYT) return res.status(400).json({ status: 'error', message: 'URL harus YouTube.' });

  try {
    const info = await ytdl.getInfo(url);
    const videoDetails = info.videoDetails;

    let videoFormat = ytdl.chooseFormat(info.formats, {
      filter: format =>
        format.hasVideo &&
        format.hasAudio &&
        format.qualityLabel === quality
    });

    if (!videoFormat) {
      videoFormat = ytdl.chooseFormat(info.formats, {
        filter: format => format.hasVideo && format.hasAudio
      });
    }

    if (!videoFormat) return res.status(404).json({ status: 'error', message: 'Format video tidak ditemukan.' });

    res.json({
      status: 'success',
      result: {
        title: videoDetails.title,
        author: videoDetails.author.name,
        duration: videoDetails.lengthSeconds,
        thumbnail: videoDetails.thumbnails.at(-1)?.url,
        videoUrl: videoFormat.url,
        quality: videoFormat.qualityLabel,
        mimeType: videoFormat.mimeType,
        fps: videoFormat.fps
      }
    });
  } catch (error) {
    console.error('Error GET /ytmp4:', error);
    res.status(500).json({ status: 'error', message: 'Gagal mengambil video YouTube.' });
  }
});

// =========================================================
// 12. HANDLE ERROR
// =========================================================
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ status: 'error', message: 'Internal Server Error' });
});

// =========================================================
// 13. START SERVER (LOCAL)
// =========================================================
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`Server berjalan di port ${PORT}`));
}

// =========================================================
// 14. EXPORT UNTUK VERCEL
// =========================================================
export default app;
