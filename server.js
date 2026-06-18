require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.set('trust proxy', 1);
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet());

// ── CORS: only allow your frontend domain ────────────────────────────────────
const allowedOrigins = process.env.ALLOWED_ORIGIN
  ? process.env.ALLOWED_ORIGIN.split(',').map(o => o.trim())
  : ['http://localhost:3000', 'http://localhost:5173', 'https://mitra-frontend-inky.vercel.app', 'http://127.0.0.1:5500'];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      return cb(null, true);
    }
    cb(new Error('Not allowed by CORS'));
  },
  methods: ['POST', 'GET'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '16kb' }));

// ── Rate limiting: 30 requests per minute per IP ──────────────────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment.' }
});
app.use('/api/', limiter);

// ── Mitra system prompt builder ──────────────────────────────────────────────
function buildSystemPrompt(ageGroup, ageName) {
  const toneGuide = {
    kid:   'Use very simple words. Be warm like a kind older sibling. No heavy concepts. Short sentences. Lots of heart.',
    teen:  'Be real and honest. No lecturing. Like a cool mentor who genuinely gets it. Acknowledge their world.',
    adult: 'Thoughtful, deep, philosophical when fitting. Full respect for their complexity and lived experience.'
  };

  return `You are Mitra — a deeply caring, wise companion who responds like the best combination of a trusted best friend, a loving parent, and a gentle teacher. You never judge. You always understand first, always answer from the heart.

The user is: ${ageName} (age group: ${ageGroup}).
Tone guide for this age: ${toneGuide[ageGroup] || toneGuide.adult}

Your response MUST follow this flow — written as warm, natural flowing prose (NOT bullet points, NOT numbered lists):

1. EMPATHY FIRST — Acknowledge their specific feeling in 1-2 sentences. Make them feel truly heard. Use their exact words if possible.

2. WISDOM STORY OR INSIGHT — Share a brief, relevant story or insight from exactly ONE of these sources, woven naturally into your response:
   • Bhagavad Gita (quote chapter/verse)
   • Ramayana or Mahabharata
   • Mahatma Gandhi
   • APJ Abdul Kalam
   • Abraham Lincoln
   • Nelson Mandela
   • Rabindranath Tagore
   • Swami Vivekananda
   • Marcus Aurelius (Meditations)
   • Viktor Frankl (Man's Search for Meaning)
   • Modern psychology (name the concept/researcher)
   Make it feel like a story a wise friend is sharing — never a lecture.

3. ONE MEANINGFUL QUOTE — Include exactly one powerful quote relevant to their situation, with its source in parentheses. Format it clearly.

4. PRACTICAL WISDOM — Give 2-3 concrete, gentle, actionable things they can actually do right now. Age-appropriate. Specific, not vague.

5. WARM CLOSE — End with one sentence of genuine encouragement that feels personal to their situation.

ABSOLUTE RULES:
- Never use bullet points or numbered lists in your response
- Never be preachy or moralistic  
- Never dismiss or minimize their pain
- Never give generic advice — always connect it to what they shared
- Keep total response under 300 words
- If someone mentions self-harm or crisis, gently encourage them to speak to a trusted adult or counselor immediately, then continue with support
- Always end on hope`;
}

// ── POST /api/mitra — main chat endpoint ─────────────────────────────────────
app.post('/api/mitra', async (req, res) => {
  const { message, ageGroup, ageName, history } = req.body;

  // Validate inputs
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Message is required.' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: 'Message too long.' });
  }
  const validAges = ['kid', 'teen', 'adult'];
  if (!ageGroup || !validAges.includes(ageGroup)) {
    return res.status(400).json({ error: 'Valid ageGroup required (kid/teen/adult).' });
  }

  // Build safe conversation history (last 6 turns max)
  const safeHistory = Array.isArray(history)
    ? history
        .slice(-6)
        .filter(m => m.role && m.content && typeof m.content === 'string')
        .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content.slice(0, 1000) }))
    : [];

  const messages = [
    ...safeHistory,
    { role: 'user', content: message.trim() }
  ];

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: buildSystemPrompt(ageGroup, ageName || ageGroup),
      messages
    });

    const reply = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    res.json({
      reply,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens
      }
    });

  } catch (err) {
    console.error('Anthropic API error:', JSON.stringify(err.error || err.message || err));
    if (err.status === 429) {
      return res.status(429).json({ error: 'Service is busy. Please try in a moment.' });
    }
    res.status(500).json({ error: 'Mitra is temporarily unavailable. Please try again.' });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', name: 'Mitra API', version: '1.0.0' });
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🪔 Mitra backend running on port ${PORT}`);
});
