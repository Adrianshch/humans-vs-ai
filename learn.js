// GAN-style learning through gameplay.
//
// The generator = the local Ollama bot. The discriminator = the human voters.
// Reward signal = survival. Every round:
//   - Real human answers are stored as the distribution the generator imitates.
//   - AI answers that SURVIVE a round become positive ("fooled the humans") examples.
//   - AI answers VOTED OUT as AI become penalized negatives ("got detected").
//
// This corpus persists to disk and is fed back into the generator's prompt as
// few-shot conditioning, so bots drift toward human-like answers across matches
// without any weight training. We ALSO append preference pairs to a JSONL file
// so you can run genuine offline fine-tuning (DPO/SFT) later if you want.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const CORPUS_PATH = path.join(DATA_DIR, 'corpus.json');
const TRAIN_PATH = path.join(DATA_DIR, 'train.jsonl');

const CAP = 400; // keep each pool bounded so the file stays laptop-friendly

const empty = () => ({
  humanExamples: [], // { q, text }
  survivors: [], // { q, text }  (AI answers that were NOT voted out)
  caught: [], // { q, text }     (AI answers voted out as AI — penalized)
  stats: { games: 0, rounds: 0, humanAnswers: 0, botsCaught: 0, botsSurvived: 0, generation: 1 },
});

let corpus = empty();
let saveTimer = null;

export function load() {
  try {
    if (fs.existsSync(CORPUS_PATH)) {
      corpus = { ...empty(), ...JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')) };
    }
  } catch {
    corpus = empty();
  }
  return corpus;
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(CORPUS_PATH, JSON.stringify(corpus, null, 2));
    } catch (e) {
      console.error('learn: save failed', e.message);
    }
  }, 400);
}

function push(pool, item) {
  pool.push(item);
  if (pool.length > CAP) pool.splice(0, pool.length - CAP);
}

export function addHumanExample(q, text) {
  if (!text || !text.trim()) return;
  push(corpus.humanExamples, { q, text: text.trim() });
  corpus.stats.humanAnswers++;
  scheduleSave();
}

// Reward / penalty applied when a round resolves.
export function recordOutcome({ q, text, survived }) {
  if (!text || !text.trim()) return;
  const item = { q, text: text.trim() };
  if (survived) {
    push(corpus.survivors, item);
    corpus.stats.botsSurvived++;
  } else {
    push(corpus.caught, item);
    corpus.stats.botsCaught++;
  }
  scheduleSave();
}

// Append a preference pair (chosen = human/survivor, rejected = caught AI) for
// real offline fine-tuning. This is the file you'd feed a DPO/SFT pipeline.
export function exportPreference({ q, chosen, rejected }) {
  if (!chosen || !rejected) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(
      TRAIN_PATH,
      JSON.stringify({ prompt: q, chosen: chosen.trim(), rejected: rejected.trim(), ts: Date.now() }) + '\n'
    );
  } catch {
    /* non-fatal */
  }
}

function sample(pool, q, n) {
  // Prefer examples for the same question, then backfill with random others.
  const same = pool.filter((x) => x.q === q);
  const other = pool.filter((x) => x.q !== q);
  shuffle(same);
  shuffle(other);
  return [...same, ...other].slice(0, n).map((x) => x.text);
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

// Few-shot conditioning fed into the generator's prompt.
export function buildConditioning(q) {
  return {
    humanSamples: sample(corpus.humanExamples, q, 4),
    goodSamples: sample(corpus.survivors, q, 3),
    badSamples: sample(corpus.caught, q, 3),
    generation: corpus.stats.generation,
  };
}

export function noteGameStart() {
  corpus.stats.games++;
  scheduleSave();
}
export function noteRound() {
  corpus.stats.rounds++;
  // Advance a "generation" counter every few rounds — purely cosmetic signal of
  // how much the bots have learned, shown on the Ethics/stats panel.
  if (corpus.stats.rounds % 5 === 0) corpus.stats.generation++;
  scheduleSave();
}

export function stats() {
  return {
    ...corpus.stats,
    corpusSize: corpus.humanExamples.length + corpus.survivors.length + corpus.caught.length,
    humanExamples: corpus.humanExamples.length,
    survivors: corpus.survivors.length,
    caught: corpus.caught.length,
  };
}
