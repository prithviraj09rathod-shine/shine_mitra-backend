require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1);
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Supabase admin client — SERVICE ROLE KEY, never exposed to the frontend.
// Used only for privileged operations (full account deletion). Optional —
// if these env vars aren't set, account deletion is simply unavailable
// rather than crashing the server.
const supabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

app.use(helmet());

const allowedOrigins = process.env.ALLOWED_ORIGIN
  ? process.env.ALLOWED_ORIGIN.split(',').map(o => o.trim())
  : ['http://localhost:3000','http://localhost:5173','https://mitra-frontend-inky.vercel.app','http://127.0.0.1:5500'];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  methods: ['POST','GET','DELETE'],
  allowedHeaders: ['Content-Type','Authorization']
}));

app.use(express.json({ limit: '16kb' }));

const limiter = rateLimit({
  windowMs: 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment.' }
});
app.use('/api/', limiter);

// ── Mood detection ────────────────────────────────────────────────────────────
// Keyword-matches user message → returns one of 6 mood slugs.
// Frontend uses this to show a contextual image + music suggestion.
function detectMood(message) {
  const m = message.toLowerCase();
  if (/scared|fear|anxi|panic|worry|stress|overwhelm|nervous|terrif|dread/.test(m)) return 'calm';
  if (/fail|reject|loser|mistake|disappoint|can.t do|not good enough|giving up/.test(m))  return 'courage';
  if (/family|parent|mom|dad|mother|father|home|fight|conflict|argument|brother|sister/.test(m)) return 'strength';
  if (/lonely|alone|purpose|meaning|lost|don.t belong|no friends|isolated|worthless/.test(m)) return 'hope';
  if (/right|wrong|dilemma|pressure|peer|should i|what to do|cheat|lie|unfair|justice/.test(m)) return 'wisdom';
  return 'growth';
}

