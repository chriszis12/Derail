// ============================================================================
// DERAIL — sound.js
// Every sound effect is synthesized live with the Web Audio API — no mp3/wav
// files to host or license. Muted state persists in localStorage.
// ============================================================================

const Sound = (() => {
  let ctx = null;
  let muted = localStorage.getItem("derail:muted") === "1";
  let volume = parseFloat(localStorage.getItem("derail:sfxVolume") ?? "1");

  function getCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function tone({ freq = 440, duration = 0.15, type = "sine", gain = 0.18, glideTo = null, delay = 0 }) {
    if (muted) return;
    try {
      const c = getCtx();
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = type;
      const t0 = c.currentTime + delay;
      osc.frequency.setValueAtTime(freq, t0);
      if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + duration);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain * volume), t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(g).connect(c.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.02);
    } catch {
      /* audio not available — fail silently */
    }
  }

  function noiseBurst({ duration = 0.12, gain = 0.12, delay = 0 }) {
    if (muted) return;
    try {
      const c = getCtx();
      const bufferSize = c.sampleRate * duration;
      const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
      const src = c.createBufferSource();
      src.buffer = buffer;
      const g = c.createGain();
      g.gain.value = gain * volume;
      src.connect(g).connect(c.destination);
      src.start(c.currentTime + delay);
    } catch {
      /* no-op */
    }
  }

  return {
    isMuted: () => muted,
    getVolume: () => volume,
    setMuted(v) {
      muted = v;
      localStorage.setItem("derail:muted", v ? "1" : "0");
    },
    setVolume(v) {
      volume = Math.max(0, Math.min(1, v));
      localStorage.setItem("derail:sfxVolume", String(volume));
    },
    // a soft typewriter-key click for UI interactions
    click() {
      tone({ freq: 620, duration: 0.05, type: "square", gain: 0.06 });
      noiseBurst({ duration: 0.03, gain: 0.04 });
    },
    // sentence successfully added to the file
    submit() {
      tone({ freq: 520, duration: 0.09, type: "triangle", gain: 0.14 });
      tone({ freq: 780, duration: 0.09, type: "triangle", gain: 0.1, delay: 0.06 });
    },
    // it's now my turn
    yourTurn() {
      tone({ freq: 440, duration: 0.12, type: "sine", gain: 0.15 });
      tone({ freq: 660, duration: 0.16, type: "sine", gain: 0.15, delay: 0.1 });
    },
    // final seconds of the turn timer
    tick() {
      tone({ freq: 900, duration: 0.05, type: "square", gain: 0.08 });
    },
    // DERAIL button pressed
    derailSiren() {
      tone({ freq: 900, duration: 0.35, type: "sawtooth", gain: 0.14, glideTo: 350 });
    },
    // rubber-stamp slam (correct callout)
    stampBusted() {
      noiseBurst({ duration: 0.08, gain: 0.22 });
      tone({ freq: 140, duration: 0.28, type: "square", gain: 0.2, delay: 0.02 });
    },
    // rubber-stamp slam (wrong callout)
    stampWrong() {
      tone({ freq: 300, duration: 0.22, type: "sawtooth", gain: 0.14, glideTo: 160 });
    },
    // goal fulfilled at reveal
    success() {
      [523, 659, 784].forEach((f, i) => tone({ freq: f, duration: 0.18, type: "triangle", gain: 0.14, delay: i * 0.09 }));
    },
    // goal failed at reveal
    fail() {
      tone({ freq: 220, duration: 0.3, type: "sawtooth", gain: 0.12, glideTo: 110 });
    },
    // screen change
    whoosh() {
      tone({ freq: 200, duration: 0.18, type: "sine", gain: 0.06, glideTo: 500 });
    },
  };
})();

