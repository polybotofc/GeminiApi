// =========================================================//
// 1. IMPOR MODUL DAN SETUP AWAL
// =========================================================
import 'dotenv/config';
import express from 'express';
import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import dns from 'dns/promises';
import os from 'os';
import tls from 'tls';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';
import QRCode from 'qrcode';
import sharp from 'sharp';
import exifr from 'exifr';

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
// FIX: sebelumnya hanya fallback ke Groq kalau error dianggap "quota habis"
// (status 429 / pesan mengandung "quota"/"RESOURCE_EXHAUSTED"). Padahal error
// "API key not valid" (INVALID_ARGUMENT / API_KEY_INVALID, status 400) itu
// TIDAK ketangkep kondisi isQuotaError, jadi langsung throw dan bikin semua
// endpoint /generate, /ai/summarize, /ai/translate, dll ikut down walaupun
// Groq-nya sendiri sehat. Sekarang: kalau Gemini gagal karena alasan APAPUN
// (quota habis, key invalid, model error, dsb) -> coba Groq sebagai fallback.
// Kalau Groq juga gagal, baru lempar error Gemini yang asli.
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
    const reason =
      geminiError?.status === 429 || geminiError?.message?.includes('quota') || geminiError?.message?.includes('RESOURCE_EXHAUSTED')
        ? 'quota habis'
        : geminiError?.message?.includes('API_KEY_INVALID') || geminiError?.message?.includes('API key not valid')
        ? 'API key Gemini tidak valid (cek env var GEMINI_API_KEY di Vercel)'
        : 'error tidak dikenal';

    console.warn(`[AI] Gemini gagal (${reason}), fallback ke Groq...`);

    if (!process.env.GROQ_API_KEY) {
      // Tidak ada fallback yang bisa dipakai, lempar error Gemini asli supaya pesannya jelas.
      throw geminiError;
    }

    try {
      const messages = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
      messages.push({ role: 'user', content: prompt });

      const groqRes = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages
      });

      console.log('[AI] Groq berhasil (fallback)');
      return groqRes.choices[0].message.content;
    } catch (groqError) {
      console.error('[AI] Groq fallback juga gagal:', groqError?.message);
      // Lempar error Gemini asli (lebih informatif soal root cause: quota vs key invalid)
      throw geminiError;
    }
  }
}

// Helper: minta AI membalas HANYA dengan JSON valid, lalu parse.
async function generateAIJson(prompt, systemPrompt = '') {
  const sys = `${systemPrompt}\nPENTING: Balas HANYA dengan JSON valid, tanpa markdown, tanpa backtick, tanpa penjelasan tambahan.`;
  const raw = await generateAI(prompt, sys);
  const clean = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    return { raw: clean };
  }
}

// =========================================================
// 4. HELPER: FETCH DENGAN TIMEOUT & USER-AGENT DEFAULT
// =========================================================
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const headers = { 'User-Agent': DEFAULT_UA, ...(options.headers || {}) };
  return fetch(url, { ...options, headers, signal: AbortSignal.timeout(timeoutMs) });
}

async function fetchJson(url, options = {}, timeoutMs = 12000) {
  const res = await fetchWithTimeout(url, options, timeoutMs);
  if (!res.ok) throw new Error(`Request gagal (HTTP ${res.status})`);
  return res.json();
}

async function scrapeMeta(url) {
  const res = await fetchWithTimeout(url, {}, 15000);
  const html = await res.text();
  const $ = cheerio.load(html);
  const get = (sel, attr = 'content') => $(sel).attr(attr) || null;
  return {
    title: get('meta[property="og:title"]') || $('title').first().text() || null,
    description: get('meta[property="og:description"]') || get('meta[name="description"]') || null,
    image: get('meta[property="og:image"]') || null,
    video: get('meta[property="og:video"]') || get('meta[property="og:video:url"]') || get('meta[property="og:video:secure_url"]') || null,
    siteName: get('meta[property="og:site_name"]') || null,
    type: get('meta[property="og:type"]') || null,
    url: get('meta[property="og:url"]') || url,
    finalUrl: res.url,
    html
  };
}

// =========================================================
// 4B. HELPER: YOUTUBE VIA COBALT API
// =========================================================
// FIX: y2mate.com DITUTUP PERMANEN sejak Oktober 2025 (tindakan hukum IFPI),
// domainnya sudah tidak resolve sama sekali -> ENOTFOUND. Endpoint /ytmp3 dan
// /ytmp4 lama TIDAK BISA diperbaiki dengan tetap memakai y2mate, harus ganti
// provider. Diganti ke Cobalt (https://github.com/imputnet/cobalt), open-source
// media downloader yang masih aktif dikembangkan.
//
// PENTING: instance publik api.cobalt.tools memblokir YouTube dan pakai bot
// protection, jadi TIDAK BISA dipakai langsung dari server lain (termasuk kamu).
// Kamu WAJIB self-host instance Cobalt sendiri (gratis, 1-click deploy di
// Railway/Render/VPS/Docker: https://github.com/imputnet/cobalt) lalu set env
// var COBALT_API_URL ke domain instance kamu, contoh:
//   COBALT_API_URL=https://cobalt-punya-saya.up.railway.app
function extractYoutubeId(url) {
  const regex = /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

async function getYoutubeLinks(videoUrl, type = 'mp4') {
  const cobaltBase = process.env.COBALT_API_URL;
  if (!cobaltBase) {
    throw new Error(
      'COBALT_API_URL belum diset. y2mate sudah tutup permanen sejak Okt 2025, kamu perlu self-host Cobalt (https://github.com/imputnet/cobalt) lalu set env var COBALT_API_URL.'
    );
  }

  const body = {
    url: videoUrl,
    downloadMode: type === 'mp3' ? 'audio' : 'auto',
    videoQuality: '720',
    audioFormat: 'mp3'
  };

  const res = await fetchWithTimeout(
    cobaltBase.replace(/\/$/, '') + '/',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(process.env.COBALT_API_KEY ? { Authorization: `Api-Key ${process.env.COBALT_API_KEY}` } : {})
      },
      body: JSON.stringify(body)
    },
    20000
  );

  const data = await res.json();

  if (data.status === 'error') {
    throw new Error(data?.error?.code || 'Gagal memproses video lewat Cobalt.');
  }

  // Cobalt bisa balas beberapa bentuk: "redirect"/"tunnel" (langsung ada url),
  // atau "picker" (banyak pilihan kualitas/format).
  let downloadUrl = data.url || null;
  let pickedLabel = data.filename || null;

  if (!downloadUrl && Array.isArray(data.picker) && data.picker.length > 0) {
    const pick = data.picker.find(p => p.type === (type === 'mp3' ? 'audio' : 'video')) || data.picker[0];
    downloadUrl = pick?.url || null;
    pickedLabel = pick?.type || pickedLabel;
  }

  if (!downloadUrl) {
    throw new Error('Cobalt tidak mengembalikan link download yang valid.');
  }

  return {
    title: data.filename || null,
    quality: pickedLabel || '',
    downloadUrl
  };
}

