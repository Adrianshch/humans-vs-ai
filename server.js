// Hidden Role Game — server + game engine.
//
// Express serves the static client; `ws` handles realtime. All AI inference is
// local (Ollama via llm.js) with a GAN-style learning loop (learn.js).

import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import { PROMPTS } from './content.js';
import * as llm from './llm.js';
import * as learn from './learn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// ---- Tunable timings (ms) -------------------------------------------------
const T = {
  answer: 60_000,
  vote: 75_000,
  result: 9_000,
  speedTo: 3_000, // when a phase is sped up, jump the clock to now + this
  botVoteMin: 3_000,
  botVoteMax: 13_000,
};
const CALL_VOTES = 2; // "call a vote" button uses per human
const ALIAS_GUESSES = 1; // party-mode alias guesses per human
const MAX_ROUNDS = 14;

// ---- Cosmetics ------------------------------------------------------------
const AVATARS = ['🦊', '🐼', '🦉', '🐙', '🦆', '🐝', '🦋', '🐢', '🦩', '🦇', '🐌', '🦝', '🐧', '🦔', '🐳', '🦥'];
const ADJ = ['Violet', 'Amber', 'Swift', 'Quiet', 'Lucky', 'Brave', 'Jolly', 'Cosmic', 'Fuzzy', 'Salty', 'Neon', 'Rusty', 'Mellow', 'Zany'];
const NOUN = ['Otter', 'Comet', 'Pixel', 'Walrus', 'Maple', 'Ferret', 'Cactus', 'Muffin', 'Falcon', 'Noodle', 'Pebble', 'Gizmo', 'Waffle', 'Badger'];
const BOT_NAMES = ['Alex', 'Sam', 'Jordan', 'Casey', 'Riley', 'Morgan', 'Taylor', 'Jamie', 'Quinn', 'Avery', 'Parker', 'Rowan', 'Skyler', 'Devon'];

const rand = (a) => a[Math.floor(Math.random() * a.length)];
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ---- Rooms ----------------------------------------------------------------
const rooms = new Map(); // code -> room
let quickplayCode = null; // open public classic room waiting for strangers

function makeCode() {
  let c;
  do {
    c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[(Math.random() * 32) | 0]).join('');
  } while (rooms.has(c));
  return c;
}

function makeAlias(room) {
  let a;
  const used = new Set([...room.players.values()].map((p) => p.alias));
  do { a = `${rand(ADJ)} ${rand(NOUN)}`; } while (used.has(a));
  return a;
}

function createRoom({ mode, dev }) {
  const code = makeCode();
  const room = {
    code,
    mode, // 'classic' | 'party'
    dev: !!dev,
    hostId: null,
    phase: 'lobby',
    round: 0,
    players: new Map(),
    order: [],
    prompt: null,
    usedPrompts: new Set(),
    answers: new Map(),
    votes: new Map(),
    chat: [],
    timer: null,
    timerEnd: 0,
    speedVotes: new Set(),
    lastResult: null,
    ending: null,
  };
  rooms.set(code, room);
  return room;
}

function makePlayer({ name, isAI, room }) {
  const idx = room.players.size;
  return {
    id: randomUUID(),
    name: name || (isAI ? rand(BOT_NAMES) : 'Player'),
    alias: makeAlias(room),
    isAI: !!isAI,
    alive: true,
    connected: !isAI,
    ws: null,
    avatar: AVATARS[idx % AVATARS.length],
    isHost: false,
    revealed: false, // identity revealed (after elimination / game end)
    callVotesLeft: CALL_VOTES,
    aliasGuessesLeft: ALIAS_GUESSES,
    // bot fields
    persona: isAI ? rand(['terse', 'chatty', 'sarcastic', 'earnest', 'weird']) : null,
    answeredRound: -1,
    lastAnswer: '',
  };
}

// ---- View / serialization -------------------------------------------------
function displayName(room, p) {
  // Party mode hides real names behind aliases until the game ends.
  if (room.mode === 'party' && room.phase !== 'ended' && !p.revealed) return p.alias;
  return p.name;
}

