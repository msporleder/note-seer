'use strict';

// ---------- functional core: pitch & notation math ----------

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// midi number -> { name, octave, sci }
function midiToNote(midi) {
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return { name, octave, sci: name + octave };
}

function freqToMidiFloat(freq) {
  return 69 + 12 * Math.log2(freq / 440);
}

// diatonic step index for staff position: C=0 D=1 E=2 F=3 G=4 A=5 B=6
// sharps sit on the same line/space as their natural
const STEP_OF_PC = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
const IS_SHARP = [false, true, false, true, false, false, true, false, true, false, true, false];

function midiToStaff(midi) {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return {
    diatonic: octave * 7 + STEP_OF_PC[pc], // absolute diatonic step number
    sharp: IS_SHARP[pc],
  };
}

function bufferRms(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

// Autocorrelation pitch detector (ACF2+). Returns freq in Hz or -1.
function detectPitch(buf, sampleRate) {
  const SIZE = buf.length;
  const rms = bufferRms(buf);
  if (rms < 0.01) return -1; // too quiet

  // trim silence at edges
  let r1 = 0, r2 = SIZE - 1;
  const thres = 0.2;
  for (let i = 0; i < SIZE / 2; i++) if (Math.abs(buf[i]) < thres) { r1 = i; break; }
  for (let i = 1; i < SIZE / 2; i++) if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; }
  const trimmed = buf.slice(r1, r2);
  const N = trimmed.length;
  if (N < 2) return -1;

  const c = new Float32Array(N);
  for (let lag = 0; lag < N; lag++) {
    let sum = 0;
    for (let i = 0; i < N - lag; i++) sum += trimmed[i] * trimmed[i + lag];
    c[lag] = sum;
  }

  let d = 0;
  while (d < N - 1 && c[d] > c[d + 1]) d++;
  let maxval = -1, maxpos = -1;
  for (let i = d; i < N; i++) {
    if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
  }
  if (maxpos <= 0) return -1;

  // parabolic interpolation around the peak
  let T0 = maxpos;
  const x1 = c[T0 - 1], x2 = c[T0], x3 = c[T0 + 1] ?? x2;
  const a = (x1 + x3 - 2 * x2) / 2;
  const b = (x3 - x1) / 2;
  if (a) T0 = T0 - b / (2 * a);

  return sampleRate / T0;
}

// ---------- staff rendering (SVG) ----------

const SVG_NS = 'http://www.w3.org/2000/svg';
const STAFF_X = 30, STAFF_W = 300;
const LINE_GAP = 12;               // gap between staff lines
const STEP = LINE_GAP / 2;         // one diatonic step
const TOP_LINE_Y = 70;             // y of top staff line (F5 in treble)
// treble staff: bottom line E4. diatonic of E4 = 4*7+2 = 30
const BOTTOM_LINE_DIATONIC = 30;
const BOTTOM_LINE_Y = TOP_LINE_Y + 4 * LINE_GAP;

function diatonicToY(diatonic) {
  return BOTTOM_LINE_Y - (diatonic - BOTTOM_LINE_DIATONIC) * STEP;
}

function el(name, attrs) {
  const e = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function drawStaffBase(svg) {
  svg.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    const y = TOP_LINE_Y + i * LINE_GAP;
    svg.appendChild(el('line', {
      x1: STAFF_X, y1: y, x2: STAFF_X + STAFF_W, y2: y,
      stroke: '#1a1a1a', 'stroke-width': 1,
    }));
  }
  // treble clef, anchored on the G line (2nd from bottom)
  const clef = el('text', {
    x: STAFF_X + 4, y: BOTTOM_LINE_Y + LINE_GAP,
    'font-size': 84, 'font-family': 'serif',
  });
  clef.textContent = '\u{1D11E}'; // 𝄞
  svg.appendChild(clef);

  svg.appendChild(el('g', { id: 'notegroup' }));
  svg.appendChild(el('g', { id: 'heardgroup' })); // live "heard pitch" dot in quiz mode
}

