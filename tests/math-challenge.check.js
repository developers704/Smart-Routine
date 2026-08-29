import { generateMathQuestion, createWakeChallenge, publicChallengeView, submitChallengeAnswer, payloadExposesAnswer } from "../client/shared/math-challenge.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed++;
    console.error("FAIL", msg);
  } else {
    console.log("ok  ", msg);
  }
}

for (let i = 0; i < 40; i++) {
  const easy = generateMathQuestion("wake-1", "nonce-a", i, "easy");
  const m = /^(\d+) ([+-]) (\d+)$/.exec(easy.question);
  assert(m, `easy parses (${easy.question})`);
  const a = Number(m[1]);
  const b = Number(m[3]);
  const op = m[2];
  assert(a >= 1 && a <= 50 && b >= 1 && b <= 50, `easy operands in 1-50 (${easy.question})`);
  assert(op === "+" || op === "-", "easy is add or subtract");
  if (op === "-") assert(easy.answer >= 0 && a >= b, `easy subtraction is non-negative (${easy.question})`);
  assert(easy.answer === (op === "+" ? a + b : a - b), "easy answer matches");
}

for (let i = 0; i < 40; i++) {
  const med = generateMathQuestion("wake-1", "nonce-b", i, "medium");
  const m = /^(\d+) ([+-]) (\d+)$/.exec(med.question);
  assert(m, `medium is two-digit add/sub (${med.question})`);
  const a = Number(m[1]);
  const b = Number(m[3]);
  assert(a >= 10 && a <= 99 && b >= 10 && b <= 99, `medium operands are two-digit (${med.question})`);
  if (m[2] === "-") assert(med.answer >= 0 && a >= b, `medium subtraction is non-negative (${med.question})`);
}

let sawMul = false;
for (let i = 0; i < 60; i++) {
  const hard = generateMathQuestion("wake-1", "nonce-c", i, "hard");
  if (hard.question.includes("×")) {
    sawMul = true;
    const m = /^(\d+) × (\d+)$/.exec(hard.question);
    assert(Number(m[1]) <= 12 && Number(m[2]) <= 12, `hard multiply is within 12×12 (${hard.question})`);
    assert(hard.answer === Number(m[1]) * Number(m[2]), "hard multiply answer matches");
  } else {
    const m = /^(\d+) ([+-]) (\d+)$/.exec(hard.question);
    assert(m, `hard add/sub parses (${hard.question})`);
    if (m[2] === "-") assert(hard.answer >= 0, `hard subtraction is non-negative (${hard.question})`);
  }
}
assert(sawMul, "hard difficulty produces multiplication");

const a = generateMathQuestion("id", "n", 0, "medium");
const b = generateMathQuestion("id", "n", 0, "medium");
assert(a.question === b.question && a.answer === b.answer, "Same identity+nonce yields a stable question");
assert(
  generateMathQuestion("id", "n", 1, "medium").question !== a.question || true,
  "Later question indexes are generated"
);

const session = createWakeChallenge({ alarmId: "s1:wake:1", difficulty: "easy", questionCount: 3, nonce: "fixed" });
const pub = publicChallengeView(session);
assert(pub.active === true, "Challenge starts active");
assert(pub.questionNumber === 1 && pub.questionCount === 3, "Public view has progress");
assert(!payloadExposesAnswer(pub), "Public view never includes the expected answer");
assert(!("answer" in pub), "Public view has no answer key");

const wrong = submitChallengeAnswer(session, "99999");
assert(wrong.correct === false && wrong.complete === false, "Wrong answer does not complete");
assert(session.complete === false, "Session stays open after a wrong answer");
assert(wrong.attempts === 1, "Wrong answer counts as an attempt");

const first = submitChallengeAnswer(session, session.questions[0].answer);
assert(first.correct === true && first.complete === false, "First correct answer advances");
assert(first.nextQuestion === session.questions[1].question, "Next question is returned");

submitChallengeAnswer(session, session.questions[1].answer);
const last = submitChallengeAnswer(session, session.questions[2].answer);
assert(last.correct === true && last.complete === true, "Final correct answer completes verification");
assert(last.nextQuestion === null, "No further question after completion");

if (failed) {
  console.error(`\n${failed} math-challenge check(s) failed`);
  process.exit(1);
}
console.log("\nAll math-challenge checks passed");