function stateFor(room, viewerId) {
  const viewer = room.players.get(viewerId);
  const showAnswers = room.phase === 'vote' || room.phase === 'result';
  const answers = showAnswers
    ? [...room.players.values()]
        .filter((p) => p.alive || room.answers.has(p.id)) // hide players eliminated in earlier rounds
        .map((p) => ({
          playerId: p.id,
          name: displayName(room, p),
          avatar: p.avatar,
          text: room.answers.get(p.id) ?? null,
          alive: p.alive,
        }))
    : [];

  const players = room.order
    .map((id) => room.players.get(id))
    .filter(Boolean)
    .map((p) => ({
      id: p.id,
      name: displayName(room, p),
      avatar: p.avatar,
      alive: p.alive,
      connected: p.connected,
      isHost: p.isHost,
      isSelf: p.id === viewerId,
      // Reveal AI/human identity only after elimination or at game end.
      identity: p.revealed || room.phase === 'ended' ? (p.isAI ? 'ai' : 'human') : null,
      votes: room.phase === 'vote' || room.phase === 'result'
        ? [...room.votes.values()].filter((t) => t === p.id).length
        : 0,
    }));

  return {
    type: 'state',
    code: room.code,
    mode: room.mode,
    dev: room.dev,
    phase: room.phase,
    round: room.round,
    maxRounds: MAX_ROUNDS,
    prompt: room.prompt,
    timerEnd: room.timerEnd,
    aiCount: [...room.players.values()].filter((p) => p.isAI).length,
    humanCount: [...room.players.values()].filter((p) => !p.isAI).length,
    players,
    answers,
    chat: room.mode === 'classic' ? room.chat.slice(-60) : [],
    chatEnabled: room.mode === 'classic',
    lastResult: room.lastResult,
    ending: room.ending,
    speedVotes: room.speedVotes.size,
    you: viewer
      ? {
          id: viewer.id,
          name: viewer.name,
          alias: viewer.alias,
          isAI: viewer.isAI,
          alive: viewer.alive,
          isHost: viewer.isHost,
          hasAnswered: room.answers.has(viewer.id),
          hasVoted: room.votes.has(viewer.id),
          callVotesLeft: viewer.callVotesLeft,
          aliasGuessesLeft: viewer.aliasGuessesLeft,
        }
      : null,
    objective: objectiveText(room),
    engine: llm.usage.engine,
    learnStats: learn.stats(),
  };
}

function objectiveText(room) {
  if (room.mode === 'classic') {
    return {
      title: 'Find the AI',
      body: 'Humans: identify and vote out the AI. You win only if you survive to see every AI eliminated. A human wrongly voted out as "AI" loses. AI: blend in and survive.',
    };
  }
  return {
    title: 'Find the Humans',
    body: 'Everyone pretends to be AI. Vote out the real humans — last human standing wins. If all the real AI are voted out first, the humans lose. Guess a friend\'s alias to eliminate them AND a random AI.',
  };
}

function broadcast(room) {
  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === 1) {
      try { p.ws.send(JSON.stringify(stateFor(room, p.id))); } catch { /* ignore */ }
    }
  }
}

function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function sysChat(room, text) { room.chat.push({ system: true, text, ts: Date.now() }); }

// ---- Phase machine --------------------------------------------------------
function clearTimer(room) { if (room.timer) { clearTimeout(room.timer); room.timer = null; } }
function setPhaseTimer(room, ms, fn) {
  clearTimer(room);
  room.timerEnd = Date.now() + ms;
  room.timer = setTimeout(fn, ms);
}

function alivePlayers(room) { return [...room.players.values()].filter((p) => p.alive); }
function aliveHumans(room) { return alivePlayers(room).filter((p) => !p.isAI); }
function aliveAIs(room) { return alivePlayers(room).filter((p) => p.isAI); }

