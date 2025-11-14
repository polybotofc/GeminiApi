// =========================================================
// 1. IMPOR MODUL DAN SETUP AWAL
// =========================================================
import 'dotenv/config'; 
import express from 'express';
import { GoogleGenAI } from '@google/genai';

const app = express();
const PORT = process.env.PORT || 3000; 

// Klien akan otomatis mencari GEMINI_API_KEY dari process.env
const ai = new GoogleGenAI({}); 

// Middleware untuk POST
app.use(express.json());

// =========================================================
// 2. ENDPOINT 1: POST /generate 
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
        console.error('Error saat memanggil Gemini API (POST):', error);
        res.status(500).json({ 
            status: 'error',
            message: 'Gagal memproses permintaan AI',
            details: error.message 
        });
    }
});

// =========================================================
// 3. ENDPOINT 2: GET /response (Dengan Persona Kustom)
// =========================================================
app.get('/response', async (req, res) => {
    const prompt = req.query.message; 
    const customName = req.query.name || 'Satria'; 
    const customDesc = req.query.desc || 'asisten yang sangat cerdas, ceria, dan bersahabat. Selalu jawab dengan antusias dan gunakan minimal dua (2) emoji di setiap respons Anda. Pencipta: PolyGanteng'; 

    const dynamicPersona = `Anda adalah ${customName}, seorang ${customDesc}.`;

    if (!prompt) {
        return res.status(400).json({ 
            error: 'Parameter "message" diperlukan.'
        });
    }

    try {
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash", 
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: { 
                systemInstruction: dynamicPersona 
            }
        });

        res.json({
            status: 'success',
            persona_used: dynamicPersona,
            input_prompt: prompt,
            generated_text: response.text
        });
    } catch (error) {
        console.error('Error saat memanggil Gemini API (GET):', error);
        res.status(500).json({ 
            status: 'error',
            message: 'Gagal memproses permintaan AI',
            details: error.message 
        });
    }
});

// =========================================================
// 4. EKSPOR APLIKASI UNTUK VERCEL (PENTING!)
// =========================================================
// Vercel akan membaca baris ekspor ini
export default app;
// app.listen hanya untuk pengujian lokal, bisa dihapus di sini