// draw one note (head, stem, ledger lines, accidental) at x in the given color
function drawGlyph(g, midi, x, color) {
  const { diatonic, sharp } = midiToStaff(midi);
  const y = diatonicToY(diatonic);

  // ledger lines
  const topDia = BOTTOM_LINE_DIATONIC + 8; // F5
  for (let d = BOTTOM_LINE_DIATONIC - 2; d >= diatonic; d -= 2) {
    g.appendChild(el('line', {
      x1: x - 13, y1: diatonicToY(d), x2: x + 13, y2: diatonicToY(d),
      stroke: color, 'stroke-width': 1,
    }));
  }
  for (let d = topDia + 2; d <= diatonic; d += 2) {
    g.appendChild(el('line', {
      x1: x - 13, y1: diatonicToY(d), x2: x + 13, y2: diatonicToY(d),
      stroke: color, 'stroke-width': 1,
    }));
  }

  // notehead
  g.appendChild(el('ellipse', {
    cx: x, cy: y, rx: 8, ry: 6,
    fill: color, transform: `rotate(-15 ${x} ${y})`,
  }));

  // stem: up if below the middle line
  const middleLineDia = BOTTOM_LINE_DIATONIC + 4;
  const stemLen = 3.2 * LINE_GAP;
  if (diatonic < middleLineDia) {
    g.appendChild(el('line', {
      x1: x + 7.4, y1: y - 2, x2: x + 7.4, y2: y - stemLen,
      stroke: color, 'stroke-width': 1.4,
    }));
  } else {
    g.appendChild(el('line', {
      x1: x - 7.4, y1: y + 2, x2: x - 7.4, y2: y + stemLen,
      stroke: color, 'stroke-width': 1.4,
    }));
  }

  if (sharp) {
    const s = el('text', {
      x: x - 19, y: y + 5, 'font-size': 15, 'font-family': 'serif', fill: color,
      'text-anchor': 'start',
    });
    s.textContent = '♯';
    g.appendChild(s);
  }
}

function drawNote(svg, midi) {
  const g = svg.querySelector('#notegroup');
  g.innerHTML = '';
  svg.querySelector('#heardgroup').innerHTML = '';
  if (midi == null) return;
  drawGlyph(g, midi, STAFF_X + STAFF_W * 0.62, '#1a1a1a');
}

const QUIZ_COLORS = { done: '#2e7d32', current: '#b0413e', upcoming: '#b9b5aa' };
const QUIZ_X0 = STAFF_X + 62;

function quizNoteX(count, i) {
  return QUIZ_X0 + ((STAFF_W - 66) / count) * (i + 0.5);
}

// small hollow dot at the pitch being heard, beside the target note.
// midiFloat: written pitch (fractional — sits between lines when out of tune)
function drawHeardDot(svg, midiFloat, count, idx) {
  const g = svg.querySelector('#heardgroup');
  g.innerHTML = '';
  if (midiFloat == null) return;
  // y from the fractional pitch: nearest note's staff step, nudged by cents
  const midi = Math.round(midiFloat);
  const y = diatonicToY(midiToStaff(midi).diatonic) - (midiFloat - midi) * STEP * 2;
  const x = quizNoteX(count, Math.min(idx, count - 1));
  g.appendChild(el('circle', {
    cx: x, cy: y, r: 5, fill: 'none', stroke: '#4a6fa5', 'stroke-width': 2,
  }));
}

// two bars of four quarter notes, barlines between and after
function drawQuizNotes(svg, notes, idx) {
  const g = svg.querySelector('#notegroup');
  g.innerHTML = '';
  const x0 = QUIZ_X0;
  const dx = (STAFF_W - 66) / notes.length;
  notes.forEach((midi, i) => {
    const color = i < idx ? QUIZ_COLORS.done : i === idx ? QUIZ_COLORS.current : QUIZ_COLORS.upcoming;
    drawGlyph(g, midi, x0 + dx * (i + 0.5), color);
  });
  for (const i of [notes.length / 2, notes.length]) {
    const bx = x0 + dx * i;
    g.appendChild(el('line', {
      x1: bx, y1: TOP_LINE_Y, x2: bx, y2: BOTTOM_LINE_Y,
      stroke: '#1a1a1a', 'stroke-width': i === notes.length ? 2.5 : 1,
    }));
  }
}