function startGame(room, hostId) {
  const host = room.players.get(hostId);
  if (!host || !host.isHost) return err(host, 'Only the host can start.');
  const humans = [...room.players.values()].filter((p) => !p.isAI).length;
  const ais = [...room.players.values()].filter((p) => p.isAI).length;
  if (ais < 1) return err(host, 'Add at least one AI player.');
  if (!room.dev && humans < 2) return err(host, 'Need at least 2 human players (or enable Dev mode).');
  if (room.players.size < 3) return err(host, 'Need at least 3 players total.');
  learn.noteGameStart();
  room.round = 0;
  enterPrompt(room);
}

function enterPrompt(room) {
  room.round++;
  room.phase = 'prompt';
  room.answers = new Map();
  room.votes = new Map();
  room.speedVotes = new Set();
  room.lastResult = null;
  learn.noteRound();

  // pick an unused prompt
  const available = PROMPTS.map((_, i) => i).filter((i) => !room.usedPrompts.has(i));
  const idx = available.length ? rand(available) : (Math.random() * PROMPTS.length) | 0;
  room.usedPrompts.add(idx);
  room.prompt = PROMPTS[idx];

  broadcast(room);
  // Bots answer asynchronously.
  for (const bot of aliveAIs(room)) generateBotAnswer(room, bot);
  setPhaseTimer(room, T.answer, () => enterVote(room));
}

async function generateBotAnswer(room, bot) {
  const q = room.prompt.q;
  const limit = room.prompt.limit;
  const cond = learn.buildConditioning(q);
  const lines = [];
  if (cond.humanSamples.length) lines.push('Real human answers to similar questions (imitate this vibe):\n' + cond.humanSamples.map((s) => `- ${s}`).join('\n'));
  if (cond.goodSamples.length) lines.push('AI answers that SUCCESSFULLY fooled humans (good, imitate):\n' + cond.goodSamples.map((s) => `- ${s}`).join('\n'));
  if (cond.badSamples.length) lines.push('AI answers that got DETECTED as AI (bad, avoid this style):\n' + cond.badSamples.map((s) => `- ${s}`).join('\n'));

  const system =
    `You are a player in a social deduction game pretending to be an ordinary human. ` +
    `Your goal: answer the question so no one suspects you are an AI, and blend in with real people. ` +
    `Write like a casual person texting: short, specific, a little imperfect. Lowercase is fine, mild typos/slang ok, ` +
    `opinions and personal details are good. Do NOT be encyclopedic, balanced, or overly correct. Never mention being an AI. ` +
    `Persona: ${bot.persona}. Answer in ONE line, at most ${limit} characters. Output ONLY the answer text.`;
  const prompt = `${lines.join('\n\n')}\n\nQuestion: ${q}\n\nYour answer:`;

  const avoid = [...room.answers.values()];
  let text = await llm.generate({ system, prompt, temperature: 0.95, maxTokens: Math.min(140, Math.ceil(limit / 3) + 20), avoid });
  text = cleanAnswer(text, limit);
  // If the bot is still alive & hasn't been superseded, store it.
  bot.lastAnswer = text;
  bot.answeredRound = room.round;
  if (room.phase === 'prompt' || room.phase === 'vote') {
    if (!room.answers.has(bot.id)) {
      room.answers.set(bot.id, text);
      broadcast(room);
    }
  }
}

function cleanAnswer(text, limit) {
  if (!text) return '…';
  text = text.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, ' ').trim();
  // strip a leading "Answer:" the model sometimes adds
  text = text.replace(/^(answer|a)\s*[:\-]\s*/i, '');
  if (text.length > limit) text = text.slice(0, limit - 1).trim() + '…';
  return text || '…';
}

function enterVote(room) {
  room.phase = 'vote';
  room.speedVotes = new Set();
  // Ensure every bot has an answer (fallback if generation was slow).
  for (const bot of aliveAIs(room)) {
    if (!room.answers.has(bot.id)) room.answers.set(bot.id, bot.lastAnswer || '…');
  }
  broadcast(room);
  scheduleBotVotes(room);
  setPhaseTimer(room, T.vote, () => resolveVote(room));
}