// =========================================================
// 4C. CHARACTER.AI (CAINode) SETUP & HELPER
// =========================================================
const CAI_SESSIONS_FILE = path.join('/tmp', 'cai_sessions.json');

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

async function caiEnsureConnected(charId) {
  const client = await ensureCaiClient();
  return caiRunQueued(async () => {
    if (connectedCharId === charId) return null;

    if (connectedCharId !== null) {
      try {
        await client.character.disconnect();
      } catch (e) {}
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
app.use(express.json({ limit: '5mb' }));
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
// 6B. STATISTIK REQUEST (untuk endpoint SYSTEM & API)
// =========================================================
const stats = {
  startTime: Date.now(),
  totalRequests: 0,
  errors: 0,
  byEndpoint: {},   // "GET /tiktok" -> count
  byMethod: {}      // "GET" -> count
};

app.use((req, res, next) => {
  stats.totalRequests += 1;
  const key = `${req.method} ${req.path}`;
  stats.byEndpoint[key] = (stats.byEndpoint[key] || 0) + 1;
  stats.byMethod[req.method] = (stats.byMethod[req.method] || 0) + 1;
  res.on('finish', () => {
    if (res.statusCode >= 400) stats.errors += 1;
  });
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
// 8. ARTIFICIAL INTELLIGENCE
// =========================================================

// --- POST /generate (sudah ada) ---
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

// --- GET /response (sudah ada) ---
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

// --- GET /ai/image — AI Image Generator (via Pollinations, gratis tanpa API key) ---
app.get('/ai/image', async (req, res) => {
  const prompt = req.query.prompt;
  const width = parseInt(req.query.width) || 1024;
  const height = parseInt(req.query.height) || 1024;

  if (!prompt) return res.status(400).json({ status: 'error', message: 'Parameter "prompt" diperlukan.' });

  try {
    const seed = Math.floor(Math.random() * 1_000_000);
    const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&seed=${seed}&nologo=true`;
    // Pastikan gambar benar-benar bisa diakses sebelum dikembalikan
    const check = await fetchWithTimeout(imageUrl, {}, 30000);
    if (!check.ok) throw new Error('Layanan generator gambar sedang tidak merespons.');

    res.json({ status: 'success', result: { prompt, width, height, imageUrl } });
  } catch (error) {
    console.error('Error GET /ai/image:', error);
    res.status(500).json({ status: 'error', message: error.message || 'Gagal membuat gambar.' });
  }
});

// --- POST /ai/summarize — AI Summarizer ---
app.post('/ai/summarize', async (req, res) => {
  const { text, length } = req.body || {};
  if (!text) return res.status(400).json({ status: 'error', message: 'Parameter "text" diperlukan.' });

  const style = length === 'short' ? '2-3 kalimat singkat' : length === 'long' ? 'ringkasan lengkap beberapa paragraf' : '1 paragraf padat';

  try {
    const summary = await generateAI(
      `Ringkas teks berikut menjadi ${style}, pertahankan informasi inti:\n\n${text}`,
      'Anda adalah alat peringkas teks yang akurat dan netral.'
    );
    res.json({ status: 'success', result: { summary } });
  } catch (error) {
    console.error('Error POST /ai/summarize:', error);
    res.status(500).json({ status: 'error', message: 'Gagal meringkas teks.' });
  }
});

// --- POST /ai/translate — AI Translator ---
app.post('/ai/translate', async (req, res) => {
  const { text, target, source } = req.body || {};
  if (!text || !target) return res.status(400).json({ status: 'error', message: 'Parameter "text" dan "target" diperlukan.' });

  try {
    const translated = await generateAI(
      `Terjemahkan teks berikut${source ? ` dari bahasa ${source}` : ''} ke bahasa ${target}. Balas HANYA dengan hasil terjemahan, tanpa embel-embel:\n\n${text}`,
      'Anda adalah mesin penerjemah profesional.'
    );
    res.json({ status: 'success', result: { translated: translated.trim(), target, source: source || 'auto' } });
  } catch (error) {
    console.error('Error POST /ai/translate:', error);
    res.status(500).json({ status: 'error', message: 'Gagal menerjemahkan teks.' });
  }
});

// --- POST /ai/detect-language — AI Language Detector ---
app.post('/ai/detect-language', async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ status: 'error', message: 'Parameter "text" diperlukan.' });

  try {
    const result = await generateAIJson(
      `Deteksi bahasa dari teks berikut:\n\n${text}\n\nBalas dengan JSON: {"language": "<nama bahasa>", "code": "<kode ISO 639-1>", "confidence": <0-1>}`,
      'Anda adalah alat pendeteksi bahasa yang akurat.'
    );
    res.json({ status: 'success', result });
  } catch (error) {
    console.error('Error POST /ai/detect-language:', error);
    res.status(500).json({ status: 'error', message: 'Gagal mendeteksi bahasa.' });
  }
});

// --- POST /ai/rewrite — AI Text Rewriter ---
app.post('/ai/rewrite', async (req, res) => {
  const { text, style } = req.body || {};
  if (!text) return res.status(400).json({ status: 'error', message: 'Parameter "text" diperlukan.' });

  const gaya = style || 'lebih jelas dan enak dibaca, makna tetap sama';

  try {
    const rewritten = await generateAI(
      `Tulis ulang teks berikut dengan gaya: ${gaya}. Balas HANYA teks hasil tulis ulang:\n\n${text}`,
      'Anda adalah alat penulis ulang teks yang mahir.'
    );
    res.json({ status: 'success', result: { rewritten: rewritten.trim(), style: gaya } });
  } catch (error) {
    console.error('Error POST /ai/rewrite:', error);
    res.status(500).json({ status: 'error', message: 'Gagal menulis ulang teks.' });
  }
});

// --- POST /ai/prompt-generator — AI Prompt Generator ---
app.post('/ai/prompt-generator', async (req, res) => {
  const { topic, type } = req.body || {};
  if (!topic) return res.status(400).json({ status: 'error', message: 'Parameter "topic" diperlukan.' });

  const jenis = type || 'gambar AI (text-to-image)';

  try {
    const result = await generateAIJson(
      `Buatkan 3 variasi prompt kreatif dan detail untuk keperluan "${jenis}" dengan topik: "${topic}".
Balas dengan JSON: {"prompts": ["...", "...", "..."]}`,
      'Anda adalah ahli prompt engineering yang kreatif.'
    );
    res.json({ status: 'success', result });
  } catch (error) {
    console.error('Error POST /ai/prompt-generator:', error);
    res.status(500).json({ status: 'error', message: 'Gagal membuat prompt.' });
  }
});

// =========================================================
// 9. MEDIA DOWNLOADER
// =========================================================

// --- GET /tiktok (sudah ada) ---
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

// --- GET /ytmp3 (FIXED: pakai Cobalt, bukan y2mate yang sudah tutup) ---
app.get('/ytmp3', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ status: 'error', message: 'Parameter "url" diperlukan.' });

  const isYT = url.includes('youtube.com') || url.includes('youtu.be');
  if (!isYT) return res.status(400).json({ status: 'error', message: 'URL harus YouTube.' });

  const videoId = extractYoutubeId(url);
  if (!videoId) return res.status(400).json({ status: 'error', message: 'Video ID tidak ditemukan.' });

  try {
    const result = await getYoutubeLinks(url, 'mp3');
    res.json({
      status: 'success',
      result: {
        title: result.title,
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        quality: result.quality,
        audioUrl: result.downloadUrl
      }
    });
  } catch (error) {
    console.error('Error GET /ytmp3:', error);
    res.status(500).json({ status: 'error', message: error.message || 'Gagal mengambil audio YouTube.' });
  }
});

// --- GET /ytmp4 (FIXED: pakai Cobalt, bukan y2mate yang sudah tutup) ---
app.get('/ytmp4', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ status: 'error', message: 'Parameter "url" diperlukan.' });

  const isYT = url.includes('youtube.com') || url.includes('youtu.be');
  if (!isYT) return res.status(400).json({ status: 'error', message: 'URL harus YouTube.' });

  const videoId = extractYoutubeId(url);
  if (!videoId) return res.status(400).json({ status: 'error', message: 'Video ID tidak ditemukan.' });

  try {
    const result = await getYoutubeLinks(url, 'mp4');
    res.json({
      status: 'success',
      result: {
        title: result.title,
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        quality: result.quality,
        videoUrl: result.downloadUrl
      }
    });
  } catch (error) {
    console.error('Error GET /ytmp4:', error);
    res.status(500).json({ status: 'error', message: error.message || 'Gagal mengambil video YouTube.' });
  }
});

// --- GET /youtube/info — YouTube Video Info (via oEmbed resmi, sangat stabil) ---
app.get('/youtube/info', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ status: 'error', message: 'Parameter "url" diperlukan.' });

  const videoId = extractYoutubeId(url);
  if (!videoId) return res.status(400).json({ status: 'error', message: 'Video ID tidak ditemukan.' });

  try {
    const oembed = await fetchJson(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`);
    res.json({
      status: 'success',
      result: {
        videoId,
        title: oembed.title,
        author: oembed.author_name,
        authorUrl: oembed.author_url,
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        embedHtml: oembed.html,
        watchUrl: `https://www.youtube.com/watch?v=${videoId}`
      }
    });
  } catch (error) {
    console.error('Error GET /youtube/info:', error);
    res.status(500).json({ status: 'error', message: 'Gagal mengambil info video (mungkin video privat/dihapus).' });
  }
});

// --- GET /instagram — Instagram Downloader (scrape embed page publik) ---
app.get('/instagram', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ status: 'error', message: 'Parameter "url" diperlukan.' });
  if (!url.includes('instagram.com')) return res.status(400).json({ status: 'error', message: 'URL harus Instagram.' });

  try {
    const match = url.match(/instagram\.com\/(?:p|reel|tv)\/([a-zA-Z0-9_-]+)/);
    if (!match) return res.status(400).json({ status: 'error', message: 'Format URL Instagram tidak dikenali.' });
    const shortcode = match[1];

    const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
    const html = await (await fetchWithTimeout(embedUrl)).text();
    const $ = cheerio.load(html);

    const videoMatch = html.match(/"video_url":"([^"]+)"/);
    const displayMatch = html.match(/"display_url":"([^"]+)"/);
    const ownerMatch = html.match(/"owner":\s*{\s*"id":"[^"]+","username":"([^"]+)"/);

    const unescape = (s) => s ? s.replace(/\\u0026/g, '&').replace(/\\\//g, '/') : null;

    const videoUrl = unescape(videoMatch?.[1]);
    const imageUrl = unescape(displayMatch?.[1]) || $('meta[property="og:image"]').attr('content') || null;

    if (!videoUrl && !imageUrl) {
      throw new Error('Konten tidak ditemukan. Post mungkin privat atau Instagram sedang membatasi akses.');
    }

    res.json({
      status: 'success',
      result: {
        shortcode,
        type: videoUrl ? 'video' : 'image',
        mediaUrl: videoUrl || imageUrl,
        thumbnail: imageUrl,
        username: ownerMatch?.[1] || null
      },
      note: 'Scraper publik tanpa login — bisa gagal untuk akun privat atau saat Instagram mengubah struktur halaman.'
    });
  } catch (error) {
    console.error('Error GET /instagram:', error);
    res.status(500).json({ status: 'error', message: error.message || 'Gagal mengambil media Instagram.' });
  }
});

// --- GET /facebook — Facebook Downloader (scrape og tags publik) ---
app.get('/facebook', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ status: 'error', message: 'Parameter "url" diperlukan.' });
  if (!url.includes('facebook.com') && !url.includes('fb.watch')) {
    return res.status(400).json({ status: 'error', message: 'URL harus Facebook.' });
  }

  try {
    const meta = await scrapeMeta(url);
    if (!meta.video && !meta.image) {
      throw new Error('Video/gambar tidak ditemukan. Konten mungkin privat atau memerlukan login.');
    }
    res.json({
      status: 'success',
      result: {
        title: meta.title,
        videoUrl: meta.video,
        thumbnail: meta.image
      },
      note: 'Hanya bekerja untuk video/post publik. Facebook sering membatasi akses tanpa login.'
    });
  } catch (error) {
    console.error('Error GET /facebook:', error);
    res.status(500).json({ status: 'error', message: error.message || 'Gagal mengambil video Facebook.' });
  }
});

