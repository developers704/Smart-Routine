/**
 * Deterministic math-wake questions.
 *
 * Generation is keyed on (alarmId, nonce, questionIndex, difficulty) so the
 * question stays stable while a challenge is active. The expected answer is
 * never written into JS app state, logs or diagnostics — native code validates
 * submissions. This module exists so tests can prove the generator, and so the
 * Swift copy in WakeChallengeService.swift can stay in lockstep.
 *
 * Algorithm (must match WakeChallengeService.swift):
 *   seed = fnv1a32(`${alarmId}|${nonce}|${questionIndex}|${difficulty}`)
 *   rng  = mulberry32(seed)
 */

const DIFFICULTIES = new Set(["easy", "medium", "hard"]);

export function fnv1a32(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — returns [0, 1). Seed is a uint32. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickInt(rnd, min, max) {
  return min + Math.floor(rnd() * (max - min + 1));
}

function addOrSub(rnd, min, max) {
  const op = rnd() < 0.5 ? "+" : "-";
  let a = pickInt(rnd, min, max);
  let b = pickInt(rnd, min, max);
  if (op === "-" && a < b) {
    const t = a;
    a = b;
    b = t;
  }
  return { question: `${a} ${op} ${b}`, answer: op === "+" ? a + b : a - b };
}

/**
 * @returns {{ question: string, answer: number, difficulty: string }}
 */
export function generateMathQuestion(alarmId, nonce, questionIndex, difficulty = "medium") {
  const level = DIFFICULTIES.has(difficulty) ? difficulty : "medium";
  const seed = fnv1a32(`${alarmId}|${nonce}|${questionIndex}|${level}`);
  const rnd = mulberry32(seed);

  if (level === "easy") return { ...addOrSub(rnd, 1, 50), difficulty: level };
  if (level === "medium") return { ...addOrSub(rnd, 10, 99), difficulty: level };

  const kind = rnd();
  if (kind < 1 / 3) {
    const a = pickInt(rnd, 1, 12);
    const b = pickInt(rnd, 1, 12);
    return { question: `${a} × ${b}`, answer: a * b, difficulty: level };
  }
  return { ...addOrSub(rnd, 10, 99), difficulty: level };
}

export function parseSubmittedAnswer(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * In-memory challenge session used by tests and as the spec for the native
 * service. The answer lives only inside this object — `publicView` strips it.
 */
export function createWakeChallenge({
  alarmId,
  difficulty = "medium",
  questionCount = 1,
  nonce,
} = {}) {
  if (!alarmId) throw new Error("alarmId is required");
  const count = Math.min(3, Math.max(1, Math.round(Number(questionCount) || 1)));
  const n = nonce == null ? fnv1a32(`${alarmId}|${Date.now()}`) : String(nonce);
  const questions = [];
  for (let i = 0; i < count; i++) {
    questions.push(generateMathQuestion(alarmId, n, i, difficulty));
  }
  return {
    alarmId: String(alarmId),
    nonce: String(n),
    difficulty: DIFFICULTIES.has(difficulty) ? difficulty : "medium",
    questionCount: count,
    questionIndex: 0,
    attempts: 0,
    questions,
    complete: false,
  };
}

export function publicChallengeView(challenge) {
  if (!challenge) return { active: false };
  const q = challenge.questions[challenge.questionIndex];
  return {
    active: !challenge.complete,
    alarmId: challenge.alarmId,
    question: q?.question ?? null,
    questionNumber: challenge.questionIndex + 1,
    questionCount: challenge.questionCount,
    attempts: challenge.attempts,
  };
}

export function submitChallengeAnswer(challenge, answer) {
  if (!challenge || challenge.complete) {
    return { correct: false, complete: false, nextQuestion: null, attempts: challenge?.attempts ?? 0 };
  }
  const parsed = parseSubmittedAnswer(answer);
  challenge.attempts += 1;
  const expected = challenge.questions[challenge.questionIndex].answer;
  if (parsed === null || parsed !== expected) {
    return {
      correct: false,
      complete: false,
      nextQuestion: challenge.questions[challenge.questionIndex].question,
      attempts: challenge.attempts,
    };
  }
  if (challenge.questionIndex + 1 >= challenge.questionCount) {
    challenge.complete = true;
    return { correct: true, complete: true, nextQuestion: null, attempts: challenge.attempts };
  }
  challenge.questionIndex += 1;
  return {
    correct: true,
    complete: false,
    nextQuestion: challenge.questions[challenge.questionIndex].question,
    attempts: challenge.attempts,
  };
}

/** Keys that must never appear in a JS-facing payload. */
export const SECRET_ANSWER_KEYS = ["answer", "expected", "expectedAnswer", "solution"];

export function payloadExposesAnswer(obj) {
  if (!obj || typeof obj !== "object") return false;
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    for (const [k, v] of Object.entries(cur)) {
      if (SECRET_ANSWER_KEYS.includes(k)) return true;
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return false;
}