function scheduleBotVotes(room) {
  for (const bot of aliveAIs(room)) {
    const delay = T.botVoteMin + Math.random() * (T.botVoteMax - T.botVoteMin);
    setTimeout(() => {
      if (room.phase !== 'vote' || !bot.alive || room.votes.has(bot.id)) return;
      const target = botPickVote(room, bot);
      if (target) {
        room.votes.set(bot.id, target);
        broadcast(room);
      }
    }, delay);
  }
}

// Heuristic "how AI does this read" score (higher = more AI-like). Cheap on
// purpose — we spend the compute budget on generation, not voting.
function aiScore(text) {
  if (!text) return 0;
  let s = 0;
  const words = text.split(/\s+/).length;
  if (words > 28) s += 2; else if (words > 18) s += 1;
  if (/^[A-Z]/.test(text) && /[.!?]$/.test(text)) s += 1; // tidy capitalization+punctuation
  if (/\b(however|therefore|furthermore|essentially|typically|generally|it is important|as an)\b/i.test(text)) s += 2;
  if (/,/.test(text) && text.split(',').length > 3) s += 1; // listy/clausey
  if (!/[a-z]/.test(text.replace(/[A-Z]/g, ''))) { /* noop */ }
  if (/\b(lol|lmao|idk|tbh|haha|ngl|imo|bro|honestly)\b/i.test(text)) s -= 2; // casual slang = human
  if (/[a-z]/.test(text[0] || '')) s -= 1; // lowercase start = casual
  if (text.length < 25) s -= 1;
  return s;
}

function botPickVote(room, bot) {
  const candidates = alivePlayers(room).filter((p) => p.id !== bot.id);
  if (!candidates.length) return null;
  const scored = candidates.map((p) => ({ p, score: aiScore(room.answers.get(p.id)) + (Math.random() * 2 - 1) }));
  // Classic (find AI): target the most AI-looking. Party (find humans): target the least AI-looking (most human).
  scored.sort((a, b) => (room.mode === 'classic' ? b.score - a.score : a.score - b.score));
  return scored[0].p.id;
}

function resolveVote(room) {
  clearTimer(room);
  // Tally
  const tally = new Map();
  for (const t of room.votes.values()) tally.set(t, (tally.get(t) || 0) + 1);
  let top = null, topN = 0, tie = false;
  for (const [pid, n] of tally) {
    if (n > topN) { top = pid; topN = n; tie = false; }
    else if (n === topN) tie = true;
  }

  let eliminated = null;
  if (top && topN > 0 && !tie) {
    eliminated = room.players.get(top);
    if (eliminated) { eliminated.alive = false; eliminated.revealed = true; }
  }

  applyLearning(room, eliminated);

  room.lastResult = {
    eliminated: eliminated
      ? { id: eliminated.id, name: eliminated.name, alias: eliminated.alias, avatar: eliminated.avatar, wasAI: eliminated.isAI }
      : null,
    tie: !!tie && !eliminated,
    tally: [...tally.entries()].map(([pid, n]) => ({ pid, n })),
  };
  room.phase = 'result';
  if (room.mode === 'classic') {
    if (eliminated) sysChat(room, `${eliminated.name} was voted out — they were ${eliminated.isAI ? 'an AI 🤖' : 'a human 🧑'}.`);
    else sysChat(room, 'Hung vote — nobody was eliminated.');
  }
  broadcast(room);

  const ending = checkEnd(room);
  if (ending) { room.ending = ending; return endGame(room); }
  setPhaseTimer(room, T.result, () => {
    if (room.round >= MAX_ROUNDS) { room.ending = endByStanding(room); return endGame(room); }
    enterPrompt(room);
  });
}

// GAN-style reward: store human answers, reward survivors, penalize the caught.
function applyLearning(room, eliminated) {
  const q = room.prompt.q;
  const humanAnswers = [];
  for (const p of room.players.values()) {
    const text = room.answers.get(p.id);
    if (!text) continue;
    if (!p.isAI) { learn.addHumanExample(q, text); humanAnswers.push(text); }
  }
  for (const bot of [...room.players.values()].filter((p) => p.isAI)) {
    const text = room.answers.get(bot.id);
    if (!text) continue;
    const caught = eliminated && eliminated.id === bot.id;
    // "survived" only counts for bots that were actually in the round & alive before the vote
    learn.recordOutcome({ q, text, survived: !caught });
    if (caught && humanAnswers.length) {
      learn.exportPreference({ q, chosen: rand(humanAnswers), rejected: text });
    }
  }
}