// --- GET /twitter — Twitter/X Downloader (via syndication endpoint publik) ---
app.get('/twitter', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ status: 'error', message: 'Parameter "url" diperlukan.' });

  const match = url.match(/(?:twitter|x)\.com\/[^/]+\/status\/(\d+)/);
  if (!match) return res.status(400).json({ status: 'error', message: 'URL harus link status Twitter/X.' });
  const tweetId = match[1];

  try {
    const data = await fetchJson(`https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=a`);
    if (!data || data.error) throw new Error('Tweet tidak ditemukan atau privat.');

    const media = (data.mediaDetails || []).map(m => {
      if (m.type === 'video' || m.type === 'animated_gif') {
        const variants = (m.video_info?.variants || []).filter(v => v.content_type === 'video/mp4');
        variants.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        return { type: m.type, url: variants[0]?.url || null, thumbnail: m.media_url_https };
      }
      return { type: 'photo', url: m.media_url_https, thumbnail: m.media_url_https };
    });

    res.json({
      status: 'success',
      result: {
        text: data.text,
        author: data.user?.name,
        username: data.user?.screen_name,
        media
      }
    });
  } catch (error) {
    console.error('Error GET /twitter:', error);
    res.status(500).json({ status: 'error', message: error.message || 'Gagal mengambil tweet.' });
  }
});

