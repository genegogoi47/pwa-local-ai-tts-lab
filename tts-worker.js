/*
 * MediaPipe Text-to-Speech worker.
 * Inference runs off the UI thread so long CPU work cannot freeze the PWA.
 */
const SDK_VERSION = "1.2.3";
const SDK_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@${SDK_VERSION}/+esm`;
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@${SDK_VERSION}/wasm`;
const MODEL_URL = "https://huggingface.co/litert-community/phonon-31m-en/resolve/main/phonon_int8.litertlm";
const MODEL_CACHE_NAME = "localvoice-phonon-model-v1";
const MODEL_CACHE_KEY = new URL("/__localvoice_model_cache__/phonon_int8.litertlm", self.location.origin).href;
const EXPECTED_MODEL_BYTES = 87 * 1024 * 1024;

let ttsInstance = null;
let initializationPromise = null;
let busy = false;

function send(type, payload = {}, transfer = []) {
  self.postMessage({ type, ...payload }, transfer);
}

function sendLog(message, level = "info") {
  send("log", { message, level });
}

function formatMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function createProgressReader(sourceStream, totalBytes) {
  const reader = sourceStream.getReader();
  let loaded = 0;
  let lastReported = 0;
  const monitored = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          send("download-progress", { loaded: totalBytes || loaded, total: totalBytes || loaded, label: "Model download complete" });
          controller.close();
          return;
        }
        loaded += value.byteLength;
        if (loaded - lastReported >= 1024 * 1024 || (totalBytes && loaded >= totalBytes)) {
          lastReported = loaded;
          send("download-progress", { loaded, total: totalBytes, label: "Downloading Phonon model" });
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    }
  });
  return monitored.getReader();
}

async function getCachedModel() {
  if (!("caches" in self)) return null;
  try {
    const cache = await caches.open(MODEL_CACHE_NAME);
    return await cache.match(MODEL_CACHE_KEY);
  } catch (error) {
    sendLog(`Could not inspect saved model cache: ${error.message}`, "error");
    return null;
  }
}

async function obtainModelReader() {
  const cached = await getCachedModel();
  if (cached?.body) {
    const size = Number(cached.headers.get("content-length")) || EXPECTED_MODEL_BYTES;
    sendLog("Using the saved Phonon model from Cache Storage.", "success");
    send("download-progress", { loaded: size, total: size, label: "Using saved model" });
    return { reader: cached.body.getReader(), cachePromise: null };
  }

  sendLog("Downloading Phonon model from Hugging Face (~87 MB).");
  const response = await fetch(MODEL_URL, { mode: "cors", credentials: "omit", cache: "no-store" });
  if (!response.ok) throw new Error(`Model download failed (HTTP ${response.status}).`);
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    send("download-progress", { loaded: bytes.byteLength, total: bytes.byteLength, label: "Model downloaded" });
    const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    return { reader: stream.getReader(), cachePromise: null };
  }

  const total = Number(response.headers.get("content-length")) || EXPECTED_MODEL_BYTES;
  const [modelStream, cacheStream] = response.body.tee();
  let cachePromise = null;
  if ("caches" in self) {
    cachePromise = (async () => {
      try {
        const cache = await caches.open(MODEL_CACHE_NAME);
        const headers = new Headers({ "Content-Type": "application/octet-stream" });
        const contentLength = response.headers.get("content-length");
        if (contentLength) headers.set("Content-Length", contentLength);
        await cache.put(MODEL_CACHE_KEY, new Response(cacheStream, { status: 200, headers }));
        return true;
      } catch (error) {
        sendLog(`Model loaded, but browser caching failed: ${error.message}`, "info");
        return false;
      }
    })();
  }
  return { reader: createProgressReader(modelStream, total), cachePromise };
}

