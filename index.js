// =========================================================
// 1. IMPOR MODUL DAN SETUP AWAL
// =========================================================
import 'dotenv/config';
import express from 'express';
import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

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
// 4B. CHARACTER.AI (CAINode) SETUP & HELPER
// =========================================================
// Token didapat dari env CHARACTER_AI_TOKEN. Kalau belum diisi, endpoint /cai/*
// akan otomatis menolak dengan pesan error yang jelas, endpoint lain tidak terpengaruh.

const CAI_SESSIONS_FILE = path.join('/tmp', 'cai_sessions.json');

// Penyimpanan session: sessionId -> { charId, chatId, createdAt }
// Dipakai in-memory untuk kecepatan, dan dibackup ke /tmp supaya tetap ada
// selama instance server yang sama masih hidup (termasuk di lingkungan serverless).
let caiSessions = {};

function loadCaiSessions() {
  try {
    caiSessions = JSON.parse(fs.readFileSync(CAI_SESSIONS_FILE, 'utf-8'));
  } catch {
    caiSessions = {};
  }
  return caiSessions;
}

function saveCaiSessions() {
  try {
    fs.writeFileSync(CAI_SESSIONS_FILE, JSON.stringify(caiSessions, null, 2));
  } catch (err) {
    console.error('Gagal menyimpan cai_sessions.json:', err.message);
  }
}

loadCaiSessions();

let caiClient = null;
let caiClientPromise = null;
let caiQueue = Promise.resolve();
let connectedCharId = null;

function caiRunQueued(fn) {
  const run = caiQueue.then(fn, fn);
  caiQueue = run.then(() => {}, () => {});
  return run;
}

async function ensureCaiClient() {
  if (!process.env.CHARACTER_AI_TOKEN) {
    throw new Error('CHARACTER_AI_TOKEN belum diatur di environment variable.');
  }
  if (caiClient) return caiClient;
  if (!caiClientPromise) {
    caiClientPromise = (async () => {
      const { CAINode } = await import('cainode');
      const client = new CAINode();
      await client.login(process.env.CHARACTER_AI_TOKEN);
      caiClient = client;
      return client;
    })().catch(err => {
      caiClientPromise = null;
      throw err;
    });
  }
  return caiClientPromise;
}

// Menghubungkan client ke karakter tertentu (single chat, bukan group chat).
// Kalau sedang terhubung ke karakter lain, akan disconnect dulu.
async function caiEnsureConnected(charId) {
  const client = await ensureCaiClient();
  return caiRunQueued(async () => {
    if (connectedCharId === charId) return null;

    if (connectedCharId !== null) {
      try {
        await client.character.disconnect();
      } catch (e) {
        // abaikan kalau ternyata sudah disconnect di sisi lib
      }
      connectedCharId = null;
    }

    let res;
    try {
      res = await client.character.connect(charId);
    } catch (err) {
      if (String(err).includes('already connectetd') || String(err).includes('already connected')) {
        try { await client.character.disconnect(); } catch (e) {}
        res = await client.character.connect(charId);
      } else {
        throw err;
      }
    }

    connectedCharId = charId;
    return res;
  });
}

async function caiSendMessage({ charId, chatId, message }) {
  const client = await ensureCaiClient();
  return caiRunQueued(() =>
    client.character.send_message(message, false, '', {
      char_id: charId,
      chat_id: chatId
    })
  );
}

function extractCaiReply(response) {
  return response?.turn?.candidates?.[0]?.raw_content || null;
}

function getCaiSession(sessionId) {
  const session = caiSessions[sessionId];
  if (!session) {
    const err = new Error('Session tidak ditemukan. Buat session baru lewat POST /cai/session.');
    err.statusCode = 404;
    throw err;
  }
  return session;
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
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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
    res.status(500).json({ status: 'error', message: error.message || 'Gagal mengambil audio YouTube.' });
  }
});

// =========================================================
// 12. ENDPOINT: GET /ytmp4
// =========================================================
app.get('/ytmp4', async (req, res) => {
  const url = req.query.url;
  const quality = req.query.quality || '720p';

  if (!url) return res.status(400).json({ status: 'error', message: 'Parameter "url" diperlukan.' });

  const isYT = url.includes('youtube.com') || url.includes('youtu.be');
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
    res.status(500).json({ status: 'error', message: error.message || 'Gagal mengambil video YouTube.' });
  }
});

// =========================================================
// 12B. ENDPOINT: CHARACTER.AI (CAI)
//   GET    /cai/search              -> cari karakter
//   GET    /cai/character/:charId   -> detail karakter
//   POST   /cai/session             -> buat session/chat baru dengan karakter
//   GET    /cai/session/:id         -> lihat detail session
//   GET    /cai/session/:id/history -> riwayat chat session
//   POST   /cai/session/:id/chat    -> kirim pesan ke karakter dalam session ini
//   DELETE /cai/session/:id         -> hapus session
// =========================================================

