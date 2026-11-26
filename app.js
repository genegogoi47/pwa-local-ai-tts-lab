const SDK_VERSION = "1.2.3";
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@${SDK_VERSION}/wasm`;
const MODEL_URL = "https://huggingface.co/litert-community/phonon-31m-en/resolve/main/phonon_int8.litertlm";
const MODEL_CACHE_NAME = "localvoice-phonon-model-v1";
const MODEL_CACHE_KEY = new URL("/__localvoice_model_cache__/phonon_int8.litertlm", location.origin).href;
const EXPECTED_MODEL_BYTES = 87 * 1024 * 1024;
const MAX_TEXT_CHARS = 1200;

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

let ttsInstance = null;
let currentAudioUrl = null;
let currentAudioBlob = null;
let lastGenerationMs = 0;
let voices = [];
let isLoading = false;
let isGenerating = false;

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
  els.modelProgressValue.textContent = total > 0 ? `${percent.toFixed(0)}%` : `${formatMB(loaded)} MB`;
  els.modelProgressFill.style.width = total > 0 ? `${percent}%` : "32%";
  els.modelProgressFill.classList.toggle("indeterminate", total <= 0);
}

function formatMB(bytes) { return (bytes / (1024 * 1024)).toFixed(1); }

function updateCharacterCount() {
  els.charCount.textContent = `${els.text.value.length.toLocaleString()} / ${MAX_TEXT_CHARS.toLocaleString()}`;
}

function updateDiagnostics() {
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const storage = navigator.storage;
  const items = [
    ["BROWSER", /CriOS|Chrome/i.test(navigator.userAgent) ? "Chromium" : /Safari/i.test(navigator.userAgent) ? "Safari / WebKit" : "Other"],
    ["HOME SCREEN PWA", standalone ? "Installed mode" : "Browser tab"],
    ["WEBASSEMBLY", typeof WebAssembly !== "undefined" ? "Available" : "Unavailable"],
    ["CACHE STORAGE", "caches" in window ? "Available" : "Unavailable"],
    ["INDEXED STORAGE", "indexedDB" in window ? "Available" : "Unavailable"],
    ["NETWORK", navigator.onLine ? "Online" : "Offline"],
    ["USER AGENT", navigator.userAgent.slice(0, 94) + (navigator.userAgent.length > 94 ? "…" : "")]
  ];
  if (storage?.estimate) {
    storage.estimate().then(({ usage, quota }) => {
      const usageText = `${usage ? formatMB(usage * 1) : "0"} / ${quota ? formatMB(quota) : "?"} MB`;
      items.splice(6, 0, ["SITE STORAGE", usageText]);
      renderDiagnostics(items);
    }).catch(() => renderDiagnostics(items));
  } else renderDiagnostics(items);
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

async function getCachedModelResponse() {
  if (!("caches" in window)) return null;
  try {
    const cache = await caches.open(MODEL_CACHE_NAME);
    return await cache.match(MODEL_CACHE_KEY);
  } catch (error) {
    log(`Could not check model cache: ${error.message}`, "error");
    return null;
  }
}

async function saveModelResponse(stream, headers) {
  if (!("caches" in window)) return false;
  try {
    const cache = await caches.open(MODEL_CACHE_NAME);
    const safeHeaders = new Headers({ "Content-Type": "application/octet-stream" });
    const contentLength = headers?.get?.("content-length");
    if (contentLength) safeHeaders.set("Content-Length", contentLength);
    await cache.put(MODEL_CACHE_KEY, new Response(stream, { status: 200, headers: safeHeaders }));
    return true;
  } catch (error) {
    log(`Browser could not retain the model cache: ${error.message}`, "error");
    return false;
  }
}

function withProgress(sourceStream, totalBytes) {
  const sourceReader = sourceStream.getReader();
  let loaded = 0;
  const monitored = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await sourceReader.read();
        if (done) {
          controller.close();
          setModelProgress(totalBytes || loaded, totalBytes || loaded, "Model download complete");
          return;
        }
        loaded += value.byteLength;
        setModelProgress(loaded, totalBytes, "Downloading Phonon model");
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) { return sourceReader.cancel(reason); }
  });
  return monitored.getReader();
}

async function obtainModelReader() {
  const cached = await getCachedModelResponse();
  if (cached?.body) {
    const size = Number(cached.headers.get("content-length")) || EXPECTED_MODEL_BYTES;
    log("Found a saved model in browser storage.", "success");
    setModelProgress(size, size, "Using saved model");
    els.modelProgressWrap.hidden = false;
    return { reader: cached.body.getReader(), source: "cache" };
  }

  log("Downloading Phonon model from Hugging Face. This is approximately 87 MB.");
  setModelStatus("Downloading the English model. Keep this page open until loading finishes.", "neutral");
  const response = await fetch(MODEL_URL, { mode: "cors", credentials: "omit", cache: "no-store" });
  if (!response.ok) throw new Error(`Model download failed (HTTP ${response.status}).`);
  const total = Number(response.headers.get("content-length")) || EXPECTED_MODEL_BYTES;
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    setModelProgress(buffer.byteLength, buffer.byteLength, "Model downloaded");
    return { reader: new ReadableStream({ start(c) { c.enqueue(buffer); c.close(); } }).getReader(), source: "network-buffer" };
  }

  const [modelStream, cacheStream] = response.body.tee();
  const cachePromise = saveModelResponse(cacheStream, response.headers);
  return {
    reader: withProgress(modelStream, total),
    source: "network",
    cachePromise
  };
}

async function loadModel() {
  if (isLoading || ttsInstance) return;
  isLoading = true;
  els.load.disabled = true;
  els.load.textContent = "Loading model…";
  setModelStatus("Preparing the local speech engine…", "neutral");
  els.modelProgressWrap.hidden = false;
  els.modelProgressFill.classList.remove("indeterminate");
  setModelProgress(0, EXPECTED_MODEL_BYTES, "Preparing model");
  log("Initializing MediaPipe Tasks Audio 1.2.3.");

  try {
    const { FilesetResolver, TextToSpeech } = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@1.2.3/+esm");
    log("MediaPipe JavaScript module loaded.", "success");
    const wasmFileset = await FilesetResolver.forAudioTasks(WASM_URL);
    log("WebAssembly runtime ready.", "success");
    const model = await obtainModelReader();
    setModelStatus("Loading neural model into memory. This can take a little while on mobile.", "neutral");
    const initStart = performance.now();
    ttsInstance = await TextToSpeech.createFromModelBuffer(wasmFileset, model.reader);
    if (model.cachePromise) {
      const cached = await model.cachePromise;
      log(cached ? "Model saved in browser Cache Storage." : "Model loaded, but browser caching was unavailable.", cached ? "success" : "info");
    }
    const initSeconds = ((performance.now() - initStart) / 1000).toFixed(1);
    voices = await ttsInstance.listVoices();
    populateVoices(voices);
    setModelStatus(`Model loaded and ready. Initialization: ${initSeconds}s.`, "good");
    log(`Phonon model initialized in ${initSeconds}s. ${voices.length} voice profile(s) found.`, "success");
    els.generate.disabled = false;
    els.generationEstimate.textContent = "Ready for a short synthesis test.";
    els.voiceRow.hidden = false;
    els.voiceSelect.disabled = false;
    els.load.textContent = "Model loaded ✓";
    if (navigator.storage?.persist) {
      try {
        const persisted = await navigator.storage.persist();
        log(persisted ? "Browser granted persistent storage." : "Browser did not grant persistent storage; it may still retain the model cache.");
      } catch { /* persistence request is optional */ }
    }
    updateDiagnostics();
  } catch (error) {
    console.error(error);
    const message = error?.message || String(error);
    setModelStatus(`Could not load the model: ${message}`, "bad");
    log(`Model load failed: ${message}`, "error");
    els.load.disabled = false;
    els.load.textContent = "Retry model download";
    els.modelProgressFill.classList.add("indeterminate");
  } finally {
    isLoading = false;
  }
}

function populateVoices(list) {
  els.voiceSelect.replaceChildren();
  if (!Array.isArray(list) || list.length === 0) {
    const option = document.createElement("option");
    option.value = "freya"; option.textContent = "Freya (default)";
    els.voiceSelect.append(option);
    log("The model did not return a voice list; using its documented default voice.");
    return;
  }
  list.forEach((voice) => {
    const id = voice.voiceId || voice.id || voice.name;
    if (!id) return;
    const option = document.createElement("option");
    option.value = id;
    option.textContent = voice.displayName ? `${voice.displayName} (${id})` : id;
    els.voiceSelect.append(option);
  });
  if (![...els.voiceSelect.options].some(o => o.value === "freya")) {
    const option = document.createElement("option");
    option.value = "freya"; option.textContent = "Freya (default)";
    els.voiceSelect.append(option);
  }
  els.voiceSelect.value = [...els.voiceSelect.options].some(o => o.value === "freya") ? "freya" : els.voiceSelect.options[0]?.value;
  els.voiceHint.textContent = `${els.voiceSelect.options.length} English voice profiles listed by the model.`;
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

async function generateSpeech() {
  if (!ttsInstance || isGenerating) return;
  const text = els.text.value.trim();
  if (!text) { alert("Enter some text first."); return; }
  if (text.length > MAX_TEXT_CHARS) { alert(`Keep the test under ${MAX_TEXT_CHARS} characters.`); return; }
  isGenerating = true;
  els.generate.disabled = true;
  els.generationProgressWrap.hidden = false;
  els.generationProgressFill.classList.add("indeterminate");
  els.generationStatus.textContent = "Generating speech locally…";
  els.generationResult.hidden = true;
  const started = performance.now();
  const timer = setInterval(() => { els.generationElapsed.textContent = `${((performance.now() - started) / 1000).toFixed(1)}s`; }, 100);
  log(`Generating ${text.length} characters using voice ${els.voiceSelect.value}.`);
  try {
    const result = await ttsInstance.synthesize(text, { voiceId: els.voiceSelect.value || "freya" });
    const elapsed = performance.now() - started;
    lastGenerationMs = elapsed;
    const wav = encodeWav(result.samples, result.sampleRateHz || 24000);
    if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
    currentAudioBlob = wav;
    currentAudioUrl = URL.createObjectURL(wav);
    els.player.pause();
    els.player.src = currentAudioUrl;
    els.player.load();
    const duration = result.samples.length / (result.sampleRateHz || 24000);
    const rtf = duration > 0 ? (elapsed / 1000) / duration : 0;
    els.audioTitle.textContent = `Phonon sample · ${els.voiceSelect.value}`;
    els.audioSubtitle.textContent = `${formatDuration(duration)} · WAV · ${(wav.size / 1024 / 1024).toFixed(2)} MB`;
    els.downloadWav.disabled = false;
    els.clearAudio.disabled = false;
    els.generationStatus.textContent = "Speech generated successfully.";
    els.generationResult.hidden = false;
    els.generationResult.textContent = `Generated ${formatDuration(duration)} of audio in ${(elapsed / 1000).toFixed(2)} seconds. Real-time factor: ${rtf.toFixed(2)}×. Lower than 1.0× means synthesis was faster than playback duration.`;
    els.generationEstimate.textContent = `Last synthesis: ${(elapsed / 1000).toFixed(2)}s`;
    setMediaSessionMetadata();
    log(`Generated ${formatDuration(duration)} audio (${(wav.size / 1024 / 1024).toFixed(2)} MB WAV) in ${(elapsed / 1000).toFixed(2)}s. RTF ${rtf.toFixed(2)}×.`, "success");
  } catch (error) {
    console.error(error);
    els.generationStatus.textContent = "Speech generation failed.";
    els.generationResult.hidden = false;
    els.generationResult.textContent = error?.message || String(error);
    log(`Synthesis failed: ${error?.message || error}`, "error");
  } finally {
    clearInterval(timer);
    els.generationProgressWrap.hidden = true;
    els.generate.disabled = false;
    isGenerating = false;
  }
}

function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function setMediaSessionMetadata() {
  if (!("mediaSession" in navigator)) return;
  try {
    if ("MediaMetadata" in window) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: "Phonon AI Voice Test",
        artist: "LocalVoice Lab",
        album: "PWA Local AI TTS Experiment"
      });
    }
    navigator.mediaSession.setActionHandler("play", () => els.player.play());
    navigator.mediaSession.setActionHandler("pause", () => els.player.pause());
    navigator.mediaSession.setActionHandler("stop", () => els.player.pause());
    navigator.mediaSession.setActionHandler("seekbackward", (details) => { els.player.currentTime = Math.max(0, els.player.currentTime - (details.seekOffset || 10)); });
    navigator.mediaSession.setActionHandler("seekforward", (details) => { els.player.currentTime = Math.min(els.player.duration || Infinity, els.player.currentTime + (details.seekOffset || 10)); });
  } catch (error) { log(`Media Session metadata or controls unavailable: ${error.message}`); }
}

function clearAudio() {
  els.player.pause();
  els.player.removeAttribute("src");
  els.player.load();
  if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
  currentAudioUrl = null; currentAudioBlob = null;
  els.audioTitle.textContent = "No audio generated yet";
  els.audioSubtitle.textContent = "Your generated sample will appear here";
  els.downloadWav.disabled = true; els.clearAudio.disabled = true;
  els.generationResult.hidden = true;
  if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
  log("Generated audio cleared.");
}

async function clearModelCache() {
  if (isLoading || isGenerating) return;
  const confirmed = confirm("Remove the saved Phonon model from this browser? You will need to download it again to generate speech.");
  if (!confirmed) return;
  try {
    if (ttsInstance) { ttsInstance.close(); ttsInstance = null; }
    if ("caches" in window) await caches.delete(MODEL_CACHE_NAME);
    voices = [];
    els.voiceRow.hidden = true; els.voiceSelect.replaceChildren();
    els.generate.disabled = true; els.load.disabled = false; els.load.textContent = "Download & load model";
    els.modelProgressWrap.hidden = true;
    setModelStatus("Saved model removed.", "neutral");
    log("Saved Phonon model cache removed.", "success");
    updateDiagnostics();
  } catch (error) {
    log(`Could not remove model: ${error.message}`, "error");
  }
}

els.load.addEventListener("click", loadModel);
els.clearModel.addEventListener("click", clearModelCache);
els.generate.addEventListener("click", generateSpeech);
els.text.addEventListener("input", updateCharacterCount);
els.downloadWav.addEventListener("click", () => {
  if (!currentAudioBlob) return;
  const link = document.createElement("a");
  link.href = currentAudioUrl; link.download = `phonon-${els.voiceSelect.value || "voice"}-sample.wav`;
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
log("Prototype ready. The Phonon model is not downloaded until you tap the setup button.");
