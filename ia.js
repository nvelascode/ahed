// Ahed · explicaciones con IA (radar y resumen semanal) usando OpenAI.
// Usa las mismas variables de entorno que api/extracto.js: OPENAI_API_KEY, AHED_CODE y, opcional, OPENAI_MODEL.
const crypto = require('crypto');

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const BASE = `Eres el asistente de Ahed, una app personal de inversiones de un usuario en Colombia. Escribes en español de Colombia, claro y cálido, sin jerga, para alguien que no es experto en finanzas.
Reglas:
- Usa SOLO los números que vienen en los datos. No inventes cifras, fechas, noticias ni datos de la empresa que no estén ahí.
- No recomiendes comprar, vender ni mantener. No prometas ni predigas rendimientos.
- No uses encabezados, listas ni negritas: solo párrafos cortos de texto.`;

const TASKS = {
  explicar: `Tarea: explica el activo del radar. Primero, una frase sobre qué es (solo si es una empresa, ETF o cripto que conoces con seguridad; si no estás seguro, di que no tienes certeza de a qué se dedica). Después explica en palabras simples por qué el índice de oportunidad está donde está, apoyándote en las partes del índice y en 3 o 4 datos clave de los que vienen. Termina con una frase corta recordando que el índice mide qué tan barato está frente a su propio historial y no predice el futuro. Máximo 140 palabras.`,
  semana: `Tarea: cuenta qué pasó con el portafolio en el periodo de los datos. Di primero cómo le fue frente al S&P 500 en pesos. Luego explica el porqué usando el cambio del dólar, el rendimiento y el peso de cada grupo y de los activos principales (por ejemplo, qué sumó o restó). Si los datos en dólares y en pesos cuentan historias distintas, explica que la diferencia viene del dólar. Máximo 120 palabras.`
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const apiKey = process.env.OPENAI_API_KEY, code = process.env.AHED_CODE, model = process.env.OPENAI_MODEL || 'gpt-4o';
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido.' });
  if (!apiKey || !code) return res.status(503).json({ error: 'Falta configurar OPENAI_API_KEY y AHED_CODE en Vercel.' });
  if (!safeEqual(req.headers['x-ahed-code'] || '', code)) return res.status(401).json({ error: 'Código de acceso incorrecto.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || !TASKS[body.tipo] || typeof body.datos !== 'object' || body.datos === null) {
    return res.status(400).json({ error: 'Solicitud no válida.' });
  }
  const payload = JSON.stringify(body.datos);
  if (payload.length > 6000) return res.status(413).json({ error: 'Los datos son demasiado grandes.' });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({
        model,
        max_completion_tokens: 1500,
        messages: [
          { role: 'system', content: BASE + '\n' + TASKS[body.tipo] },
          { role: 'user', content: 'Datos (JSON):\n' + payload }
        ]
      })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (j && j.error && j.error.message) || ('OpenAI respondió ' + r.status);
      return res.status(502).json({ error: 'OpenAI: ' + msg });
    }
    const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim();
    if (!text) return res.status(502).json({ error: 'La IA no devolvió texto. Intenta de nuevo.' });
    return res.status(200).json({ text });
  } catch (e) {
    const timeout = e && e.name === 'AbortError';
    return res.status(504).json({ error: timeout ? 'La IA tardó demasiado. Intenta de nuevo.' : 'No pude conectar con OpenAI.' });
  } finally {
    clearTimeout(timer);
  }
};