// ── System prompt ─────────────────────────────────────────────────────────────
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
   • Bhagavad Gita (quote chapter/verse) • Ramayana or Mahabharata • Mahatma Gandhi
   • APJ Abdul Kalam • Abraham Lincoln • Nelson Mandela • Rabindranath Tagore
   • Swami Vivekananda • Marcus Aurelius (Meditations) • Viktor Frankl (Man's Search for Meaning)
   • Modern psychology (name the concept/researcher)
   Make it feel like a story a wise friend is sharing — never a lecture.

3. ONE MEANINGFUL QUOTE — Include exactly one powerful quote relevant to their situation, with its source in parentheses.

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

// ── POST /api/mitra ───────────────────────────────────────────────────────────
app.post('/api/mitra', async (req, res) => {
  const { message, ageGroup, ageName, history, voiceEnabled } = req.body;
  if (!message || typeof message !== 'string' || message.trim().length === 0)
    return res.status(400).json({ error: 'Message is required.' });
  if (message.length > 2000)
    return res.status(400).json({ error: 'Message too long.' });
  if (!ageGroup || !['kid','teen','adult'].includes(ageGroup))
    return res.status(400).json({ error: 'Valid ageGroup required (kid/teen/adult).' });

  const safeHistory = Array.isArray(history)
    ? history.slice(-6)
        .filter(m => m.role && m.content && typeof m.content === 'string')
        .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content.slice(0,1000) }))
    : [];

  try {
    // ── Step 1: Get Claude's text reply ──────────────────────────────────────
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: buildSystemPrompt(ageGroup, ageName || ageGroup),
      messages: [...safeHistory, { role: 'user', content: message.trim() }]
    });
    const reply = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const mood  = detectMood(message.trim());

    // ── Step 2: Convert to audio via ElevenLabs (only if requested + configured)
    // voiceEnabled flag comes from the frontend — only true when the user has
    // the voice toggle on, so we never generate audio for text-only users.
    const elevenKey = process.env.ELEVENLABS_API_KEY;
    if (voiceEnabled && elevenKey) {
      try {
        // Voice IDs — pick the one that fits Mitra's persona best.
        // "Aria" (21m00Tcm4TlvDq8ikWAM) is warm and calm.
        // "Matilda" (XrExE9yKIg1WjnnlVkGX) is gentle and caring — ideal for kids.
        // You can preview all voices at elevenlabs.io/voice-lab and swap the ID here.
        const VOICE_ID = ageGroup === 'kid'
          ? 'XrExE9yKIg1WjnnlVkGX'   // Matilda — gentle, calm, kind for children
          : '21m00Tcm4TlvDq8ikWAM';   // Rachel — warm, clear, caring for teens/adults

        const ttsRes = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream`,
          {
            method: 'POST',
            headers: {
              'xi-api-key': elevenKey,
              'Content-Type': 'application/json',
              'Accept': 'audio/mpeg'
            },
            body: JSON.stringify({
              text: reply,
              model_id: 'eleven_multilingual_v2',  // supports English + Indian accents
              voice_settings: {
                stability: 0.55,        // slightly more stable = less variation = calmer
                similarity_boost: 0.80, // stay close to the original voice character
                style: 0.20,            // light expressiveness — warm but not theatrical
                use_speaker_boost: true
              }
            })
          }
        );

        if (ttsRes.ok) {
          // Stream audio directly back to the browser — no temp file needed
          res.setHeader('Content-Type', 'audio/mpeg');
          res.setHeader('X-Mitra-Reply', encodeURIComponent(reply));
          res.setHeader('X-Mitra-Mood', mood);
          res.setHeader('Access-Control-Expose-Headers', 'X-Mitra-Reply, X-Mitra-Mood');
          return ttsRes.body.pipeTo(
            new WritableStream({
              write(chunk) { res.write(chunk); },
              close() { res.end(); }
            })
          ).catch(() => res.end());
        }
        // ElevenLabs returned an error — fall through to text-only response
        console.warn('ElevenLabs TTS error:', ttsRes.status, await ttsRes.text().catch(()=>''));
      } catch (ttsErr) {
        // Network error calling ElevenLabs — fall through gracefully
        console.warn('ElevenLabs TTS network error:', ttsErr.message || ttsErr);
      }
    }

    // ── Step 3: Text-only response (voice off, or ElevenLabs unavailable) ────
    res.json({ reply, mood,
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens }
    });

  } catch (err) {
    console.error('Anthropic API error:', JSON.stringify(err.error || err.message || err));
    if (err.status === 429) return res.status(429).json({ error: 'Service is busy. Please try in a moment.' });
    res.status(500).json({ error: 'Mitra is temporarily unavailable. Please try again.' });
  }
});

app.get('/api/health', (req, res) => res.json({ status:'ok', name:'Mitra API', version:'1.4.0' }));

// ── DELETE /api/account — full account deletion ───────────────────────────────
// Requires the user's own Supabase access token in the Authorization header.
// We verify the token belongs to a real, currently-authenticated user before
// deleting anything — this can only delete the caller's own account, never
// anyone else's. Uses the service-role key, which is why this must live on
// the backend and never in frontend code.
app.delete('/api/account', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Account deletion is not configured on this server.' });
  }
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Missing access token.' });
  }

  try {
    // Verify the token and get the user it belongs to
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return res.status(401).json({ error: 'Invalid or expired session.' });
    }
    // Delete the auth user — this cascades to delete their profile row too
    // (the profiles table has ON DELETE CASCADE on the foreign key to auth.users)
    const { error: delErr } = await supabaseAdmin.auth.admin.deleteUser(userData.user.id);
    if (delErr) {
      console.error('Account deletion error:', delErr.message);
      return res.status(500).json({ error: 'Could not delete account. Please try again.' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Account deletion error:', err.message || err);
    res.status(500).json({ error: 'Could not delete account. Please try again.' });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { console.error(err.stack); res.status(500).json({ error: 'Internal server error' }); });

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🪔 Mitra backend running on port ${PORT}`));
