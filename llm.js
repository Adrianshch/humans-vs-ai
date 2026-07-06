// Local AI engine. Talks to a locally-running Ollama instance so all inference
// happens on the host machine — no commercial API, no data-center calls.
//
// This module is intentionally pluggable: if you later want to move inference
// into each player's browser (WebGPU / WebLLM) to truly distribute the compute,
// you only need to swap the `generate` implementation.

import { FALLBACK_BANK } from './content.js';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
export const MODEL = process.env.OLLAMA_MODEL || 'llama3.2:1b';
const GEN_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 20000);

let _available = null; // cached availability check

// Rough token accounting for the Ethics page. Ollama returns eval counts when
// used; the fallback path estimates ~4 chars/token.
export const usage = { promptTokens: 0, completionTokens: 0, generations: 0, engine: 'fallback' };

export async function checkOllama() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) throw new Error('bad status');
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name);
    const hasModel = models.some((n) => n === MODEL || n.startsWith(MODEL + ':') || n.split(':')[0] === MODEL.split(':')[0]);
    _available = true;
    usage.engine = `ollama:${MODEL}`;
    return { available: true, model: MODEL, models, hasModel };
  } catch {
    _available = false;
    usage.engine = 'fallback';
    return { available: false, model: MODEL, models: [], hasModel: false };
  }
}

export function isAvailable() {
  return _available === true;
}

// Low-level generation. Returns a plain string (never throws — falls back).
// `avoid` is a list of answers already used this round, so the offline fallback
// doesn't hand two bots the identical line.
export async function generate({ system, prompt, temperature = 0.9, maxTokens = 120, avoid = [] }) {
  usage.generations++;
  if (_available !== false) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), GEN_TIMEOUT_MS);
      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: MODEL,
          system,
          prompt,
          stream: false,
          options: { temperature, num_predict: maxTokens, top_p: 0.95 },
        }),
      });
      clearTimeout(t);
      if (res.ok) {
        const data = await res.json();
        _available = true;
        usage.engine = `ollama:${MODEL}`;
        usage.promptTokens += data.prompt_eval_count || 0;
        usage.completionTokens += data.eval_count || 0;
        return (data.response || '').trim();
      }
    } catch {
      // fall through to fallback bank
    }
    _available = false;
    usage.engine = 'fallback';
  }
  return fallbackAnswer(prompt, avoid);
}

// Pick a plausible human-ish answer from the offline bank based on the question,
// preferring one not already used this round.
function fallbackAnswer(prompt, avoid = []) {
  const q = (prompt || '').toLowerCase();
  let pool = FALLBACK_BANK.GENERIC;
  for (const key of Object.keys(FALLBACK_BANK)) {
    if (key === 'GENERIC') continue;
    if (q.includes(key.toLowerCase())) {
      pool = FALLBACK_BANK[key];
      break;
    }
  }
  const taken = new Set(avoid);
  const fresh = pool.filter((a) => !taken.has(a));
  const from = fresh.length ? fresh : pool;
  const pick = from[Math.floor(Math.random() * from.length)];
  usage.completionTokens += Math.ceil(pick.length / 4);
  return pick;
}