function checkEnd(room) {
  const humans = aliveHumans(room).length;
  const ais = aliveAIs(room).length;
  if (room.mode === 'classic') {
    if (ais === 0) return { result: 'humans', title: 'Humans win! 🧑', body: 'Every AI was found and eliminated.' };
    if (room.dev && humans === 0) return { result: 'ai', title: 'AI win 🤖', body: 'The last human was voted out.' };
    if (!room.dev && ais >= humans) return { result: 'ai', title: 'AI win 🤖', body: 'The AI reached parity — humans can no longer out-vote them.' };
    return null;
  }
  // party — find the humans
  if (ais === 0) return { result: 'ai', title: 'Humans lose 🤖', body: 'All the real AI were voted out first — humans lose by default.' };
  if (humans <= 1) {
    const last = aliveHumans(room)[0];
    return { result: 'human', title: 'Last human standing! 🧑', body: last ? `${last.name} survived as the final human.` : 'The humans are gone.' };
  }
  return null;
}

function endByStanding(room) {
  const humans = aliveHumans(room).length;
  const ais = aliveAIs(room).length;
  if (room.mode === 'classic') {
    return ais < humans
      ? { result: 'humans', title: 'Round limit — humans ahead 🧑', body: 'Time ran out with humans outnumbering AI.' }
      : { result: 'ai', title: 'Round limit — AI survive 🤖', body: 'The AI blended in until the end.' };
  }
  return { result: 'human', title: 'Round limit reached', body: `${humans} human(s) survived to the end.` };
}

function endGame(room) {
  clearTimer(room);
  room.phase = 'ended';
  for (const p of room.players.values()) p.revealed = true;
  broadcast(room);
}

// ---- Actions --------------------------------------------------------------
function err(p, message) { if (p && p.ws) send(p.ws, { type: 'error', message }); }

function submitAnswer(room, p, text) {
  if (room.phase !== 'prompt' || !p.alive) return;
  text = cleanAnswer(String(text || ''), room.prompt.limit);
  room.answers.set(p.id, text);
  broadcast(room);
  // If every alive human has answered, jump the clock.
  const humans = aliveHumans(room);
  if (humans.every((h) => room.answers.has(h.id))) speedClock(room);
}

function submitVote(room, p, targetId) {
  if (room.phase !== 'vote' || !p.alive) return;
  if (!room.players.has(targetId)) return;
  const target = room.players.get(targetId);
  if (!target.alive) return;
  room.votes.set(p.id, targetId);
  broadcast(room);
  if (aliveHumans(room).every((h) => room.votes.has(h.id))) resolveVote(room);
}

function speedUp(room, p) {
  if (room.phase !== 'prompt' && room.phase !== 'vote') return;
  room.speedVotes.add(p.id);
  const humans = aliveHumans(room);
  if (room.speedVotes.size >= Math.ceil(humans.length / 2)) speedClock(room);
  broadcast(room);
}

function speedClock(room) {
  if (!room.timer) return;
  const remaining = room.timerEnd - Date.now();
  if (remaining <= T.speedTo) return;
  const fn = room.phase === 'prompt' ? () => enterVote(room) : () => resolveVote(room);
  setPhaseTimer(room, T.speedTo, fn);
  broadcast(room);
}

function callVote(room, p) {
  if (p.callVotesLeft <= 0) return err(p, 'No call-vote uses left.');
  if (room.phase === 'prompt') { p.callVotesLeft--; enterVote(room); }
  else if (room.phase === 'vote') { p.callVotesLeft--; resolveVote(room); }
}

function chat(room, p, text) {
  if (room.mode !== 'classic') return;
  text = String(text || '').slice(0, 240).trim();
  if (!text) return;
  room.chat.push({ from: displayName(room, p), avatar: p.avatar, text, ts: Date.now() });
  broadcast(room);
}

