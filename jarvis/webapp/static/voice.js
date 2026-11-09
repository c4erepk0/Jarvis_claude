// Голос: распознавание речи (Web Speech API, слово-активатор «Джарвис») и озвучка ответов.
// Озвучка идёт через Web Audio: лёгкая «металлическая» окраска и эхо, как у ИИ из фильма.

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export class Voice {
  constructor({ wakeWord = "джарвис", onCommand, onState, onLevel, onHeard }) {
    this.wake = wakeWord.toLowerCase();
    this.onCommand = onCommand;
    this.onState = onState || (() => {});
    this.onLevel = onLevel || (() => {});
    this.onHeard = onHeard || (() => {});
    this.supported = !!SR;
    this.wakeMode = false;
    this.armed = false;        // слово-активатор услышано, ждём команду
    this.speaking = false;
    this.fx = true;
    this.muted = false;
    this.rec = null;
    this.ctx = null;
    this.queue = Promise.resolve();
    this.serverTTS = true;
  }

  // ---------- звук ----------
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.buildChain();
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    // iOS разрешает речь только после первого касания — «разогреваем» синтезатор пустой фразой
    if (!this.ttsUnlocked && "speechSynthesis" in window) {
      this.ttsUnlocked = true;
      try { speechSynthesis.speak(new SpeechSynthesisUtterance(" ")); } catch { /* нет синтезатора */ }
    }
  }

  buildChain() {
    const c = this.ctx;
    this.analyser = c.createAnalyser();
    this.analyser.fftSize = 512;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -20; comp.ratio.value = 3.5;
    const low = c.createBiquadFilter(); low.type = "lowshelf"; low.frequency.value = 160; low.gain.value = -2;
    const high = c.createBiquadFilter(); high.type = "highshelf"; high.frequency.value = 3800; high.gain.value = 3;
    // «металл» — короткая гребёнчатая задержка
    const comb = c.createDelay(0.05); comb.delayTime.value = 0.011;
    const combFb = c.createGain(); combFb.gain.value = 0.32;
    const combWet = c.createGain(); combWet.gain.value = 0.22;
    comb.connect(combFb); combFb.connect(comb); comb.connect(combWet);
    // небольшое помещение
    const rev = c.createConvolver(); rev.buffer = this.impulse(1.1, 2.6);
    const revWet = c.createGain(); revWet.gain.value = 0.16;
    rev.connect(revWet);
    this.input = c.createGain();
    this.dry = c.createGain();
    this.fxBus = c.createGain();
    this.input.connect(this.dry);
    this.input.connect(this.fxBus);
    this.fxBus.connect(comb);
    this.fxBus.connect(rev);
    const sum = c.createGain();
    this.dry.connect(sum); combWet.connect(sum); revWet.connect(sum);
    sum.connect(low); low.connect(high); high.connect(comp); comp.connect(this.analyser);
    this.analyser.connect(c.destination);
    this.setFx(this.fx);
  }

  impulse(seconds, decay) {
    const c = this.ctx, len = Math.floor(c.sampleRate * seconds);
    const buf = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  setFx(on) {
    this.fx = on;
    if (this.fxBus) this.fxBus.gain.value = on ? 1 : 0;
  }

  meter() {
    if (!this.analyser) return;
    const data = new Uint8Array(this.analyser.fftSize);
    const tick = () => {
      if (!this.speaking) { this.onLevel(0); return; }
      this.analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) { const x = (v - 128) / 128; sum += x * x; }
      this.onLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
      requestAnimationFrame(tick);
    };
    tick();
  }

  say(text) {
    if (!text || this.muted) return Promise.resolve();
    this.queue = this.queue.then(() => this._say(text)).catch(() => {});
    return this.queue;
  }

  async _say(text) {
    this.speaking = true;
    this.pauseListening();
    this.onState("speaking");
    try {
      let played = false;
      if (this.serverTTS && this.ctx) {
        const r = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }), credentials: "same-origin" });
        if (r.status === 200) {
          const buf = await this.ctx.decodeAudioData(await r.arrayBuffer());
          await new Promise((resolve) => {
            const src = this.ctx.createBufferSource();
            src.buffer = buf;
            src.connect(this.input);
            src.onended = resolve;
            this.meter();
            src.start();
          });
          played = true;
        }
      }
      if (!played) await this.browserSay(text);
    } catch (e) {
      console.warn("озвучка не удалась", e);
      await this.browserSay(text).catch(() => {});
    } finally {
      this.speaking = false;
      this.onLevel(0);
      this.onState(this.wakeMode ? "listening" : "idle");
      this.resumeListening();
    }
  }

  browserSay(text) {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) return resolve();
      const u = new SpeechSynthesisUtterance(text.replace(/[*_#`]/g, ""));
      u.lang = /[а-яё]/i.test(text) ? "ru-RU" : "en-GB";
      const all = speechSynthesis.getVoices();
      const voices = all.filter((v) => v.lang.startsWith(u.lang.slice(0, 2)));
      // на iPhone мужской русский голос — «Yuri» (Настройки → Универсальный доступ → Устный контент → Голоса)
      u.voice = all.find((v) => v.name === this.preferredVoice && v.lang.startsWith(u.lang.slice(0, 2)))
        || voices.find((v) => /yuri|юрий|dmitr|daniel|male|муж/i.test(v.name)) || voices[0] || null;
      u.rate = 0.97; u.pitch = 0.8;
      let fake = 0;
      const iv = setInterval(() => { fake = (fake + 0.37) % 1; this.onLevel(0.25 + Math.abs(Math.sin(fake * 6)) * 0.4); }, 90);
      u.onend = u.onerror = () => { clearInterval(iv); resolve(); };
      speechSynthesis.speak(u);
    });
  }

  // ---------- распознавание ----------
  makeRecognizer(continuous) {
    const r = new SR();
    r.lang = "ru-RU";
    r.continuous = continuous;
    r.interimResults = true;
    r.maxAlternatives = 1;
    return r;
  }

  listenOnce() {
    if (!this.supported) return false;
    this.unlock();
    this.stopRec();
    const r = this.makeRecognizer(false);
    this.rec = r;
    this.onState("listening");
    let final = "";
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t; else interim += t;
      }
      this.onHeard(final || interim);
      this.onLevel(0.5);
    };
    r.onerror = () => this.onState("idle");
    r.onend = () => {
      this.rec = null;
      if (final.trim()) this.onCommand(final.trim());
      else this.onState(this.wakeMode ? "listening" : "idle");
      if (this.wakeMode) setTimeout(() => this.startWake(), 300);
    };
    r.start();
    return true;
  }

  /** Диктовка (✌ в правке заметки): одна фраза → текст. Команду Jarvis не отправляет. */
  dictate() {
    if (!this.supported) return Promise.reject(new Error("этот браузер не распознаёт речь"));
    this.unlock();
    this.stopRec();
    return new Promise((resolve, reject) => {
      const r = this.makeRecognizer(false);
      let final = "", interim = "", error = null, done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (this.rec === r) this.rec = null;
        this.onState(this.wakeMode ? "listening" : "idle");
        if (this.wakeMode) setTimeout(() => this.startWake(), 300);
        const text = (final || interim).trim();
        if (!text && error && !["no-speech", "aborted"].includes(error)) {
          reject(new Error(error === "not-allowed" ? "нет доступа к микрофону" : error));
        } else resolve(text);
      };
      r.finish = finish;            // stopRec() (например, Jarvis заговорил) — отдаём то, что успели услышать
      r.onresult = (e) => {
        interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) final += t; else interim += t;
        }
        this.onHeard(`✎ ${final || interim}`);
        this.onLevel(0.5);
      };
      r.onerror = (e) => { error = e.error; };
      r.onend = finish;
      this.rec = r;
      this.onState("listening");
      try { r.start(); } catch (e) { error = e.message || "не запустить распознавание"; finish(); }
    });
  }

  setWakeMode(on) {
    this.wakeMode = on && this.supported;
    if (this.wakeMode) { this.unlock(); this.startWake(); } else { this.stopRec(); this.onState("idle"); }
    return this.wakeMode;
  }

  startWake() {
    if (!this.wakeMode || this.speaking || this.rec) return;
    const r = this.makeRecognizer(true);
    this.rec = r;
    this.onState("listening");
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = res[0].transcript.trim();
        const low = text.toLowerCase();
        const at = low.search(new RegExp(`${this.wake}\\S*`));
        if (!res.isFinal) {
          if (at >= 0 || this.armed) this.onHeard(text);
          continue;
        }
        if (at >= 0) {
          const after = text.slice(at).replace(/^\S+[\s,.!:—-]*/, "").trim();
          if (after.length > 1) { this.armed = false; this.onCommand(after); }
          else { this.armed = true; this.onState("armed"); clearTimeout(this.armTimer);
            this.armTimer = setTimeout(() => { this.armed = false; this.onState("listening"); }, 7000); }
        } else if (this.armed && text.length > 1) {
          this.armed = false; clearTimeout(this.armTimer); this.onCommand(text);
        }
      }
    };
    r.onerror = (e) => { if (e.error === "not-allowed") { this.wakeMode = false; this.onState("denied"); } };
    r.onend = () => { this.rec = null; if (this.wakeMode && !this.speaking) setTimeout(() => this.startWake(), 250); };
    try { r.start(); } catch { this.rec = null; }
  }

  stopRec() {
    if (this.rec) {
      const r = this.rec;
      this.rec = null;
      r.onend = null;
      try { r.abort(); } catch { /* уже остановлен */ }
      if (r.finish) r.finish();
    }
  }
  pauseListening() { this.stopRec(); }
  resumeListening() { if (this.wakeMode) setTimeout(() => this.startWake(), 350); }
}