// ---------- quiz material ----------
// written pitches (what appears on the staff), 8 quarter notes = 2 bars,
// monophonic, no consecutive repeats (the detector can't hear re-attacks of
// the same sustained pitch)
const EXERCISES = [
  { name: 'Bach — Bourrée in Em (opening)', notes: [64, 66, 67, 66, 64, 63, 64, 59] },
  { name: 'Bach — Cello Suite 1 Prelude (figure)', notes: [55, 62, 71, 69, 71, 62, 71, 62] },
  { name: 'Sor — Study in Bm, Op.35 No.22 (figure)', notes: [59, 62, 66, 62, 59, 62, 66, 62] },
  { name: 'Sor — Op.60 No.1 in C (figure)', notes: [60, 64, 67, 64, 60, 64, 67, 64] },
  { name: 'Alto sax — bebop ii–V in G', notes: [69, 72, 76, 79, 78, 74, 72, 69] },
  { name: 'Jazz guitar — ii–V–I in G (arpeggio line)', notes: [69, 72, 76, 74, 71, 69, 66, 67] },
  { name: 'Jazz guitar — Cmaj7 enclosure line', notes: [64, 67, 71, 74, 72, 71, 68, 67] },
  { name: 'Jazz guitar — G blues lick', notes: [67, 70, 72, 73, 74, 72, 70, 67] },
  { name: 'Jazz guitar — Autumn-ish ii–V in Bb', notes: [60, 63, 67, 70, 69, 65, 62, 58] },
];

// generated scales: one octave up from the root (8 notes = the two quiz bars)
const SCALE_PATTERNS = {
  'major': [0, 2, 4, 5, 7, 9, 11, 12],
  'natural minor': [0, 2, 3, 5, 7, 8, 10, 12],
  'harmonic minor': [0, 2, 3, 5, 7, 8, 11, 12],
  'melodic minor': [0, 2, 3, 5, 7, 9, 11, 12],
  'dorian': [0, 2, 3, 5, 7, 9, 10, 12],
  'mixolydian': [0, 2, 4, 5, 7, 9, 10, 12],
  'major pentatonic': [0, 2, 4, 7, 9, 12, 9, 7],
  'minor pentatonic': [0, 3, 5, 7, 10, 12, 10, 7],
  'blues': [0, 3, 5, 6, 7, 10, 12, 10],
};
const SCALE_ROOTS = [
  ['C', 60], ['G', 55], ['D', 62], ['A', 57], ['E', 64],
  ['F', 65], ['Bb', 58], ['Eb', 63],
];
// arpeggios: up through the chord tones and back down (8 notes, no repeats)
const ARPEGGIO_PATTERNS = {
  'major arpeggio': [0, 4, 7, 12, 16, 12, 7, 4],
  'minor arpeggio': [0, 3, 7, 12, 15, 12, 7, 3],
  'maj7 arpeggio': [0, 4, 7, 11, 12, 11, 7, 4],
  'dom7 arpeggio': [0, 4, 7, 10, 12, 10, 7, 4],
  'min7 arpeggio': [0, 3, 7, 10, 12, 10, 7, 3],
  'm7b5 arpeggio': [0, 3, 6, 10, 12, 10, 6, 3],
  'dim7 arpeggio': [0, 3, 6, 9, 12, 9, 6, 3],
};

for (const [group, patterns] of [
  ['Scales', SCALE_PATTERNS],
  ['Arpeggios', ARPEGGIO_PATTERNS],
]) {
  for (const [kind, pattern] of Object.entries(patterns)) {
    for (const [root, base] of SCALE_ROOTS) {
      EXERCISES.push({
        name: `${root} ${kind}`,
        group,
        notes: pattern.map((s) => base + s),
      });
    }
  }
}

// ---------- imperative shell: audio + DOM ----------

const $ = (id) => document.getElementById(id);
const startBtn = $('start');
const quizBtn = $('quiz');
const exerciseSel = $('exercise');
const quizInfo = $('quizinfo');
const quizProgressEl = $('quizprogress');
const quizMsgEl = $('quizmsg');
const transposeSel = $('transpose');