// Party twist: a human guesses a friend's real name from their alias.
function guessAlias(room, p, targetId, guessedName) {
  if (room.mode !== 'party') return;
  if (room.phase !== 'vote' && room.phase !== 'prompt') return err(p, 'You can only guess during a round.');
  if (p.aliasGuessesLeft <= 0) return err(p, 'No alias guesses left.');
  const target = room.players.get(targetId);
  if (!target || !target.alive || target.id === p.id) return err(p, 'Pick a living player.');
  p.aliasGuessesLeft--;
  const correct = !target.isAI && normalize(target.name) === normalize(guessedName);
  if (correct) {
    target.alive = false; target.revealed = true;
    const someAI = shuffle(aliveAIs(room))[0];
    if (someAI) { someAI.alive = false; someAI.revealed = true; }
    room.lastResult = {
      guess: { by: p.alias, hit: target.name, ai: someAI ? someAI.name : null },
      eliminated: { id: target.id, name: target.name, alias: target.alias, avatar: target.avatar, wasAI: false },
    };
    room.phase = 'result';
    broadcast(room);
    const ending = checkEnd(room);
    if (ending) { room.ending = ending; return endGame(room); }
    setPhaseTimer(room, T.result, () => enterPrompt(room));
  } else {
    err(p, `Wrong guess — "${guessedName}" is not ${target.alias}.`);
    broadcast(room);
  }
}
const normalize = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

function addBots(room, n) {
  for (let i = 0; i < n; i++) {
    if (room.players.size >= 12) break;
    const bot = makePlayer({ isAI: true, room });
    room.players.set(bot.id, bot);
    room.order.push(bot.id);
  }
}
function removeBots(room, n) {
  const bots = [...room.players.values()].filter((p) => p.isAI);
  for (let i = 0; i < n && bots.length; i++) {
    const bot = bots.pop();
    room.players.delete(bot.id);
    room.order = room.order.filter((id) => id !== bot.id);
  }
}

// ---- HTTP + WS ------------------------------------------------------------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/health', async (req, res) => {
  const o = await llm.checkOllama();
  res.json({ ok: true, ollama: o, learn: learn.stats() });
});
app.get('/api/stats', (req, res) => res.json({ engine: llm.usage.engine, usage: llm.usage, learn: learn.stats() }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.meta = { code: null, playerId: null };
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    handle(ws, msg);
  });
  ws.on('close', () => {
    const { code, playerId } = ws.meta;
    const room = rooms.get(code);
    if (!room) return;
    const p = room.players.get(playerId);
    if (p) { p.connected = false; p.ws = null; }
    // Clean up empty rooms.
    if (![...room.players.values()].some((x) => !x.isAI && x.connected)) {
      if (room.phase === 'lobby' || room.phase === 'ended') {
        clearTimer(room);
        rooms.delete(code);
        if (quickplayCode === code) quickplayCode = null;
        return;
      }
    }
    broadcast(room);
  });
});

function join(ws, room, player) {
  ws.meta = { code: room.code, playerId: player.id };
  player.ws = ws;
  player.connected = true;
  send(ws, { type: 'joined', code: room.code, playerId: player.id });
  broadcast(room);
}