// --- Cari karakter berdasarkan nama/kata kunci ---
app.get('/cai/search', async (req, res) => {
  const q = req.query.q;
  const sort = req.query.sort || 'search_score';

  if (!q) return res.status(400).json({ status: 'error', message: 'Parameter "q" diperlukan.' });

  try {
    const client = await ensureCaiClient();
    const results = await client.search.characters(q, sort);
    res.json({ status: 'success', result: results });
  } catch (error) {
    console.error('Error GET /cai/search:', error);
    res.status(500).json({ status: 'error', message: error.message || 'Gagal mencari karakter.' });
  }
});

// --- Detail informasi sebuah karakter ---
app.get('/cai/character/:charId', async (req, res) => {
  const { charId } = req.params;

  try {
    const client = await ensureCaiClient();
    const info = await client.character.info(charId);
    res.json({ status: 'success', result: info });
  } catch (error) {
    console.error('Error GET /cai/character/:charId:', error);
    res.status(500).json({ status: 'error', message: error.message || 'Gagal mengambil detail karakter.' });
  }
});

// --- Membuat session/chat baru dengan sebuah karakter ---
// Body: { "charId": "xxxx", "newConversation": false }
// newConversation=true akan memulai obrolan baru (riwayat lama disimpan di history character.ai),
// defaultnya melanjutkan chat terakhir dengan karakter tersebut.
app.post('/cai/session', async (req, res) => {
  const { charId, newConversation } = req.body || {};

  if (!charId) return res.status(400).json({ status: 'error', message: 'Parameter "charId" diperlukan.' });

  try {
    const connectRes = await caiEnsureConnected(charId);

    let chatId = connectRes?.chats?.[0]?.chat_id;
    let greeting = null;

    if (newConversation || !chatId) {
      const convo = await caiRunQueued(() =>
        (async () => {
          const client = await ensureCaiClient();
          return client.character.create_new_conversation(true);
        })()
      );
      chatId = convo?.chats?.[0]?.chat_id || convo?.chat_id || chatId;
      greeting = extractCaiReply(convo) || convo?.turn ? extractCaiReply(convo) : null;
    }

    if (!chatId) {
      return res.status(500).json({ status: 'error', message: 'Gagal mendapatkan chat_id dari karakter.' });
    }

    const sessionId = randomUUID();
    caiSessions[sessionId] = { charId, chatId, createdAt: new Date().toISOString() };
    saveCaiSessions();

    res.json({
      status: 'success',
      result: {
        sessionId,
        charId,
        chatId,
        greeting
      }
    });
  } catch (error) {
    console.error('Error POST /cai/session:', error);
    res.status(500).json({ status: 'error', message: error.message || 'Gagal membuat session.' });
  }
});

// --- Detail sebuah session ---
app.get('/cai/session/:id', (req, res) => {
  try {
    const session = getCaiSession(req.params.id);
    res.json({ status: 'success', result: { sessionId: req.params.id, ...session } });
  } catch (error) {
    res.status(error.statusCode || 500).json({ status: 'error', message: error.message });
  }
});

// --- Riwayat chat dari sebuah session ---
app.get('/cai/session/:id/history', async (req, res) => {
  try {
    const session = getCaiSession(req.params.id);
    const client = await ensureCaiClient();
    const history = await client.chat.history_chat_turns(session.chatId);
    res.json({ status: 'success', result: history });
  } catch (error) {
    console.error('Error GET /cai/session/:id/history:', error);
    res.status(error.statusCode || 500).json({ status: 'error', message: error.message || 'Gagal mengambil riwayat chat.' });
  }
});

// --- Mengirim pesan ke karakter di dalam sebuah session ---
// Body: { "message": "halo!" }
app.post('/cai/session/:id/chat', async (req, res) => {
  const { message } = req.body || {};
  const { id } = req.params;

  if (!message) return res.status(400).json({ status: 'error', message: 'Parameter "message" diperlukan.' });

  try {
    const session = getCaiSession(id);

    await caiEnsureConnected(session.charId);

    const response = await caiSendMessage({
      charId: session.charId,
      chatId: session.chatId,
      message
    });

    const reply = extractCaiReply(response);

    if (!reply) {
      return res.status(502).json({ status: 'error', message: 'Karakter tidak memberikan balasan, coba lagi.' });
    }

    res.json({
      status: 'success',
      result: {
        sessionId: id,
        reply,
        turnId: response?.turn?.turn_id || null,
        candidateId: response?.turn?.candidates?.[0]?.candidate_id || null
      }
    });
  } catch (error) {
    console.error('Error POST /cai/session/:id/chat:', error);
    res.status(error.statusCode || 500).json({ status: 'error', message: error.message || 'Gagal mengirim pesan ke karakter.' });
  }
});

// --- Menghapus sebuah session (hanya menghapus data lokal, tidak menghapus chat di character.ai) ---
app.delete('/cai/session/:id', (req, res) => {
  const { id } = req.params;

  if (!caiSessions[id]) {
    return res.status(404).json({ status: 'error', message: 'Session tidak ditemukan.' });
  }

  delete caiSessions[id];
  saveCaiSessions();

  res.json({ status: 'success', message: 'Session berhasil dihapus.' });
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
      req.path.startsWith('/cai') ||
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
