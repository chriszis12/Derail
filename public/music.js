// ============================================================================
// DERAIL — music.js
// A slow, moody, procedurally-generated background loop — no audio files.
// Minor-key chord pad + a soft walking bass, styled after late-night jazz,
// to match the "case file" noir theme. Starts only after a user gesture
// (browsers block autoplay audio otherwise) and respects its own
// mute + volume settings in localStorage, independent from the SFX ones.
// ============================================================================

const Music = (() => {
  let ctx = null;
  let masterGain = null;
  let playing = false;
  let scheduler = null;
  let nextNoteTime = 0;
  let stepIndex = 0;

  let muted = localStorage.getItem("derail:musicMuted") !== "0"; // muted by default until the player opts in
  let volume = parseFloat(localStorage.getItem("derail:musicVolume") ?? "0.35");

  // A moody i - iv - VI - V progression in A minor, one chord per bar.
  const PROGRESSION = [
    { root: 220.0, third: 261.63, fifth: 329.63 }, // Am
    { root: 293.66, third: 349.23, fifth: 440.0 }, // Dm
    { root: 349.23, third: 440.0, fifth: 523.25 }, // F
    { root: 329.63, third: 415.3, fifth: 493.88 }, // E (E7-ish, no 7th to stay simple)
  ];
  const BAR_SECONDS = 3.6;

  function getCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      masterGain = ctx.createGain();
      masterGain.gain.value = muted ? 0 : volume;
      masterGain.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function padChord(chord, startTime, duration) {
    const c = getCtx();
    [chord.root, chord.third, chord.fifth].forEach((freq, i) => {
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = "sine";
      osc.frequency.value = freq / 2; // an octave down, keeps it warm/low
      g.gain.setValueAtTime(0.0001, startTime);
      g.gain.exponentialRampToValueAtTime(0.09, startTime + 0.8);
      g.gain.setValueAtTime(0.09, startTime + duration - 0.9);
      g.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
      osc.connect(g).connect(masterGain);
      osc.start(startTime);
      osc.stop(startTime + duration + 0.05);
    });
  }

  function bassNote(freq, startTime, duration) {
    const c = getCtx();
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = "triangle";
    osc.frequency.value = freq / 4;
    g.gain.setValueAtTime(0.0001, startTime);
    g.gain.exponentialRampToValueAtTime(0.12, startTime + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, startTime + duration * 0.9);
    osc.connect(g).connect(masterGain);
    osc.start(startTime);
    osc.stop(startTime + duration);
  }

  function scheduleBar() {
    const c = getCtx();
    const chord = PROGRESSION[stepIndex % PROGRESSION.length];
    padChord(chord, nextNoteTime, BAR_SECONDS);
    bassNote(chord.root, nextNoteTime, BAR_SECONDS * 0.48);
    bassNote(chord.fifth, nextNoteTime + BAR_SECONDS * 0.5, BAR_SECONDS * 0.48);
    stepIndex += 1;
    nextNoteTime += BAR_SECONDS;
  }

  function tick() {
    const c = getCtx();
    while (nextNoteTime < c.currentTime + 1.0) scheduleBar();
  }

  return {
    isMuted: () => muted,
    isPlaying: () => playing,
    getVolume: () => volume,
    start() {
      if (playing) return;
      const c = getCtx();
      nextNoteTime = c.currentTime + 0.1;
      stepIndex = 0;
      playing = true;
      scheduler = setInterval(tick, 250);
      tick();
    },
    stop() {
      playing = false;
      if (scheduler) clearInterval(scheduler);
      scheduler = null;
    },
    setMuted(v) {
      muted = v;
      localStorage.setItem("derail:musicMuted", v ? "1" : "0");
      if (masterGain) masterGain.gain.setTargetAtTime(v ? 0 : volume, getCtx().currentTime, 0.15);
      if (!v) this.start();
    },
    setVolume(v) {
      volume = Math.max(0, Math.min(1, v));
      localStorage.setItem("derail:musicVolume", String(volume));
      if (masterGain && !muted) masterGain.gain.setTargetAtTime(volume, getCtx().currentTime, 0.1);
    },
  };
})();