function handle(ws, msg) {
  const room = () => rooms.get(ws.meta.code);
  const me = () => room()?.players.get(ws.meta.playerId);

  switch (msg.type) {
    case 'create': {
      const r = createRoom({ mode: msg.mode === 'party' ? 'party' : 'classic', dev: !!msg.dev });
      const p = makePlayer({ name: (msg.name || 'Host').slice(0, 20), isAI: false, room: r });
      p.isHost = true;
      r.hostId = p.id;
      r.players.set(p.id, p);
      r.order.push(p.id);
      addBots(r, Math.max(1, Math.min(9, msg.bots ?? 3)));
      join(ws, r, p);
      break;
    }
    case 'join': {
      const r = rooms.get(String(msg.code || '').toUpperCase());
      if (!r) return send(ws, { type: 'error', message: 'No game with that code.' });
      if (r.phase !== 'lobby') return send(ws, { type: 'error', message: 'That game already started.' });
      if (r.players.size >= 12) return send(ws, { type: 'error', message: 'That game is full.' });
      const p = makePlayer({ name: (msg.name || 'Player').slice(0, 20), isAI: false, room: r });
      r.players.set(p.id, p);
      r.order.push(p.id);
      join(ws, r, p);
      break;
    }
    case 'quickplay': {
      // Among-Us-style: drop into an open public classic room, or open a new one.
      let r = quickplayCode && rooms.get(quickplayCode);
      if (!r || r.phase !== 'lobby' || r.players.size >= 8) {
        r = createRoom({ mode: 'classic', dev: false });
        addBots(r, 3);
        quickplayCode = r.code;
      }
      const first = r.players.size === [...r.players.values()].filter((x) => x.isAI).length; // only bots so far
      const p = makePlayer({ name: (msg.name || 'Player').slice(0, 20), isAI: false, room: r });
      if (first) { p.isHost = true; r.hostId = p.id; }
      r.players.set(p.id, p);
      r.order.push(p.id);
      join(ws, r, p);
      break;
    }
    case 'config': {
      const r = room(); const p = me();
      if (!r || !p?.isHost || r.phase !== 'lobby') return;
      if (typeof msg.bots === 'number') {
        const current = [...r.players.values()].filter((x) => x.isAI).length;
        const want = Math.max(1, Math.min(9, msg.bots));
        if (want > current) addBots(r, want - current);
        else if (want < current) removeBots(r, current - want);
      }
      if (msg.mode === 'classic' || msg.mode === 'party') r.mode = msg.mode;
      if (typeof msg.dev === 'boolean') r.dev = msg.dev;
      // party mode needs fresh aliases
      broadcast(r);
      break;
    }
    case 'start': { const r = room(); if (r) startGame(r, ws.meta.playerId); break; }
    case 'answer': { const r = room(), p = me(); if (r && p) submitAnswer(r, p, msg.text); break; }
    case 'vote': { const r = room(), p = me(); if (r && p) submitVote(r, p, msg.targetId); break; }
    case 'speedup': { const r = room(), p = me(); if (r && p) speedUp(r, p); break; }
    case 'callvote': { const r = room(), p = me(); if (r && p) callVote(r, p); break; }
    case 'chat': { const r = room(), p = me(); if (r && p) chat(r, p, msg.text); break; }
    case 'guess': { const r = room(), p = me(); if (r && p) guessAlias(r, p, msg.targetId, msg.name); break; }
    case 'playagain': {
      const r = room(), p = me();
      if (!r || !p?.isHost || r.phase !== 'ended') return;
      // reset players, keep humans, respawn bots with new aliases
      const humans = [...r.players.values()].filter((x) => !x.isAI);
      const botCount = [...r.players.values()].filter((x) => x.isAI).length;
      r.players.clear(); r.order = []; r.usedPrompts = new Set(); r.chat = []; r.ending = null; r.lastResult = null;
      for (const h of humans) {
        h.alive = true; h.revealed = false; h.callVotesLeft = CALL_VOTES; h.aliasGuessesLeft = ALIAS_GUESSES;
        h.alias = makeAlias(r); h.answeredRound = -1;
        r.players.set(h.id, h); r.order.push(h.id);
      }
      addBots(r, botCount);
      r.phase = 'lobby'; r.round = 0;
      broadcast(r);
      break;
    }
    default: break;
  }
}

// ---- Boot -----------------------------------------------------------------
learn.load();
const ol = await llm.checkOllama();
server.listen(PORT, () => {
  console.log(`\n  Hidden Role Game running →  http://localhost:${PORT}\n`);
  if (ol.available && ol.hasModel) console.log(`  AI engine: Ollama (${ol.model}) — local, on this machine.`);
  else if (ol.available && !ol.hasModel) console.log(`  Ollama is up but model "${ol.model}" isn't pulled. Run:  ollama pull ${ol.model}`);
  else console.log(`  Ollama not detected — using the offline answer bank. Install from https://ollama.com to get real local AI bots.`);
  console.log('');
});