// --- GET /pinterest — Pinterest Downloader (scrape og tags publik) ---
app.get('/pinterest', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ status: 'error', message: 'Parameter "url" diperlukan.' });
  if (!url.includes('pinterest.') && !url.includes('pin.it')) {
    return res.status(400).json({ status: 'error', message: 'URL harus Pinterest.' });
  }

  try {
    const meta = await scrapeMeta(url);
    if (!meta.image && !meta.video) throw new Error('Media tidak ditemukan.');

    const highRes = meta.image ? meta.image.replace(/\/\d+x(?:\/|$)/, '/originals/') : null;

    res.json({
      status: 'success',
      result: {
        title: meta.title,
        mediaUrl: meta.video || highRes || meta.image,
        thumbnail: meta.image
      }
    });
  } catch (error) {
    console.error('Error GET /pinterest:', error);
    res.status(500).json({ status: 'error', message: error.message || 'Gagal mengambil media Pinterest.' });
  }
});

// --- GET /spotify — Spotify Track Info (oEmbed resmi, stabil) ---
app.get('/spotify', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ status: 'error', message: 'Parameter "url" diperlukan.' });
  if (!url.includes('open.spotify.com')) return res.status(400).json({ status: 'error', message: 'URL harus Spotify.' });

  try {
    const data = await fetchJson(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`);
    res.json({
      status: 'success',
      result: {
        title: data.title,
        thumbnail: data.thumbnail_url,
        author: data.provider_name,
        embedHtml: data.html
      }
    });
  } catch (error) {
    console.error('Error GET /spotify:', error);
    res.status(500).json({ status: 'error', message: 'Gagal mengambil info Spotify (link mungkin tidak valid).' });
  }
});

// =========================================================
// 10. IMAGE & MEDIA TOOLS
// =========================================================

async function getImageBuffer(req) {
  const { imageUrl, imageBase64 } = { ...req.query, ...req.body };
  if (imageBase64) {
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    return Buffer.from(base64Data, 'base64');
  }
  if (imageUrl) {
    const r = await fetchWithTimeout(imageUrl, {}, 15000);
    if (!r.ok) throw new Error('Gagal mengunduh gambar dari URL.');
    return Buffer.from(await r.arrayBuffer());
  }
  const err = new Error('Sertakan "imageUrl" (query/body) atau "imageBase64" (body).');
  err.statusCode = 400;
  throw err;
}

app.all('/image/upscale', async (req, res) => {
  try {
    const buffer = await getImageBuffer(req);
    const scale = parseFloat(req.query.scale || req.body?.scale) || 2;

    if (process.env.DEEPAI_API_KEY) {
      const form = new FormData();
      form.append('image', new Blob([buffer]));
      const dRes = await fetchWithTimeout('https://api.deepai.org/api/torch-srgan', {
        method: 'POST',
        headers: { 'api-key': process.env.DEEPAI_API_KEY },
        body: form
      }, 30000);
      const dData = await dRes.json();
      if (dData?.output_url) {
        return res.json({ status: 'success', result: { imageUrl: dData.output_url, engine: 'deepai' } });
      }
    }

    const meta = await sharp(buffer).metadata();
    const outBuffer = await sharp(buffer)
      .resize(Math.round((meta.width || 512) * scale), Math.round((meta.height || 512) * scale), { kernel: 'lanczos3' })
      .toBuffer();

    res.json({
      status: 'success',
      result: { imageBase64: `data:image/png;base64,${outBuffer.toString('base64')}`, engine: 'sharp-fallback', scale }
    });
  } catch (error) {
    console.error('Error /image/upscale:', error);
    res.status(error.statusCode || 500).json({ status: 'error', message: error.message || 'Gagal upscale gambar.' });
  }
});

app.all('/image/compress', async (req, res) => {
  try {
    const buffer = await getImageBuffer(req);
    const quality = parseInt(req.query.quality || req.body?.quality) || 70;
    const format = (req.query.format || req.body?.format || 'jpeg').toLowerCase();

    let pipeline = sharp(buffer);
    if (format === 'png') pipeline = pipeline.png({ quality, compressionLevel: 9 });
    else if (format === 'webp') pipeline = pipeline.webp({ quality });
    else pipeline = pipeline.jpeg({ quality, mozjpeg: true });

    const outBuffer = await pipeline.toBuffer();

    res.json({
      status: 'success',
      result: {
        originalSizeKB: +(buffer.length / 1024).toFixed(2),
        compressedSizeKB: +(outBuffer.length / 1024).toFixed(2),
        reductionPercent: +(100 - (outBuffer.length / buffer.length) * 100).toFixed(1),
        imageBase64: `data:image/${format};base64,${outBuffer.toString('base64')}`
      }
    });
  } catch (error) {
    console.error('Error /image/compress:', error);
    res.status(error.statusCode || 500).json({ status: 'error', message: error.message || 'Gagal mengompres gambar.' });
  }
});

app.all('/image/convert', async (req, res) => {
  try {
    const buffer = await getImageBuffer(req);
    const format = (req.query.format || req.body?.format || 'png').toLowerCase();
    const allowed = ['png', 'jpeg', 'jpg', 'webp', 'avif', 'tiff', 'gif'];
    if (!allowed.includes(format)) throw new Error(`Format harus salah satu dari: ${allowed.join(', ')}`);

    const outBuffer = await sharp(buffer).toFormat(format === 'jpg' ? 'jpeg' : format).toBuffer();

    res.json({
      status: 'success',
      result: { format, imageBase64: `data:image/${format === 'jpg' ? 'jpeg' : format};base64,${outBuffer.toString('base64')}` }
    });
  } catch (error) {
    console.error('Error /image/convert:', error);
    res.status(error.statusCode || 500).json({ status: 'error', message: error.message || 'Gagal mengonversi gambar.' });
  }
});

app.all('/image/metadata', async (req, res) => {
  try {
    const buffer = await getImageBuffer(req);
    const meta = await sharp(buffer).metadata();
    let exif = null;
    try {
      exif = await exifr.parse(buffer, { gps: true });
    } catch {
      exif = null;
    }

    res.json({
      status: 'success',
      result: {
        format: meta.format,
        width: meta.width,
        height: meta.height,
        space: meta.space,
        channels: meta.channels,
        hasAlpha: meta.hasAlpha,
        orientation: meta.orientation || null,
        sizeKB: +(buffer.length / 1024).toFixed(2),
        exif: exif || null
      }
    });
  } catch (error) {
    console.error('Error /image/metadata:', error);
    res.status(error.statusCode || 500).json({ status: 'error', message: error.message || 'Gagal membaca metadata gambar.' });
  }
});

app.get('/screenshot', async (req, res) => {
  const url = req.query.url;
  const width = req.query.width || 1280;
  if (!url) return res.status(400).json({ status: 'error', message: 'Parameter "url" diperlukan.' });

  try {
    const screenshotUrl = `https://s.wordpress.com/mshots/v1/${encodeURIComponent(url)}?w=${width}`;
    await fetchWithTimeout(screenshotUrl, {}, 15000);
    res.json({ status: 'success', result: { screenshotUrl, note: 'Jika gambar masih placeholder, coba lagi beberapa detik kemudian (render async).' } });
  } catch (error) {
    console.error('Error GET /screenshot:', error);
    res.status(500).json({ status: 'error', message: 'Gagal mengambil screenshot.' });
  }
});

