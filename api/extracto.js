// Ahed · lee estados de cuenta (capturas o PDF) con un modelo de visión de OpenAI.
// Variables de entorno en Vercel: OPENAI_API_KEY, AHED_CODE (código de acceso tuyo) y, opcional, OPENAI_MODEL.
const crypto = require('crypto');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['broker', 'statement_date', 'transactions', 'positions', 'notes'],
  properties: {
    broker: { type: ['string', 'null'] },
    statement_date: { type: ['string', 'null'] },
    transactions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['date', 'side', 'symbol', 'quantity', 'price', 'currency'],
        properties: {
          date: { type: ['string', 'null'] },
          side: { type: 'string', enum: ['buy', 'sell'] },
          symbol: { type: 'string' },
          quantity: { type: 'number' },
          price: { type: ['number', 'null'] },
          currency: { type: 'string' }
        }
      }
    },
    positions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['symbol', 'quantity', 'avg_cost', 'currency'],
        properties: {
          symbol: { type: 'string' },
          quantity: { type: 'number' },
          avg_cost: { type: ['number', 'null'] },
          currency: { type: 'string' }
        }
      }
    },
    notes: { type: 'string' }
  }
};

const SYSTEM = `Eres un extractor de datos de estados de cuenta, historiales y capturas de brokers y exchanges (acciones, ETF y criptomonedas).
Reglas:
- Extrae solo lo que está escrito en los documentos. No inventes ni calcules datos que no aparezcan. Si un dato falta, usa null.
- "transactions": solo compras y ventas de activos (side "buy" o "sell"). Ignora depósitos, retiros, dividendos, comisiones, intereses e impuestos.
- Fechas en formato AAAA-MM-DD. Si ves DD/MM/AAAA, interprétala con el día primero.
- "symbol": el ticker en mayúsculas (META, AAPL, VOO, BTC, ETH). Si solo aparece el nombre de la empresa o de la moneda, usa su ticker más conocido.
- "price" es el precio por unidad. Si el documento solo trae el total pagado y la cantidad, calcula price = total / quantity.
- "currency": USD, COP u otro código ISO tal como aparece. No conviertas monedas.
- "positions": cuando el documento muestra lo que tiene el usuario hoy (tenencias), con cantidad y costo promedio por unidad si aparece (avg_cost). No repitas en "positions" lo que ya pusiste en "transactions".
- "broker": el nombre del broker o exchange si se identifica en el documento.
- "notes": una frase breve en español con cualquier duda o dato ilegible (por ejemplo, una página cortada).`;

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
const str = (v, n = 40) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido.' });

  const apiKey = process.env.OPENAI_API_KEY, code = process.env.AHED_CODE;
  if (!apiKey || !code) {
    return res.status(503).json({ error: 'Falta configurar OPENAI_API_KEY y AHED_CODE en Vercel (Settings → Environment Variables) y volver a desplegar.' });
  }
  if (!safeEqual(req.headers['x-ahed-code'] || '', code)) {
    return res.status(401).json({ error: 'Código de acceso incorrecto.' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const files = Array.isArray(body && body.files) ? body.files.slice(0, 6) : [];
  if (!files.length) return res.status(400).json({ error: 'No llegó ningún archivo.' });

  const parts = [{ type: 'text', text: 'Extrae las compras, ventas y posiciones de estos documentos.' + (body.broker ? ' El broker es ' + String(body.broker).slice(0, 60) + '.' : '') }];
  for (const f of files) {
    const data = f && typeof f.data === 'string' ? f.data : '';
    if (data.startsWith('data:image/')) parts.push({ type: 'image_url', image_url: { url: data, detail: 'high' } });
    else if (data.startsWith('data:application/pdf;base64,')) parts.push({ type: 'file', file: { filename: str(f.name, 80) || 'extracto.pdf', file_data: data } });
    else return res.status(400).json({ error: 'Solo se aceptan imágenes y PDF.' });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 55000);
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o',
        temperature: 0,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: parts }],
        response_format: { type: 'json_schema', json_schema: { name: 'extracto', strict: true, schema: SCHEMA } }
      })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (j.error && j.error.message) || ('OpenAI respondió ' + r.status);
      return res.status(502).json({ error: 'OpenAI: ' + msg });
    }
    let out;
    try { out = JSON.parse(j.choices[0].message.content); } catch (e) { return res.status(502).json({ error: 'La respuesta de la IA no se pudo leer. Intenta con una captura más clara.' }); }

    const clean = {
      broker: str(out.broker, 60) || null,
      statement_date: str(out.statement_date, 12) || null,
      transactions: (out.transactions || []).slice(0, 300).map(t => ({
        date: str(t.date, 12) || null, side: t.side === 'sell' ? 'sell' : 'buy', symbol: str(t.symbol, 12).toUpperCase(),
        quantity: num(t.quantity), price: num(t.price), currency: str(t.currency, 5).toUpperCase() || 'USD'
      })).filter(t => t.symbol && t.quantity > 0),
      positions: (out.positions || []).slice(0, 100).map(p => ({
        symbol: str(p.symbol, 12).toUpperCase(), quantity: num(p.quantity), avg_cost: num(p.avg_cost), currency: str(p.currency, 5).toUpperCase() || 'USD'
      })).filter(p => p.symbol && p.quantity > 0),
      notes: str(out.notes, 400)
    };
    return res.status(200).json(clean);
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? 'La lectura tardó demasiado. Prueba con menos páginas o capturas.' : 'No pude conectar con OpenAI.';
    return res.status(504).json({ error: msg });
  } finally {
    clearTimeout(timer);
  }
};
