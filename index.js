// =========================================================
// 1. IMPOR MODUL DAN SETUP AWAL
// =========================================================
import 'dotenv/config';
import express from 'express';
import { GoogleGenAI } from '@google/genai';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const require = createRequire(import.meta.url);
const apidylux = require('api-dylux');

const app = express();
const PORT = process.env.PORT || 3000;
const ai = new GoogleGenAI({});

app.use(express.json());

// =========================================================
// 2. CORS MIDDLEWARE
// =========================================================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// =========================================================
// SERVE DASHBOARD HTML
// =========================================================
app.use(express.static(path.join(__dirname, '.')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// =========================================================
// 3. ENDPOINT: POST /generate
// =========================================================
app.post('/generate', async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) {
        return res.status(400).json({ error: 'Parameter "prompt" diperlukan.' });
    }
    try {
        const response = await ai.models.generateContent({
            model: "gemini-2.5-pro",
            contents: [{ role: "user", parts: [{ text: prompt }] }]
        });
        res.json({
            status: 'success',
            generated_text: response.text
        });
    } catch (error) {
        console.error('Error POST /generate:', error);
        res.status(500).json({
            status: 'error',
            message: 'Gagal memproses permintaan AI',
            details: error.message
        });
    }
});

// =========================================================
// 4. ENDPOINT: GET /response (AI Chat dengan Persona)
// =========================================================
app.get('/response', async (req, res) => {
    const prompt    = req.query.message;
    const userName  = req.query.username || 'Pengguna Misterius';
    const customName = req.query.name || 'Poly';
    const customDesc = req.query.desc  || 'asisten yang sangat cerdas, ceria, dan bersahabat. Selalu jawab dengan antusias dan gunakan minimal dua (2) emoji di setiap respons Anda. Pencipta: PolyGanteng';
    const dynamicPersona = `Anda adalah ${customName}, seorang ${customDesc}. Anda sedang berbicara dengan ${userName}. Saat merespons, sapa ${userName} dengan ramah menggunakan namanya.`;

    if (!prompt) {
        return res.status(400).json({
            error: 'Parameter "message" diperlukan.',
            example: '/response?message=Halo&username=NamaAnda'
        });
    }
    try {
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: { systemInstruction: dynamicPersona }
        });
        res.json({
            status: 'success',
            username_received: userName,
            persona_used: dynamicPersona,
            input_prompt: prompt,
            generated_text: response.text
        });
    } catch (error) {
        console.error('Error GET /response:', error);
        res.status(500).json({
            status: 'error',
            message: 'Gagal memproses permintaan AI',
            details: error.message
        });
    }
});

// =========================================================
// 5. ENDPOINT: GET /tiktok (TikTok Downloader)
// =========================================================
app.get('/tiktok', async (req, res) => {
    const url = req.query.url;

    if (!url) {
        return res.status(400).json({
            status: 'error',
            error: 'Parameter "url" diperlukan.',
            example: '/tiktok?url=https://www.tiktok.com/...'
        });
    }

    try {
        const video = await apidylux.tiktok(url);

        res.json({
            status: 'success',
            result: {
                title:     video.result.title,
                author:    video.result.author.nickname,
                videoUrl:  video.result.play,
                audio:     video.result.music,
                thumbnail: video.result.cover
            }
        });
    } catch (error) {
        console.error('Error GET /tiktok:', error);
        res.status(500).json({
            status: 'error',
            message: 'Video tidak ditemukan atau URL tidak valid',
            details: error.message
        });
    }
});

// =========================================================
// 6. EKSPOR UNTUK VERCEL
// =========================================================
export default app;