app.get('/qrcode', async (req, res) => {
  const text = req.query.text;
  const size = parseInt(req.query.size) || 300;
  const format = (req.query.format || 'base64').toLowerCase();

  if (!text) return res.status(400).json({ status: 'error', message: 'Parameter "text" diperlukan.' });

  try {
    if (format === 'png') {
      const buffer = await QRCode.toBuffer(text, { width: size, margin: 1 });
      res.set('Content-Type', 'image/png');
      return res.send(buffer);
    }
    const dataUrl = await QRCode.toDataURL(text, { width: size, margin: 1 });
    res.json({ status: 'success', result: { text, size, qrCodeBase64: dataUrl } });
  } catch (error) {
    console.error('Error GET /qrcode:', error);
    res.status(500).json({ status: 'error', message: 'Gagal membuat QR code.' });
  }
});

// =========================================================
// 11. UTILITY
// =========================================================

app.get('/url/metadata', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ status: 'error', message: 'Parameter "url" diperlukan.' });

  try {
    const meta = await scrapeMeta(url);
    res.json({
      status: 'success',
      result: {
        title: meta.title,
        description: meta.description,
        image: meta.image,
        siteName: meta.siteName,
        type: meta.type,
        finalUrl: meta.finalUrl
      }
    });
  } catch (error) {
    console.error('Error GET /url/metadata:', error);
    res.status(500).json({ status: 'error', message: 'Gagal mengambil metadata URL.' });
  }
});

app.post('/url/shorten', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ status: 'error', message: 'Parameter "url" diperlukan.' });

  try {
    const data = await fetchJson(`https://is.gd/create.php?format=json&url=${encodeURIComponent(url)}`);
    if (data.errorcode) throw new Error(data.errormessage || 'Gagal memperpendek URL.');
    res.json({ status: 'success', result: { original: url, shortUrl: data.shorturl } });
  } catch (error) {
    console.error('Error POST /url/shorten:', error);
    res.status(500).json({ status: 'error', message: error.message || 'Gagal memperpendek URL.' });
  }
});

app.get('/ip-info', async (req, res) => {
  const ip = req.query.ip || '';
  try {
    const data = await fetchJson(`https://ipapi.co/${ip}/json/`);
    if (data.error) throw new Error(data.reason || 'IP tidak valid.');
    res.json({
      status: 'success',
      result: {
        ip: data.ip,
        city: data.city,
        region: data.region,
        country: data.country_name,
        countryCode: data.country_code,
        postal: data.postal,
        latitude: data.latitude,
        longitude: data.longitude,
        timezone: data.timezone,
        isp: data.org,
        asn: data.asn
      }
    });
  } catch (error) {
    console.error('Error GET /ip-info:', error);
    res.status(500).json({ status: 'error', message: error.message || 'Gagal mengambil info IP.' });
  }
});

