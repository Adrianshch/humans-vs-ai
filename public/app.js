// Client for the Hidden Role Game. Vanilla JS, single WebSocket, render-from-state.
const $ = (id) => document.getElementById(id);
const el = (sel) => document.querySelector(sel);
const els = (sel) => document.querySelectorAll(sel);

let ws = null;
let me = null; // {code, playerId}
let state = null;
let selectedVote = null;
let timerRAF = null;

// ---- WebSocket ----
function connect(onOpen) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => onOpen && onOpen();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'joined') { me = { code: msg.code, playerId: msg.playerId }; }
    else if (msg.type === 'state') { state = msg; render(); }
    else if (msg.type === 'error') { toast(msg.message); }
  };
  ws.onclose = () => toast('Disconnected from server.');
}
function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function ensure(onReady) { if (ws && ws.readyState === 1) onReady(); else connect(onReady); }

// ---- Screens ----
function show(screen) { els('.screen').forEach((s) => s.classList.remove('active')); $(screen).classList.add('active'); }

// ---- Home actions ----
$('btn-quickplay').onclick = () => {
  const name = nameVal();
  ensure(() => send({ type: 'quickplay', name }));
};
$('btn-create').onclick = () => {
  const name = nameVal();
  ensure(() => send({ type: 'create', name, mode: $('mode').value, bots: +$('bots').value, dev: $('dev').checked }));
};
$('btn-join').onclick = () => {
  const code = $('join-code').value.trim().toUpperCase();
  if (!code) return toast('Enter a room code.');
  ensure(() => send({ type: 'join', code, name: nameVal() }));
};
$('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });
function nameVal() { return ($('name').value || '').trim() || 'Player'; }

// ---- Lobby actions ----
$('btn-start').onclick = () => send({ type: 'start' });
$('copy-code').onclick = () => {
  const url = `${location.origin}/?code=${state.code}`;
  navigator.clipboard?.writeText(url).then(() => toast('Invite link copied!'));
};
$('lobby-mode').onchange = () => send({ type: 'config', mode: $('lobby-mode').value });
$('lobby-bots').onchange = () => send({ type: 'config', bots: +$('lobby-bots').value });
$('lobby-dev').onchange = () => send({ type: 'config', dev: $('lobby-dev').checked });

// ---- Game actions ----
$('btn-answer').onclick = () => {
  const text = $('answer-input').value.trim();
  if (!text) return toast('Type something first.');
  send({ type: 'answer', text });
};
$('answer-input').addEventListener('input', () => {
  const lim = state?.prompt?.limit || 250;
  const n = $('answer-input').value.length;
  $('char-count').textContent = `${n}/${lim}`;
  $('char-count').style.color = n > lim ? 'var(--ai)' : '';
});
$('btn-speed').onclick = () => send({ type: 'speedup' });
$('btn-callvote').onclick = () => send({ type: 'callvote' });
$('btn-chat').onclick = sendChat;
$('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
function sendChat() {
  const text = $('chat-input').value.trim();
  if (!text) return;
  send({ type: 'chat', text });
  $('chat-input').value = '';
}

// ---- Ended actions ----
$('btn-again').onclick = () => send({ type: 'playagain' });
$('btn-home').onclick = () => location.href = '/';

// ---- Ethics modal ----
els('.ethics-open').forEach((b) => (b.onclick = openEthics));
els('.ethics-close').forEach((b) => (b.onclick = () => $('ethics').classList.remove('open')));
$('ethics').addEventListener('click', (e) => { if (e.target.id === 'ethics') $('ethics').classList.remove('open'); });
async function openEthics() {
  $('ethics').classList.add('open');
  try {
    const r = await fetch('/api/stats').then((x) => x.json());
    renderEthics(r);
  } catch { renderEthics(null); }
}
function renderEthics(r) {
  const u = r?.usage || {};
  const L = r?.learn || {};
  const engine = r?.engine || 'unknown';
  const local = engine.startsWith('ollama');
  const gens = u.generations || 0;
  const toks = (u.completionTokens || 0) + (u.promptTokens || 0);
  // Very rough, deliberately conservative energy estimate for a tiny local model.
  const wh = (u.completionTokens || 0) * 0.00003; // ~0.03 mWh per token on a small local model
  $('eth-live').innerHTML = [
    ['🤖', gens, 'AI answers generated'],
    ['🔤', toks.toLocaleString(), 'tokens (this server run)'],
    ['⚡', wh < 0.01 ? '<0.01' : wh.toFixed(2), 'Wh est. AI energy'],
    ['💧', '0', 'mL data-center water'],
    ['🧠', L.corpusSize ?? 0, 'learned examples'],
    ['📈', 'gen ' + (L.generation ?? 1), 'bot learning stage'],
  ].map(([e, n, l]) => `<div class="eth-stat"><div class="n">${e} ${n}</div><div class="l">${l}</div></div>`).join('');
  const line = $('eth-engine');
  line.className = 'engine-line ' + (local ? 'local' : 'fallback');
  line.innerHTML = local
    ? `✅ <b>Local model active:</b> <code>${engine}</code> running on this machine via Ollama. Zero cloud calls.`
    : `⚠️ <b>Offline answer bank</b> in use (Ollama not detected). No AI compute at all right now — install <a href="https://ollama.com" target="_blank" rel="noopener">Ollama</a> for real local bots.`;
}

// ---- Render ----
function render() {
  if (!state) return;
  const phase = state.phase;
  if (phase === 'lobby') { renderLobby(); show('lobby'); }
  else if (phase === 'ended') { renderEnded(); show('ended'); }
  else { renderGame(); show('game'); }
}

function renderLobby() {
  $('lobby-code').textContent = state.code;
  const o = state.objective;
  $('lobby-obj').innerHTML = `<h4>🎯 ${o.title}</h4><p>${o.body}</p>`;
  $('lobby-players').innerHTML = state.players.map(pcard).join('');
  const isHost = state.you?.isHost;
  $('host-controls').classList.toggle('hidden', !isHost);
  $('wait-host').classList.toggle('hidden', !!isHost);
  if (isHost) {
    $('lobby-mode').value = state.mode;
    $('lobby-dev').checked = state.dev;
    $('lobby-bots').value = String(state.aiCount);
  }
}
function pcard(p) {
  const cls = ['pcard'];
  if (p.isHost) cls.push('host');
  if (p.isSelf) cls.push('you');
  if (!p.alive) cls.push('dead');
  let badge = '';
  if (p.identity === 'ai') badge = '<span class="badge ai">🤖 AI</span>';
  else if (p.identity === 'human') badge = '<span class="badge human">🧑 Human</span>';
  else if (p.isHost) badge = '<span class="badge host">HOST</span>';
  return `<div class="${cls.join(' ')}"><div class="av">${p.avatar}</div><div class="pn">${esc(p.name)}${p.isSelf ? ' (you)' : ''}</div>${badge}</div>`;
}

let localTimerEnd = 0;
function renderGame() {
  const s = state;
  $('round-pill').textContent = `Round ${s.round}/${s.maxRounds}`;
  const phaseName = { prompt: '✍️ Answering', vote: '🗳️ Voting', result: '📊 Results' }[s.phase] || s.phase;
  $('phase-pill').textContent = phaseName;
  const y = s.you;
  $('you-pill').innerHTML = y ? `You: ${y.name} ${y.alive ? '' : '💀'} · 📣${y.callVotesLeft}${s.mode === 'party' ? ` · 🔍${y.aliasGuessesLeft}` : ''}` : '';

  // prompt
  $('prompt-box').innerHTML = s.prompt ? `<span class="qmark">Prompt · ${s.prompt.limit} char max</span>${esc(s.prompt.q)}` : '';

  // timer
  localTimerEnd = s.timerEnd;
  runTimer();

  // panels
  const answering = s.phase === 'prompt';
  $('answer-panel').classList.toggle('hidden', !answering);
  $('answers-panel').classList.toggle('hidden', answering);

  if (answering) renderAnswerPanel();
  else renderAnswersPanel();

  // side players
  $('game-players').innerHTML = s.players.map((p) => {
    const cls = ['sp']; if (!p.alive) cls.push('dead');
    const vc = p.votes ? `<span class="vc">🗳️ ${p.votes}</span>` : '';
    return `<div class="${cls.join(' ')}"><span class="av">${p.avatar}</span><span>${esc(p.name)}${p.isSelf ? ' (you)' : ''}</span>${vc}</div>`;
  }).join('');

  // chat
  $('chat-box').classList.toggle('hidden', !s.chatEnabled);
  if (s.chatEnabled) {
    const log = $('chat-log');
    log.innerHTML = s.chat.map((m) => m.system
      ? `<div class="msg sys">${esc(m.text)}</div>`
      : `<div class="msg"><span class="mfrom">${esc(m.from)}:</span> ${esc(m.text)}</div>`).join('');
    log.scrollTop = log.scrollHeight;
  }
}

function renderAnswerPanel() {
  const answered = state.you?.hasAnswered;
  const dead = !state.you?.alive;
  $('answer-input').disabled = answered || dead;
  $('btn-answer').disabled = answered || dead;
  $('answered-note').classList.toggle('hidden', !answered);
  const lim = state.prompt?.limit || 250;
  $('answer-input').maxLength = lim;
  if (!answered) $('char-count').textContent = `${$('answer-input').value.length}/${lim}`;
  $('btn-callvote').disabled = (state.you?.callVotesLeft ?? 0) <= 0 || dead;
  if (dead) { $('answer-input').placeholder = "You've been eliminated — spectating."; }
}

function renderAnswersPanel() {
  const s = state;
  const isVote = s.phase === 'vote';
  const canAct = isVote && s.you?.alive && !s.you?.hasVoted;
  let head = '';
  if (isVote) {
    head = s.mode === 'classic'
      ? `<p class="vote-hint">Tap the answer you think came from an <b style="color:var(--ai)">AI</b>, then it's your vote. ${s.you?.hasVoted ? '✅ You voted.' : ''}</p>`
      : `<p class="vote-hint">Everyone's pretending to be AI — vote out whoever seems most <b style="color:var(--human)">human</b>. ${s.you?.hasVoted ? '✅ You voted.' : ''}</p>`;
  } else if (s.lastResult) {
    head = renderResult(s.lastResult);
  }

  const list = s.answers.map((a) => {
    const cls = ['ans'];
    if (!a.alive) cls.push('dead');
    if (a.playerId === s.you?.id) cls.push('self');
    if (selectedVote === a.playerId) cls.push('selected');
    const idPlayer = s.players.find((p) => p.id === a.playerId);
    let idTag = '';
    if (idPlayer?.identity === 'ai') idTag = '<span class="id-ai">🤖 AI</span>';
    else if (idPlayer?.identity === 'human') idTag = '<span class="id-human">🧑 Human</span>';
    const votes = (idPlayer?.votes || 0) > 0 ? `<span class="votes">🗳️ ${idPlayer.votes}</span>` : '';
    const clickable = canAct && a.playerId !== s.you?.id && a.alive;
    return `<div class="${cls.join(' ')}" ${clickable ? `data-vote="${a.playerId}"` : ''}>
      <div class="av">${a.avatar}</div>
      <div class="body">
        <div class="who">${esc(a.name)}${a.playerId === s.you?.id ? ' (you)' : ''} ${idTag} ${votes}</div>
        <div class="txt">${a.text != null ? esc(a.text) : '<i style="color:var(--muted)">— no answer —</i>'}</div>
      </div>
    </div>`;
  }).join('');

  let controls = '';
  if (isVote && s.you?.alive) {
    controls = `<div class="row between" style="margin-top:14px">
      <span class="muted">${s.mode === 'party' ? partyGuessBtn() : ''}</span>
      <div class="row gap">
        <button class="ghost" onclick="send({type:'speedup'})">⏩ Speed up (${s.speedVotes})</button>
        <button class="ghost" ${(s.you.callVotesLeft ?? 0) <= 0 ? 'disabled' : ''} onclick="send({type:'callvote'})">📣 Force vote (${s.you.callVotesLeft})</button>
        <button class="primary" ${!selectedVote ? 'disabled' : ''} onclick="castVote()">Lock vote</button>
      </div>
    </div>`;
  }

  $('answers-panel').innerHTML = head + `<div class="answers-list">${list}</div>` + controls;
  els('#answers-panel [data-vote]').forEach((n) => n.addEventListener('click', () => {
    selectedVote = n.getAttribute('data-vote');
    renderAnswersPanel();
  }));
}

function partyGuessBtn() {
  if ((state.you?.aliasGuessesLeft ?? 0) <= 0) return '<span class="muted">No alias guesses left</span>';
  return `<button class="ghost" onclick="openGuess()">🔍 Guess a friend's alias (${state.you.aliasGuessesLeft})</button>`;
}
window.openGuess = function () {
  const alive = state.players.filter((p) => p.alive && !p.isSelf);
  const alias = prompt('Which alias do you think is one of your friends? Type their exact alias:\n\n' + alive.map((p) => '• ' + p.name).join('\n'));
  if (!alias) return;
  const target = alive.find((p) => p.name.toLowerCase() === alias.trim().toLowerCase());
  if (!target) return toast('No living player with that alias.');
  const real = prompt(`What is ${target.name}'s REAL name?`);
  if (!real) return;
  send({ type: 'guess', targetId: target.id, name: real });
};

window.castVote = function () {
  if (!selectedVote) return;
  send({ type: 'vote', targetId: selectedVote });
  selectedVote = null;
};
window.send = send;

function renderResult(r) {
  if (r.guess) {
    return `<div class="prompt-box" style="font-size:16px">🔍 <b>${esc(r.guess.by)}</b> correctly unmasked <b style="color:var(--human)">${esc(r.guess.hit)}</b>!${r.guess.ai ? ` A random AI (<b style="color:var(--ai)">${esc(r.guess.ai)}</b>) was eliminated too.` : ''}</div>`;
  }
  if (r.tie) return `<div class="prompt-box" style="font-size:16px">🤝 Hung vote — nobody was eliminated this round.</div>`;
  if (r.eliminated) {
    const e = r.eliminated;
    return `<div class="prompt-box" style="font-size:16px">${e.avatar} <b>${esc(e.name)}</b> was voted out — they were <b style="color:${e.wasAI ? 'var(--ai)' : 'var(--human)'}">${e.wasAI ? 'an AI 🤖' : 'a human 🧑'}</b>.</div>`;
  }
  return '';
}

function renderEnded() {
  const e = state.ending || {};
  const emoji = e.result === 'humans' || e.result === 'human' ? '🧑🎉' : '🤖';
  $('end-emoji').textContent = emoji;
  $('end-title').textContent = e.title || 'Game over';
  $('end-body').textContent = e.body || '';
  $('end-reveal').innerHTML = state.players.map(pcard).join('');
  $('btn-again').classList.toggle('hidden', !state.you?.isHost);
}

// ---- Timer ----
function runTimer() {
  cancelAnimationFrame(timerRAF);
  const total = { prompt: 60, vote: 75, result: 9 }[state.phase] || 60;
  const tick = () => {
    const left = Math.max(0, localTimerEnd - Date.now());
    const secs = Math.ceil(left / 1000);
    $('timer-txt').textContent = secs;
    $('timer-fill').style.width = Math.min(100, (left / 1000 / total) * 100) + '%';
    if (left > 0) timerRAF = requestAnimationFrame(tick);
  };
  tick();
}

// ---- Utils ----
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// ---- Deep link ?code=XXXX ----
(function () {
  const code = new URLSearchParams(location.search).get('code');
  if (code) $('join-code').value = code.toUpperCase();
})();

// ---- Startup guard: make sure we're being served by the running server ----
function showWarn(msg) {
  const w = $('startup-warn');
  if (!w) return;
  $('sw-msg').textContent = msg;
  w.classList.remove('hidden');
}
(function boot() {
  if (location.protocol === 'file:') {
    showWarn('You opened index.html directly as a file — so there is no game server, no styling, and the buttons can\'t work.');
    return;
  }
  // Confirm the backend that powers the game is actually reachable on this page.
  fetch('/api/health')
    .then((r) => { if (!r.ok) throw new Error('bad'); })
    .catch(() => showWarn('This page loaded, but the game server is not responding here. Start it and use http://localhost:3000.'));
})();