async function loadModel() {
  if (ttsInstance) {
    send("model-ready", { voices: await ttsInstance.listVoices() });
    return;
  }
  if (initializationPromise) return initializationPromise;
  initializationPromise = (async () => {
    busy = true;
    send("phase", { phase: "loading", message: "Preparing the local speech engine…" });
    sendLog(`Initializing MediaPipe Tasks Audio ${SDK_VERSION} inside a classic Web Worker.`);
    sendLog(`Worker importScripts support: ${typeof importScripts === "function" ? "available" : "unavailable"}.`);
    const { FilesetResolver, TextToSpeech } = await import(SDK_URL);
    sendLog("MediaPipe JavaScript module loaded in worker.", "success");
    const wasmFileset = await FilesetResolver.forAudioTasks(WASM_URL);
    sendLog(`WASM loader resolved: ${wasmFileset.wasmLoaderPath}`);
    sendLog("WebAssembly fileset resolved in classic worker.", "success");
    const model = await obtainModelReader();
    send("phase", { phase: "model-init", message: "Loading neural model into worker memory…" });
    const start = performance.now();
    // Inference and model setup are intentionally isolated from the page's UI thread.
    ttsInstance = await TextToSpeech.createFromModelBuffer(wasmFileset, model.reader);
    sendLog("MediaPipe WASM module factory initialized successfully.", "success");
    if (model.cachePromise) {
      const cached = await model.cachePromise;
      sendLog(cached ? "Model saved in browser Cache Storage." : "Model loaded; persistent cache was unavailable.", cached ? "success" : "info");
    }
    const voices = await ttsInstance.listVoices();
    const elapsed = ((performance.now() - start) / 1000).toFixed(1);
    sendLog(`Phonon initialized in ${elapsed}s. ${voices.length} voice profile(s) found.`, "success");
    send("model-ready", { voices, elapsedSeconds: Number(elapsed) });
  })();

  try {
    await initializationPromise;
  } finally {
    initializationPromise = null;
    busy = false;
  }
}

async function synthesize({ text, voiceId }) {
  if (!ttsInstance) throw new Error("The Phonon model is not loaded in the worker.");
  if (busy) throw new Error("The speech engine is busy. Wait for the current task to finish.");
  busy = true;
  const selectedVoice = voiceId || "freya";
  const started = performance.now();
  send("synthesis-start", { characters: text.length, voiceId: selectedVoice });
  sendLog(`Starting synthesis in Web Worker: ${text.length} characters, voice ${selectedVoice}.`);
  try {
    const result = await ttsInstance.synthesize(text, { voiceId: selectedVoice });
    const elapsedMs = performance.now() - started;
    if (!result?.samples || !result.samples.length) {
      throw new Error("The model returned an empty audio sample.");
    }
    const samples = new Float32Array(result.samples);
    sendLog(`Worker synthesis completed: ${samples.length.toLocaleString()} samples in ${(elapsedMs / 1000).toFixed(2)}s.`, "success");
    send("synthesis-result", {
      samplesBuffer: samples.buffer,
      sampleRateHz: result.sampleRateHz || 24000,
      elapsedMs,
      voiceId: selectedVoice
    }, [samples.buffer]);
  } catch (error) {
    sendLog(`Synthesis failed in worker: ${error?.message || String(error)}`, "error");
    send("synthesis-error", { message: error?.message || String(error) });
  } finally {
    busy = false;
  }
}

async function clearModel() {
  if (busy) throw new Error("Wait for the current model operation to finish before clearing it.");
  if (ttsInstance) {
    ttsInstance.close();
    ttsInstance = null;
  }
  if ("caches" in self) await caches.delete(MODEL_CACHE_NAME);
  sendLog("Saved Phonon model cache removed.", "success");
  send("model-cleared");
}

self.addEventListener("message", async (event) => {
  const { type, ...payload } = event.data || {};
  try {
    if (type === "load-model") await loadModel();
    else if (type === "synthesize") await synthesize(payload);
    else if (type === "clear-model") await clearModel();
    else if (type === "cancel") {
      ttsInstance?.cancel();
      sendLog("Cancellation requested.");
    }
  } catch (error) {
    send("worker-error", { phase: type === "load-model" ? "load" : type, message: error?.message || String(error) });
  }
});