app.get('/weather', async (req, res) => {
  const city = req.query.city;
  let { lat, lon } = req.query;

  try {
    let locationName = city;
    if (city && (!lat || !lon)) {
      const geo = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`);
      const place = geo.results?.[0];
      if (!place) throw new Error('Kota tidak ditemukan.');
      lat = place.latitude;
      lon = place.longitude;
      locationName = `${place.name}, ${place.country}`;
    }
    if (!lat || !lon) return res.status(400).json({ status: 'error', message: 'Sertakan "city" atau "lat" & "lon".' });

    const weather = await fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&timezone=auto`);
    res.json({
      status: 'success',
      result: {
        location: locationName || `${lat}, ${lon}`,
        temperatureC: weather.current_weather?.temperature,
        windSpeedKmh: weather.current_weather?.windspeed,
        windDirection: weather.current_weather?.winddirection,
        weatherCode: weather.current_weather?.weathercode,
        time: weather.current_weather?.time,
        timezone: weather.timezone
      }
    });
  } catch (error) {
    console.error('Error GET /weather:', error);
    res.status(500).json({ status: 'error', message: error.message || 'Gagal mengambil data cuaca.' });
  }
});

app.get('/timestamp', (req, res) => {
  const { timestamp, date } = req.query;
  try {
    let d;
    if (timestamp) {
      const num = Number(timestamp);
      d = new Date(String(timestamp).length > 10 ? num : num * 1000);
    } else if (date) {
      d = new Date(date);
    } else {
      d = new Date();
    }
    if (isNaN(d.getTime())) throw new Error('Timestamp/tanggal tidak valid.');

    res.json({
      status: 'success',
      result: {
        iso: d.toISOString(),
        unixSeconds: Math.floor(d.getTime() / 1000),
        unixMillis: d.getTime(),
        utc: d.toUTCString(),
        localeId: d.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
      }
    });
  } catch (error) {
    res.status(400).json({ status: 'error', message: error.message });
  }
});

app.get('/password', (req, res) => {
  const length = Math.min(Math.max(parseInt(req.query.length) || 16, 4), 128);
  const useUpper = req.query.upper !== 'false';
  const useLower = req.query.lower !== 'false';
  const useNumbers = req.query.numbers !== 'false';
  const useSymbols = req.query.symbols !== 'false';
  const count = Math.min(parseInt(req.query.count) || 1, 20);

  let charset = '';
  if (useUpper) charset += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (useLower) charset += 'abcdefghijklmnopqrstuvwxyz';
  if (useNumbers) charset += '0123456789';
  if (useSymbols) charset += '!@#$%^&*()-_=+[]{}';

  if (!charset) return res.status(400).json({ status: 'error', message: 'Minimal satu jenis karakter harus aktif.' });

  const generateOne = () => {
    let pw = '';
    for (let i = 0; i < length; i++) {
      pw += charset[crypto.randomInt(0, charset.length)];
    }
    return pw;
  };

  const passwords = Array.from({ length: count }, generateOne);
  res.json({ status: 'success', result: { passwords, length, count } });
});

app.get('/uuid', (req, res) => {
  const count = Math.min(parseInt(req.query.count) || 1, 100);
  const uuids = Array.from({ length: count }, () => crypto.randomUUID());
  res.json({ status: 'success', result: { uuids, count } });
});

app.post('/hash', (req, res) => {
  const { text, algorithm } = req.body || {};
  if (!text) return res.status(400).json({ status: 'error', message: 'Parameter "text" diperlukan.' });

  const algos = algorithm ? [algorithm] : ['md5', 'sha1', 'sha256', 'sha512'];
  try {
    const result = {};
    for (const algo of algos) {
      result[algo] = crypto.createHash(algo).update(text).digest('hex');
    }
    res.json({ status: 'success', result });
  } catch (error) {
    res.status(400).json({ status: 'error', message: `Algoritma tidak didukung: ${algorithm}` });
  }
});

app.post('/base64', (req, res) => {
  const { text, action } = req.body || {};
  if (!text || !action) return res.status(400).json({ status: 'error', message: 'Parameter "text" dan "action" ("encode"/"decode") diperlukan.' });

  try {
    if (action === 'encode') {
      res.json({ status: 'success', result: { output: Buffer.from(text, 'utf-8').toString('base64') } });
    } else if (action === 'decode') {
      res.json({ status: 'success', result: { output: Buffer.from(text, 'base64').toString('utf-8') } });
    } else {
      res.status(400).json({ status: 'error', message: 'Action harus "encode" atau "decode".' });
    }
  } catch (error) {
    res.status(400).json({ status: 'error', message: 'Gagal memproses base64 (input tidak valid).' });
  }
});

app.post('/json-format', (req, res) => {
  const { json, action, indent } = req.body || {};
  if (!json) return res.status(400).json({ status: 'error', message: 'Parameter "json" diperlukan.' });

  try {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json;
    const output = action === 'minify' ? JSON.stringify(parsed) : JSON.stringify(parsed, null, indent || 2);
    res.json({ status: 'success', result: { output, valid: true } });
  } catch (error) {
    res.status(400).json({ status: 'error', message: 'JSON tidak valid: ' + error.message, valid: false });
  }
});

// =========================================================
// 12. DEVELOPER TOOLS
// =========================================================

const GITHUB_HEADERS = {
  'User-Agent': 'multi-tool-api',
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
};

app.get('/github/user/:username', async (req, res) => {
  try {
    const data = await fetchJson(`https://api.github.com/users/${req.params.username}`, { headers: GITHUB_HEADERS });
    res.json({ status: 'success', result: data });
  } catch (error) {
    console.error('Error GET /github/user:', error);
    res.status(404).json({ status: 'error', message: 'User GitHub tidak ditemukan.' });
  }
});

app.get('/github/repo/:owner/:repo', async (req, res) => {
  try {
    const data = await fetchJson(`https://api.github.com/repos/${req.params.owner}/${req.params.repo}`, { headers: GITHUB_HEADERS });
    res.json({ status: 'success', result: data });
  } catch (error) {
    console.error('Error GET /github/repo:', error);
    res.status(404).json({ status: 'error', message: 'Repository tidak ditemukan.' });
  }
});

