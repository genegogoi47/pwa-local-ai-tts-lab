const MAX_TEXT_CHARS = 1200;
const SYNTHESIS_TIMEOUT_MS = 180000;

const $ = (id) => document.getElementById(id);
const els = {
  load: $("load-model-btn"), clearModel: $("clear-model-btn"), modelStatus: $("model-status"),
  modelProgressWrap: $("model-progress-wrap"), modelProgressLabel: $("model-progress-label"),
  modelProgressValue: $("model-progress-value"), modelProgressFill: $("model-progress-fill"),
  voiceRow: $("voice-row"), voiceSelect: $("voice-select"), voiceHint: $("voice-hint"),
  text: $("speech-text"), charCount: $("char-count"), generate: $("generate-btn"),
  generationEstimate: $("generation-estimate"), generationProgressWrap: $("generation-progress-wrap"),
  generationStatus: $("generation-status"), generationElapsed: $("generation-elapsed"),
  generationResult: $("generation-result"), player: $("audio-player"), audioTitle: $("audio-title"),
  audioSubtitle: $("audio-subtitle"), downloadWav: $("download-wav-btn"), clearAudio: $("clear-audio-btn"),
  log: $("log-list"), diagnostics: $("diagnostics-grid")
};

let ttsWorker = null;
let workerReady = false;
let isLoading = false;
let isGenerating = false;
let generationStartedAt = 0;
let generationTimer = null;
let generationTimeout = null;
let currentAudioUrl = null;
let currentAudioBlob = null;

function log(message, level = "info") {
  const empty = els.log.querySelector(".log-empty");
  if (empty) empty.remove();
  const row = document.createElement("div");
  row.className = "log-entry";
  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const msg = document.createElement("span");
  msg.className = "log-message";
  msg.textContent = message;
  msg.style.color = level === "error" ? "#ff9696" : level === "success" ? "#a3e6c3" : "#b9c6d6";
  row.append(time, msg);
  els.log.prepend(row);
}

function setModelStatus(message, type = "neutral") {
  els.modelStatus.replaceChildren();
  const dot = document.createElement("span");
  dot.className = `status-dot ${type}`;
  const text = document.createElement("span");
  text.textContent = message;
  els.modelStatus.append(dot, text);
}

function setModelProgress(loaded, total, label = "Downloading model") {
  els.modelProgressWrap.hidden = false;
  els.modelProgressLabel.textContent = label;
  const percent = total > 0 ? Math.min(100, (loaded / total) * 100) : 0;
  els.modelProgressValue.textContent = total > 0 ? `${percent.toFixed(0)}%` : `${(loaded / (1024 * 1024)).toFixed(1)} MB`;
  els.modelProgressFill.style.width = total > 0 ? `${percent}%` : "32%";
  els.modelProgressFill.classList.toggle("indeterminate", total <= 0);
}

function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function updateCharacterCount() {
  els.charCount.textContent = `${els.text.value.length.toLocaleString()} / ${MAX_TEXT_CHARS.toLocaleString()}`;
}

function renderDiagnostics(items) {
  els.diagnostics.replaceChildren();
  for (const [label, value] of items) {
    const item = document.createElement("div");
    item.className = "diag-item";
    const l = document.createElement("div"); l.className = "diag-label"; l.textContent = label;
    const v = document.createElement("div"); v.className = "diag-value"; v.textContent = value;
    item.append(l, v); els.diagnostics.append(item);
  }
}