{
  const groups = new Map();
  EXERCISES.forEach((ex, i) => {
    const label = ex.group ?? 'Lines & licks';
    if (!groups.has(label)) {
      const og = document.createElement('optgroup');
      og.label = label;
      exerciseSel.appendChild(og);
      groups.set(label, og);
    }
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = ex.name;
    groups.get(label).appendChild(opt);
  });
}
const statusEl = $('status');
const staffSvg = $('staff');
const notenameEl = $('notename');
const freqEl = $('freq');
const centsEl = $('cents');
const needleEl = $('centsneedle');

drawStaffBase(staffSvg);

let audioCtx = null;
let analyser = null;
let rafId = null;
let stream = null;

// small median filter to stop the display jittering
const recent = [];
function smoothedMidi(midiFloat) {
  recent.push(midiFloat);
  if (recent.length > 5) recent.shift();
  const sorted = [...recent].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function instrumentRange() {
  const opt = transposeSel.selectedOptions[0];
  // ±2 semitones of slack so notes at the edge of the range still register
  return {
    low: parseInt(opt.dataset.low, 10) - 2,
    high: parseInt(opt.dataset.high, 10) + 2,
  };
}

const HOLD_FRAMES = 60;     // ~1s linger after the sound stops
const SWITCH_FRAMES = 3;    // frames a new note must persist before we switch to it
const HARMONIC_FRAMES = 18; // ~300ms if the new note is a harmonic of the shown one

// intervals (semitones) of the 2nd..6th harmonics above a fundamental
const HARMONIC_INTERVALS = [12, 19, 24, 28, 31];

let shown = null;      // midi note currently on the staff
let candMidi = null;   // pending new note
let candFrames = 0;
let holdCounter = 0;
let peakRms = 0;       // loudest moment of the note currently shown

// ---------- quiz state ----------

let quiz = null; // { ex, idx } or null

function startQuiz() {
  const sel = exerciseSel.value;
  const ex = sel === 'random'
    ? EXERCISES[Math.floor(Math.random() * EXERCISES.length)]
    : EXERCISES[parseInt(sel, 10)];
  quiz = { ex, idx: 0 };
  quizBtn.textContent = 'End quiz';
  quizInfo.hidden = false;
  quizMsgEl.textContent = ex.name;
  updateQuizDisplay();
  if (!audioCtx) start();
}

function endQuiz() {
  quiz = null;
  quizBtn.textContent = 'Quiz';
  quizInfo.hidden = true;
  drawNote(staffSvg, null);
}

function updateQuizDisplay() {
  drawQuizNotes(staffSvg, quiz.ex.notes, quiz.idx);
  quizProgressEl.textContent = `${quiz.idx}/${quiz.ex.notes.length} — `;
}

// called on each stable note event (concert midi) while quiz is active
function quizHear(concertMidi) {
  const transpose = parseInt(transposeSel.value, 10);
  const written = concertMidi + transpose;
  if (written !== quiz.ex.notes[quiz.idx]) return;
  quiz.idx++;
  if (quiz.idx >= quiz.ex.notes.length) {
    quizProgressEl.textContent = '';
    quizMsgEl.textContent = `${quiz.ex.name} — complete! 🎉`;
    drawQuizNotes(staffSvg, quiz.ex.notes, quiz.idx);
    const done = quiz;
    // brief pause, then the next exercise (unless the quiz was ended meanwhile)
    setTimeout(() => { if (quiz === done) startQuiz(); }, 2500);
  } else {
    updateQuizDisplay();
  }
}

function render(midi, midiFloat, freq) {
  const cents = Math.round((midiFloat - midi) * 100);
  const transpose = parseInt(transposeSel.value, 10);
  const writtenMidi = midi + transpose;
  const concert = midiToNote(midi);
  const written = midiToNote(writtenMidi);

  if (!quiz) {
    drawNote(staffSvg, writtenMidi);
  } else {
    // if we're still sounding the note we just completed, anchor the dot
    // there — the quiz has already advanced but the player hasn't
    const anchor = quiz.idx > 0 && writtenMidi === quiz.ex.notes[quiz.idx - 1]
      ? quiz.idx - 1
      : quiz.idx;
    drawHeardDot(staffSvg, midiFloat + transpose, quiz.ex.notes.length, anchor);
  }
  notenameEl.textContent = written.sci;
  freqEl.textContent = transpose === 0
    ? `${freq.toFixed(1)} Hz`
    : `${freq.toFixed(1)} Hz — sounding ${concert.sci}`;
  centsEl.textContent = `${cents > 0 ? '+' : ''}${cents} cents`;
  needleEl.style.left = `${50 + cents}%`;
  needleEl.classList.toggle('intune', Math.abs(cents) <= 5);
}

function clearReadout() {
  shown = candMidi = null;
  candFrames = 0;
  peakRms = 0;
  recent.length = 0;
  if (quiz) updateQuizDisplay(); else drawNote(staffSvg, null);
  drawHeardDot(staffSvg, null, 0, 0);
  notenameEl.textContent = '—';
  freqEl.textContent = '';
  centsEl.textContent = '';
  needleEl.style.left = '50%';
  needleEl.classList.remove('intune');
}

function update() {
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  const freq = detectPitch(buf, audioCtx.sampleRate);
  const { low, high } = instrumentRange();
  const rawMidi = freq > 0 ? freqToMidiFloat(freq) : -1;
  const rms = bufferRms(buf);

  // once a note has died to a fraction of its peak, it's decay tail —
  // stop trusting pitch readings from it (harmonics dominate the tail)
  const inDecayTail = shown != null && peakRms > 0 && rms < peakRms * 0.25;

  if (rawMidi >= low && rawMidi <= high && !inDecayTail) {
    holdCounter = 0;
    const midiFloat = smoothedMidi(rawMidi);
    const midi = Math.round(midiFloat);

    if (midi === shown) {
      candMidi = null;
      candFrames = 0;
      peakRms = Math.max(peakRms, rms);
      render(midi, midiFloat, freq);
    } else {
      candFrames = midi === candMidi ? candFrames + 1 : 1;
      candMidi = midi;
      // a decaying string often reads as one of its own harmonics —
      // make those jumps prove themselves for longer before we believe them
      const isHarmonic = shown != null && HARMONIC_INTERVALS.includes(midi - shown);
      const needed = isHarmonic ? HARMONIC_FRAMES : SWITCH_FRAMES;
      if (shown == null || candFrames >= needed) {
        shown = midi;
        candMidi = null;
        candFrames = 0;
        peakRms = rms;
        render(midi, midiFloat, freq);
        if (quiz) quizHear(midi);
      }
      // otherwise keep lingering on the previous note
    }
  } else if (shown != null) {
    // a fresh loud attack ends the decay tail immediately
    if (inDecayTail && rms > peakRms * 0.6) peakRms = rms;
    else if (++holdCounter > HOLD_FRAMES) clearReadout();
  }

  rafId = requestAnimationFrame(update);
}

async function start() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) {
    statusEl.textContent = 'mic permission denied';
    return;
  }
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  startBtn.textContent = 'Stop';
  startBtn.classList.add('listening');
  statusEl.textContent = 'listening…';
  update();
}

function stop() {
  if (quiz) endQuiz();
  cancelAnimationFrame(rafId);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close();
  audioCtx = analyser = stream = null;
  recent.length = 0;
  startBtn.textContent = 'Start listening';
  startBtn.classList.remove('listening');
  statusEl.textContent = 'mic off';
  drawNote(staffSvg, null);
  notenameEl.textContent = '—';
  freqEl.textContent = '';
  centsEl.textContent = '';
  needleEl.style.left = '50%';
}

startBtn.addEventListener('click', () => (audioCtx ? stop() : start()));

quizBtn.addEventListener('click', () => (quiz ? endQuiz() : startQuiz()));

// picking an exercise mid-quiz jumps straight to it
exerciseSel.addEventListener('change', () => { if (quiz) startQuiz(); });

// re-render the current note immediately when transposition changes
transposeSel.addEventListener('change', () => {
  if (!audioCtx) drawNote(staffSvg, null);
});