app.get('/github/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ status: 'error', message: 'Parameter "q" diperlukan.' });

  try {
    const data = await fetchJson(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=10`, { headers: GITHUB_HEADERS });
    res.json({
      status: 'success',
      result: {
        totalCount: data.total_count,
        items: (data.items || []).map(r => ({
          fullName: r.full_name,
          description: r.description,
          stars: r.stargazers_count,
          forks: r.forks_count,
          language: r.language,
          url: r.html_url
        }))
      }
    });
  } catch (error) {
    console.error('Error GET /github/search:', error);
    res.status(500).json({ status: 'error', message: 'Gagal mencari repository GitHub.' });
  }
});

app.get('/npm/:package', async (req, res) => {
  try {
    const data = await fetchJson(`https://registry.npmjs.org/${req.params.package}`);
    const latest = data['dist-tags']?.latest;
    const latestData = data.versions?.[latest] || {};

    let downloads = null;
    try {
      const dl = await fetchJson(`https://api.npmjs.org/downloads/point/last-week/${req.params.package}`);
      downloads = dl.downloads;
    } catch {}

    res.json({
      status: 'success',
      result: {
        name: data.name,
        version: latest,
        description: latestData.description || data.description,
        license: latestData.license,
        homepage: latestData.homepage,
        repository: latestData.repository?.url,
        author: latestData.author?.name || latestData.author,
        weeklyDownloads: downloads
      }
    });
  } catch (error) {
    console.error('Error GET /npm/:package:', error);
    res.status(404).json({ status: 'error', message: 'Package NPM tidak ditemukan.' });
  }
});

app.get('/dns-lookup', async (req, res) => {
  const domain = req.query.domain;
  const type = (req.query.type || 'A').toUpperCase();
  if (!domain) return res.status(400).json({ status: 'error', message: 'Parameter "domain" diperlukan.' });

  try {
    let records;
    switch (type) {
      case 'A': records = await dns.resolve4(domain); break;
      case 'AAAA': records = await dns.resolve6(domain); break;
      case 'MX': records = await dns.resolveMx(domain); break;
      case 'TXT': records = await dns.resolveTxt(domain); break;
      case 'NS': records = await dns.resolveNs(domain); break;
      case 'CNAME': records = await dns.resolveCname(domain); break;
      case 'SOA': records = await dns.resolveSoa(domain); break;
      default: return res.status(400).json({ status: 'error', message: 'Tipe harus salah satu: A, AAAA, MX, TXT, NS, CNAME, SOA.' });
    }
    res.json({ status: 'success', result: { domain, type, records } });
  } catch (error) {
    console.error('Error GET /dns-lookup:', error);
    res.status(404).json({ status: 'error', message: `Tidak ada record ${type} untuk domain ini.` });
  }
});

app.get('/domain-info', async (req, res) => {
  const domain = req.query.domain;
  if (!domain) return res.status(400).json({ status: 'error', message: 'Parameter "domain" diperlukan.' });

  try {
    const data = await fetchJson(`https://rdap.org/domain/${domain}`);
    res.json({
      status: 'success',
      result: {
        domain: data.ldhName,
        status: data.status,
        events: data.events,
        nameservers: (data.nameservers || []).map(n => n.ldhName),
        registrar: data.entities?.find(e => e.roles?.includes('registrar'))?.vcardArray?.[1]?.find(v => v[0] === 'fn')?.[3] || null
      }
    });
  } catch (error) {
    console.error('Error GET /domain-info:', error);
    res.status(404).json({ status: 'error', message: 'Info domain tidak ditemukan (mungkin TLD tidak didukung RDAP).' });
  }
});

app.get('/http-status', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ status: 'error', message: 'Parameter "url" diperlukan.' });

  try {
    const start = Date.now();
    const response = await fetchWithTimeout(url, { method: 'GET', redirect: 'follow' }, 15000);
    const responseTimeMs = Date.now() - start;

    res.json({
      status: 'success',
      result: {
        url,
        finalUrl: response.url,
        httpStatus: response.status,
        statusText: response.statusText,
        redirected: response.redirected,
        responseTimeMs,
        contentType: response.headers.get('content-type')
      }
    });
  } catch (error) {
    console.error('Error GET /http-status:', error);
    res.status(200).json({ status: 'success', result: { url, httpStatus: null, up: false, message: error.message } });
  }
});

app.get('/uptime-check', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ status: 'error', message: 'Parameter "url" diperlukan.' });

  const start = Date.now();
  try {
    const response = await fetchWithTimeout(url, { method: 'GET', redirect: 'follow' }, 10000);
    res.json({
      status: 'success',
      result: {
        url,
        up: response.ok,
        httpStatus: response.status,
        responseTimeMs: Date.now() - start,
        checkedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    res.json({
      status: 'success',
      result: { url, up: false, httpStatus: null, responseTimeMs: Date.now() - start, checkedAt: new Date().toISOString(), error: error.message }
    });
  }
});

app.get('/ssl-info', (req, res) => {
  const host = req.query.host || req.query.domain;
  const port = parseInt(req.query.port) || 443;
  if (!host) return res.status(400).json({ status: 'error', message: 'Parameter "host" diperlukan.' });

  const socket = tls.connect({ host, port, servername: host, timeout: 10000 }, () => {
    const cert = socket.getPeerCertificate();
    socket.end();
    if (!cert || Object.keys(cert).length === 0) {
      return res.status(500).json({ status: 'error', message: 'Tidak dapat membaca sertifikat SSL.' });
    }
    res.json({
      status: 'success',
      result: {
        host,
        subject: cert.subject,
        issuer: cert.issuer,
        validFrom: cert.valid_from,
        validTo: cert.valid_to,
        fingerprint: cert.fingerprint,
        serialNumber: cert.serialNumber,
        protocol: socket.getProtocol()
      }
    });
  });

  socket.on('error', (error) => {
    console.error('Error GET /ssl-info:', error);
    res.status(500).json({ status: 'error', message: error.message || 'Gagal terhubung ke host.' });
  });

  socket.on('timeout', () => {
    socket.destroy();
    res.status(504).json({ status: 'error', message: 'Koneksi timeout.' });
  });
});

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const num = parseInt(full, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}
function rgbToHex({ r, g, b }) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}
function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