function updateDiagnostics() {
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const items = [
    ["BROWSER", /Edg\//i.test(navigator.userAgent) ? "Microsoft Edge" : /Chrome|CriOS/i.test(navigator.userAgent) ? "Chrome / Chromium" : /Safari/i.test(navigator.userAgent) ? "Safari / WebKit" : "Other"],
    ["HOME SCREEN PWA", standalone ? "Installed mode" : "Browser tab"],
    ["WEBASSEMBLY", typeof WebAssembly !== "undefined" ? "Available" : "Unavailable"],
    ["WEB WORKER", typeof Worker !== "undefined" ? "Available" : "Unavailable"],
    ["CACHE STORAGE", "caches" in window ? "Available" : "Unavailable"],
    ["NETWORK", navigator.onLine ? "Online" : "Offline"],
    ["USER AGENT", navigator.userAgent.slice(0, 94) + (navigator.userAgent.length > 94 ? "…" : "")]
  ];
  if (navigator.storage?.estimate) {
    navigator.storage.estimate().then(({ usage, quota }) => {
      items.splice(6, 0, ["SITE STORAGE", `${usage ? (usage / (1024 * 1024)).toFixed(1) : "0"} / ${quota ? (quota / (1024 * 1024)).toFixed(0) : "?"} MB`]);
      renderDiagnostics(items);
    }).catch(() => renderDiagnostics(items));
  } else renderDiagnostics(items);
}

function populateVoices(list) {
  els.voiceSelect.replaceChildren();
  const usable = Array.isArray(list) ? list.filter((voice) => voice?.voiceId) : [];
  if (usable.length === 0) {
    const option = document.createElement("option");
    option.value = "freya"; option.textContent = "Freya (default)";
    els.voiceSelect.append(option);
    log("The model did not return voice metadata; using the documented Phonon default.");
  } else {
    for (const voice of usable) {
      const option = document.createElement("option");
      option.value = voice.voiceId;
      option.textContent = `${voice.displayName || voice.voiceId} (${voice.voiceId})`;
      els.voiceSelect.append(option);
    }
  }
  const preferred = [...els.voiceSelect.options].some((option) => option.value === "freya") ? "freya" : els.voiceSelect.options[0]?.value;
  if (preferred) els.voiceSelect.value = preferred;
  els.voiceHint.textContent = `${els.voiceSelect.options.length} English voice profile(s) reported by the model.`;
  els.voiceRow.hidden = false;
  els.voiceSelect.disabled = false;
}

function ensureWorker() {
  if (ttsWorker) return ttsWorker;
  if (!("Worker" in window)) throw new Error("This browser does not support Web Workers.");
  ttsWorker = new Worker("/tts-worker.js", { type: "classic", name: "phonon-tts-worker" }); // Classic worker: MediaPipe WASM loader uses importScripts().
  ttsWorker.addEventListener("message", handleWorkerMessage);
  ttsWorker.addEventListener("error", (event) => {
    const message = event.message || "Unknown Web Worker error.";
    log(`Worker crashed: ${message}`, "error");
    handleWorkerFailure(message);
  });
  ttsWorker.addEventListener("messageerror", () => {
    log("The browser could not deserialize a message from the TTS worker.", "error");
    handleWorkerFailure("Worker message could not be decoded.");
  });
  return ttsWorker;
}

function finishGenerationUI() {
  if (generationTimer) clearInterval(generationTimer);
  if (generationTimeout) clearTimeout(generationTimeout);
  generationTimer = null;
  generationTimeout = null;
  els.generationProgressWrap.hidden = true;
  els.generate.disabled = !workerReady;
  isGenerating = false;
}

function handleWorkerFailure(message) {
  if (ttsWorker) ttsWorker.terminate();
  ttsWorker = null;
  workerReady = false;
  isLoading = false;
  els.load.disabled = false;
  els.load.textContent = "Retry model setup";
  els.generate.disabled = true;
  setModelStatus(`Worker stopped: ${message}`, "bad");
  if (isGenerating) {
    finishGenerationUI();
    els.generationResult.hidden = false;
    els.generationStatus.textContent = "Speech generation stopped.";
    els.generationResult.textContent = message;
  }
  if (isLoading) isLoading = false;
}

function encodeWav(floatSamples, sampleRateHz) {
  const channels = 1;
  const bytesPerSample = 2;
  const dataLength = floatSamples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const write = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  write(0, "RIFF"); view.setUint32(4, 36 + dataLength, true); write(8, "WAVE");
  write(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true); view.setUint16(34, 16, true);
  write(36, "data"); view.setUint32(40, dataLength, true);
  let offset = 44;
  for (let i = 0; i < floatSamples.length; i++, offset += 2) {
    const sample = Math.max(-1, Math.min(1, floatSamples[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function setMediaSessionMetadata() {
  if (!("mediaSession" in navigator)) return;
  try {
    if ("MediaMetadata" in window) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: "Phonon AI Voice Test", artist: "LocalVoice Lab", album: "PWA Local AI TTS Experiment" });
    }
    navigator.mediaSession.setActionHandler("play", () => els.player.play());
    navigator.mediaSession.setActionHandler("pause", () => els.player.pause());
    navigator.mediaSession.setActionHandler("stop", () => els.player.pause());
    navigator.mediaSession.setActionHandler("seekbackward", (details) => { els.player.currentTime = Math.max(0, els.player.currentTime - (details.seekOffset || 10)); });
    navigator.mediaSession.setActionHandler("seekforward", (details) => { els.player.currentTime = Math.min(els.player.duration || Infinity, els.player.currentTime + (details.seekOffset || 10)); });
  } catch (error) { log(`Media Session controls unavailable: ${error.message}`); }
}

function handleWorkerMessage(event) {
  const data = event.data || {};
  if (data.type === "log") {
    log(data.message, data.level || "info");
    return;
  }
  if (data.type === "download-progress") {
    setModelProgress(data.loaded || 0, data.total || 0, data.label || "Downloading model");
    return;
  }
  if (data.type === "phase") {
    setModelStatus(data.message || "Working…", "neutral");
    return;
  }
  if (data.type === "model-ready") {
    isLoading = false;
    workerReady = true;
    populateVoices(data.voices);
    els.load.disabled = true;
    els.load.textContent = "Model loaded ✓";
    els.generate.disabled = false;
    els.generationEstimate.textContent = `Ready. Model initialized in ${data.elapsedSeconds ?? "—"}s.`;
    setModelStatus(`Model loaded in worker and ready. Initialization: ${data.elapsedSeconds ?? "—"}s.`, "good");
    log("Inference engine is running in a dedicated classic Web Worker; page controls remain responsive.", "success");
    if (navigator.storage?.persist) {
      navigator.storage.persist().then((persisted) => log(persisted ? "Browser granted persistent storage." : "Browser did not grant persistent storage; cached model may still be retained.", persisted ? "success" : "info")).catch(() => {});
    }
    updateDiagnostics();
    return;
  }
  if (data.type === "synthesis-start") {
    isGenerating = true;
    generationStartedAt = performance.now();
    els.generate.disabled = true;
    els.generationProgressWrap.hidden = false;
    els.generationProgressFill.classList.add("indeterminate");
    els.generationStatus.textContent = `Generating ${data.characters} characters in the background worker…`;
    els.generationElapsed.textContent = "0.0s";
    els.generationResult.hidden = true;
    generationTimer = setInterval(() => {
      els.generationElapsed.textContent = `${((performance.now() - generationStartedAt) / 1000).toFixed(1)}s`;
    }, 100);
    generationTimeout = setTimeout(() => {
      log(`Synthesis exceeded ${SYNTHESIS_TIMEOUT_MS / 1000}s. Stopping the worker to prevent an endless spinner.`, "error");
      handleWorkerFailure("Synthesis exceeded the 180-second limit. The worker was stopped. Reload the page and retry with a shorter sentence.");
    }, SYNTHESIS_TIMEOUT_MS);
    return;
  }
  if (data.type === "synthesis-result") {
    finishGenerationUI();
    const samples = new Float32Array(data.samplesBuffer);
    const sampleRateHz = data.sampleRateHz || 24000;
    const wav = encodeWav(samples, sampleRateHz);
    if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
    currentAudioBlob = wav;
    currentAudioUrl = URL.createObjectURL(wav);
    els.player.pause();
    els.player.src = currentAudioUrl;
    els.player.load();
    const duration = samples.length / sampleRateHz;
    const elapsed = data.elapsedMs || 0;
    const rtf = duration > 0 ? (elapsed / 1000) / duration : 0;
    els.audioTitle.textContent = `Phonon sample · ${data.voiceId || "voice"}`;
    els.audioSubtitle.textContent = `${formatDuration(duration)} · WAV · ${(wav.size / (1024 * 1024)).toFixed(2)} MB`;
    els.downloadWav.disabled = false;
    els.clearAudio.disabled = false;
    els.generationStatus.textContent = "Speech generated successfully.";
    els.generationResult.hidden = false;
    els.generationResult.textContent = `Generated ${formatDuration(duration)} of audio in ${(elapsed / 1000).toFixed(2)}s. Real-time factor: ${rtf.toFixed(2)}×.`;
    els.generationEstimate.textContent = `Last synthesis: ${(elapsed / 1000).toFixed(2)}s`;
    setMediaSessionMetadata();
    log(`Received ${samples.length.toLocaleString()} PCM samples from worker. WAV size ${(wav.size / (1024 * 1024)).toFixed(2)} MB.`, "success");
    return;
  }
  if (data.type === "synthesis-error") {
    finishGenerationUI();
    els.generationStatus.textContent = "Speech generation failed.";
    els.generationResult.hidden = false;
    els.generationResult.textContent = data.message || "Unknown synthesis error.";
    log(`Synthesis failed: ${data.message || "Unknown error"}`, "error");
    return;
  }
  if (data.type === "worker-error") {
    log(`Worker ${data.phase || "operation"} error: ${data.message}`, "error");
    if (data.phase === "load-model" || data.phase === "load") {
      isLoading = false;
      els.load.disabled = false;
      els.load.textContent = "Retry model setup";
      setModelStatus(`Could not load model: ${data.message}`, "bad");
    } else if (data.phase === "synthesize") {
      finishGenerationUI();
      els.generationStatus.textContent = "Speech generation failed.";
      els.generationResult.hidden = false;
      els.generationResult.textContent = data.message;
    }
    return;
  }
  if (data.type === "model-cleared") {
    workerReady = false;
    els.voiceRow.hidden = true;
    els.voiceSelect.replaceChildren();
    els.generate.disabled = true;
    els.load.disabled = false;
    els.load.textContent = "Download & load model";
    els.modelProgressWrap.hidden = true;
    setModelStatus("Saved model removed.", "neutral");
    updateDiagnostics();
  }
}

async function loadModel() {
  if (isLoading || workerReady) return;
  isLoading = true;
  els.load.disabled = true;
  els.load.textContent = "Loading model…";
  els.modelProgressWrap.hidden = false;
  setModelProgress(0, 87 * 1024 * 1024, "Preparing model");
  setModelStatus("Starting the speech engine in a Web Worker…", "neutral");
  try {
    ensureWorker().postMessage({ type: "load-model" });
  } catch (error) {
    isLoading = false;
    els.load.disabled = false;
    els.load.textContent = "Retry model setup";
    setModelStatus(error.message, "bad");
    log(`Could not start inference worker: ${error.message}`, "error");
  }
}

function generateSpeech() {
  if (!workerReady || isGenerating) return;
  const text = els.text.value.trim();
  if (!text) { alert("Enter some text first."); return; }
  if (text.length > MAX_TEXT_CHARS) { alert(`Keep the test under ${MAX_TEXT_CHARS} characters.`); return; }
  log(`Sending ${text.length} characters to the worker using voice ${els.voiceSelect.value}.`);
  els.generate.disabled = true;
  try {
    ensureWorker().postMessage({ type: "synthesize", text, voiceId: els.voiceSelect.value || "freya" });
    // synthesis-start from the worker begins the timer and timeout after it accepts the job.
  } catch (error) {
    els.generate.disabled = false;
    log(`Could not send synthesis request to worker: ${error.message}`, "error");
  }
}

async function clearModelCache() {
  if (isLoading || isGenerating) return;
  if (!confirm("Remove the saved Phonon model from this browser? You will need to download it again.")) return;
  try {
    ensureWorker().postMessage({ type: "clear-model" });
  } catch (error) {
    log(`Could not clear saved model: ${error.message}`, "error");
  }
}

function clearAudio() {
  els.player.pause();
  els.player.removeAttribute("src");
  els.player.load();
  if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
  currentAudioUrl = null;
  currentAudioBlob = null;
  els.audioTitle.textContent = "No audio generated yet";
  els.audioSubtitle.textContent = "Your generated sample will appear here";
  els.downloadWav.disabled = true;
  els.clearAudio.disabled = true;
  els.generationResult.hidden = true;
  if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
  log("Generated audio cleared.");
}

els.load.addEventListener("click", loadModel);
els.clearModel.addEventListener("click", clearModelCache);
els.generate.addEventListener("click", generateSpeech);
els.text.addEventListener("input", updateCharacterCount);
els.downloadWav.addEventListener("click", () => {
  if (!currentAudioBlob || !currentAudioUrl) return;
  const link = document.createElement("a");
  link.href = currentAudioUrl;
  link.download = `phonon-${els.voiceSelect.value || "voice"}-sample.wav`;
  document.body.append(link); link.click(); link.remove();
});
els.clearAudio.addEventListener("click", clearAudio);
$("refresh-diagnostics-btn").addEventListener("click", updateDiagnostics);
$("clear-log-btn").addEventListener("click", () => { els.log.innerHTML = '<div class="log-empty">Log cleared.</div>'; });
els.player.addEventListener("play", () => { if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing"; log("Audio playback started.", "success"); });
els.player.addEventListener("pause", () => { if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused"; });
els.player.addEventListener("ended", () => { if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "none"; log("Audio playback ended."); });
window.addEventListener("online", updateDiagnostics);
window.addEventListener("offline", updateDiagnostics);

updateCharacterCount();
updateDiagnostics();
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").then(() => log("PWA service worker registered.", "success")).catch((error) => log(`Service worker registration failed: ${error.message}`, "error")));
}
log("Prototype ready. Model inference will run in a dedicated classic Web Worker.");
