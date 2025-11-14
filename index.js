// =========================================================
// 1. IMPOR MODUL DAN SETUP AWAL
// =========================================================
import 'dotenv/config'; 
import express from 'express';
import { GoogleGenAI } from '@google/genai';

const app = express();
// PORT lokal (hanya untuk pengujian di komputer lokal)
const PORT = process.env.PORT || 3000; 

// Klien akan otomatis mencari GEMINI_API_KEY dari process.env di Vercel
const ai = new GoogleGenAI({}); 

// Middleware untuk POST
app.use(express.json());

// =========================================================
// 2. ENDPOINT 1: POST /generate (Untuk permintaan non-persona)
// =========================================================
app.post('/generate', async (req, res) => {
    const { prompt } = req.body;

    if (!prompt) {
        return res.status(400).json({ error: 'Parameter "prompt" diperlukan.' });
    }

    try {
        // Menggunakan gemini-2.5-pro seperti yang Anda minta
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
// 3. ENDPOINT 2: GET /response (Dengan Persona Kustom & Username)
// =========================================================
app.get('/response', async (req, res) => {
    // Ambil pesan utama
    const prompt = req.query.message; 
    
    // Ambil username dari URL Query (default: Pengguna Misterius)
    const userName = req.query.username || 'Pengguna Misterius'; 
    
    // Definisikan persona kustom
    const customName = req.query.name || 'Satria'; 
    const customDesc = req.query.desc || 'asisten yang sangat cerdas, ceria, dan bersahabat. Selalu jawab dengan antusias dan gunakan minimal dua (2) emoji di setiap respons Anda. Pencipta: PolyGanteng'; 

    // Instruksi sistem: Beri tahu Gemini siapa penggunanya dan bagaimana harus merespons
    const dynamicPersona = `Anda adalah ${customName}, seorang ${customDesc}. Anda sedang berbicara dengan ${userName}. Saat merespons, sapa ${userName} dengan ramah menggunakan namanya.`;

    if (!prompt) {
        return res.status(400).json({ 
            error: 'Parameter "message" diperlukan.',
            example: 'Gunakan /response?message=Halo&username=NamaAnda'
        });
    }

    try {
        const response = await ai.models.generateContent({
            // Menggunakan gemini-2.5-flash untuk respons cepat dan persona
            model: "gemini-2.5-flash", 
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: { 
                systemInstruction: dynamicPersona 
            }
        });

        res.json({
            status: 'success',
            username_received: userName, // Untuk verifikasi bot
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