app.get('/color-convert', (req, res) => {
  const color = req.query.color;
  if (!color) return res.status(400).json({ status: 'error', message: 'Parameter "color" diperlukan (hex, rgb, atau hsl).' });

  try {
    let rgb;
    if (color.startsWith('#')) {
      rgb = hexToRgb(color);
    } else if (color.toLowerCase().startsWith('rgb')) {
      const [r, g, b] = color.match(/\d+/g).map(Number);
      rgb = { r, g, b };
    } else {
      return res.status(400).json({ status: 'error', message: 'Format warna tidak dikenali. Gunakan hex (#fff) atau rgb(255,255,255).' });
    }

    res.json({
      status: 'success',
      result: { hex: rgbToHex(rgb), rgb, hsl: rgbToHsl(rgb) }
    });
  } catch (error) {
    res.status(400).json({ status: 'error', message: 'Gagal mem-parsing warna.' });
  }
});

// =========================================================
// 12B. CHARACTER.AI (CAI)
// =========================================================

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

    const sessionId = randomUUIDCompat();
    caiSessions[sessionId] = { charId, chatId, createdAt: new Date().toISOString() };
    saveCaiSessions();

    res.json({ status: 'success', result: { sessionId, charId, chatId, greeting } });
  } catch (error) {
    console.error('Error POST /cai/session:', error);
    res.status(500).json({ status: 'error', message: error.message || 'Gagal membuat session.' });
  }
});

function randomUUIDCompat() {
  return crypto.randomUUID();
}

app.get('/cai/session/:id', (req, res) => {
  try {
    const session = getCaiSession(req.params.id);
    res.json({ status: 'success', result: { sessionId: req.params.id, ...session } });
  } catch (error) {
    res.status(error.statusCode || 500).json({ status: 'error', message: error.message });
  }
});

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

app.post('/cai/session/:id/chat', async (req, res) => {
  const { message } = req.body || {};
  const { id } = req.params;
  if (!message) return res.status(400).json({ status: 'error', message: 'Parameter "message" diperlukan.' });

  try {
    const session = getCaiSession(id);
    await caiEnsureConnected(session.charId);
    const response = await caiSendMessage({ charId: session.charId, chatId: session.chatId, message });
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
// 13. SYSTEM & API
// =========================================================

app.get('/health', (req, res) => {
  res.json({
    status: 'success',
    result: {
      ok: true,
      uptimeSeconds: Math.floor((Date.now() - stats.startTime) / 1000),
      timestamp: new Date().toISOString()
    }
  });
});

app.get('/ping', (req, res) => {
  res.json({ status: 'success', result: { message: 'pong', timestamp: Date.now() } });
});

app.get('/api/stats', (req, res) => {
  res.json({
    status: 'success',
    result: {
      uptimeSeconds: Math.floor((Date.now() - stats.startTime) / 1000),
      totalRequests: stats.totalRequests,
      totalErrors: stats.errors,
      byMethod: stats.byMethod
    }
  });
});

app.get('/api/endpoint-stats', (req, res) => {
  const sorted = Object.entries(stats.byEndpoint)
    .sort((a, b) => b[1] - a[1])
    .map(([endpoint, count]) => ({ endpoint, count }));
  res.json({ status: 'success', result: { endpoints: sorted } });
});

app.get('/api/request-stats', (req, res) => {
  res.json({
    status: 'success',
    result: {
      totalRequests: stats.totalRequests,
      totalErrors: stats.errors,
      errorRatePercent: stats.totalRequests ? +((stats.errors / stats.totalRequests) * 100).toFixed(2) : 0,
      requestsByMethod: stats.byMethod
    }
  });
});

app.get('/system-info', (req, res) => {
  res.json({
    status: 'success',
    result: {
      platform: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
      cpuCount: os.cpus().length,
      totalMemoryMB: +(os.totalmem() / 1024 / 1024).toFixed(0),
      freeMemoryMB: +(os.freemem() / 1024 / 1024).toFixed(0),
      processUptimeSeconds: Math.floor(process.uptime()),
      loadAverage: os.loadavg()
    }
  });
});

// FIX: tambahin status "youtube" biar kelihatan dari /service-status apakah
// COBALT_API_URL sudah diset atau belum, tanpa harus nunggu error di /ytmp3.
app.get('/service-status', async (req, res) => {
  const result = {
    gemini: Boolean(process.env.GEMINI_API_KEY),
    groq: Boolean(process.env.GROQ_API_KEY),
    characterAI: Boolean(process.env.CHARACTER_AI_TOKEN),
    deepAI: Boolean(process.env.DEEPAI_API_KEY),
    githubToken: Boolean(process.env.GITHUB_TOKEN),
    youtubeDownloader: Boolean(process.env.COBALT_API_URL)
  };
  res.json({ status: 'success', result: { configured: result, timestamp: new Date().toISOString() } });
});

// =========================================================
// 14. 404 CATCH-ALL — semua route tidak dikenal → 404.html
// =========================================================
const JSON_PREFIXES = [
  '/generate', '/response', '/ai/', '/tiktok', '/ytmp3', '/ytmp4', '/youtube/', '/instagram',
  '/facebook', '/twitter', '/pinterest', '/spotify', '/image/', '/screenshot', '/qrcode',
  '/url/', '/ip-info', '/weather', '/timestamp', '/password', '/uuid', '/hash', '/base64',
  '/json-format', '/github/', '/npm/', '/dns-lookup', '/domain-info', '/http-status',
  '/uptime-check', '/ssl-info', '/color-convert', '/cai', '/health', '/ping', '/api/',
  '/system-info', '/service-status'
];

app.use((req, res, next) => {
  const isJsonRoute = JSON_PREFIXES.some(p => req.path.startsWith(p)) || req.headers.accept?.includes('application/json');
  if (isJsonRoute) {
    return res.status(404).json({ status: 'error', message: 'Endpoint tidak ditemukan.' });
  }
  res.status(404).sendFile(path.join(__dirname, '404.html'));
});

// =========================================================
// 14B. ERROR HANDLER
// =========================================================
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ status: 'error', message: 'Internal Server Error' });
});

// =========================================================
// 15. START SERVER (LOCAL)
// =========================================================
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`Server berjalan di port ${PORT}`));
}

// =========================================================
// 16. EXPORT UNTUK VERCEL
// =========================================================
export default app;
