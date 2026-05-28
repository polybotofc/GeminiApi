// =========================================================
// 1. IMPOR MODUL DAN SETUP AWAL
// =========================================================
import 'dotenv/config';
import express from 'express';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';

// Security Packages
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import timeout from 'connect-timeout';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// =========================================================
// 2. GOOGLE AI SETUP
// =========================================================
const ai = new GoogleGenAI({
apiKey: process.env.GEMINI_API_KEY
});

// =========================================================
// 3. MIDDLEWARE DASAR
// =========================================================
app.use(express.json({ limit: '1mb' }));

// Hide Express Info
app.disable('x-powered-by');

// Timeout Request
app.use(timeout('15s'));

// Helmet Security
app.use(helmet());

// =========================================================
// 4. RATE LIMIT
// =========================================================
const globalLimiter = rateLimit({
windowMs: 60 * 1000, // 1 menit
max: 60,
standardHeaders: true,
legacyHeaders: false,
message: {
status: 'error',
message: 'Terlalu banyak request.'
}
});

const aiLimiter = rateLimit({
windowMs: 60 * 1000,
max: 15,
message: {
status: 'error',
message: 'Limit AI tercapai. Coba lagi nanti.'
}
});

const tiktokLimiter = rateLimit({
windowMs: 60 * 1000,
max: 10,
message: {
status: 'error',
message: 'Limit TikTok downloader tercapai.'
}
});

app.use(globalLimiter);

// =========================================================
// 5. API KEY PROTECTION
// =========================================================
const API_KEY = process.env.API_KEY;

app.use((req, res, next) => {
// Skip API key untuk homepage
if (req.path === '/') return next();

const userKey = req.headers['x-api-key'];

if (!userKey || userKey !== API_KEY) {
return res.status(403).json({
status: 'error',
message: 'API key tidak valid'
});
}

next();
});

// =========================================================
// 6. CORS AMAN
// =========================================================
const allowedOrigins = [
'https://poly-md.my.id',
'http://localhost:3000'
];

app.use((req, res, next) => {
const origin = req.headers.origin;

if (allowedOrigins.includes(origin)) {
res.header('Access-Control-Allow-Origin', origin);
}

res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

if (req.method === 'OPTIONS') {
return res.sendStatus(200);
}

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
app.post('/generate', aiLimiter, async (req, res) => {
const { prompt } = req.body;

if (!prompt) {
return res.status(400).json({
status: 'error',
message: 'Parameter "prompt" diperlukan.'
});
}

// Batasi panjang prompt
if (prompt.length > 2000) {
return res.status(400).json({
status: 'error',
message: 'Prompt terlalu panjang.'
});
}

try {
const response = await ai.models.generateContent({
model: 'gemini-2.5-flash',
contents: [
{
role: 'user',
parts: [{ text: prompt }]
}
]
});

```
res.json({
  status: 'success',
  generated_text: response.text
});
```

} catch (error) {
console.error('Error POST /generate:', error);

```
res.status(500).json({
  status: 'error',
  message: 'Gagal memproses AI'
});
```

}
});

// =========================================================
// 9. ENDPOINT: GET /response
// =========================================================
app.get('/response', aiLimiter, async (req, res) => {

const prompt = req.query.message;
const userName = req.query.username || 'Pengguna';
const customName = req.query.name || 'Poly';

const customDesc =
req.query.desc ||
'asisten AI yang ramah, pintar, dan membantu';

if (!prompt) {
return res.status(400).json({
status: 'error',
message: 'Parameter "message" diperlukan.'
});
}

if (prompt.length > 2000) {
return res.status(400).json({
status: 'error',
message: 'Pesan terlalu panjang.'
});
}

const dynamicPersona = `Anda adalah ${customName}, seorang ${customDesc}.
Anda sedang berbicara dengan ${userName}.
Jawab dengan ramah dan singkat.`;

try {

```
const response = await ai.models.generateContent({
  model: 'gemini-2.5-flash',
  contents: [
    {
      role: 'user',
      parts: [{ text: prompt }]
    }
  ],
  config: {
    systemInstruction: dynamicPersona
  }
});

res.json({
  status: 'success',
  generated_text: response.text
});
```

} catch (error) {

```
console.error('Error GET /response:', error);

res.status(500).json({
  status: 'error',
  message: 'Gagal memproses AI'
});
```

}
});

// =========================================================
// 10. ENDPOINT: GET /tiktok
// =========================================================
app.get('/tiktok', tiktokLimiter, async (req, res) => {

const url = req.query.url;

if (!url) {
return res.status(400).json({
status: 'error',
message: 'Parameter "url" diperlukan.'
});
}

// Validasi TikTok URL
if (
!url.includes('tiktok.com') &&
!url.includes('vt.tiktok.com')
) {
return res.status(400).json({
status: 'error',
message: 'URL harus TikTok'
});
}

try {

```
const apiUrl =
  `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`;

const response = await fetch(apiUrl);

const data = await response.json();

if (data.code !== 0) {
  return res.status(404).json({
    status: 'error',
    message: 'Video tidak ditemukan'
  });
}

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
```

} catch (error) {

```
console.error('Error GET /tiktok:', error);

res.status(500).json({
  status: 'error',
  message: 'Gagal mengambil video'
});
```

}
});

// =========================================================
// 11. HANDLE ERROR
// =========================================================
app.use((err, req, res, next) => {

if (err.code === 'ETIMEDOUT') {
return res.status(408).json({
status: 'error',
message: 'Request timeout'
});
}

console.error(err);

res.status(500).json({
status: 'error',
message: 'Internal Server Error'
});
});

// =========================================================
// 12. START SERVER (LOCAL)
// =========================================================
if (process.env.NODE_ENV !== 'production') {
app.listen(PORT, () => {
console.log(`Server berjalan di port ${PORT}`);
});
}

// =========================================================
// 13. EXPORT UNTUK VERCEL
// =========================================================
export default app;
