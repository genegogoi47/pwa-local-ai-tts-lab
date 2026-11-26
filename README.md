# Local AI TTS Lab — Prototype 2

A mobile-first installable PWA experiment for running Google's MediaPipe Text-to-Speech with the Phonon 31M English model in the browser.

## What this prototype tests

1. Downloads the Phonon 31M `.litertlm` model only after the user taps **Download & load model**.
2. Uses MediaPipe Tasks Audio JavaScript SDK `1.2.3` and the official Phonon model hosted by the LiteRT Community on Hugging Face.
3. Stores the model response in a dedicated Cache Storage cache where supported.
4. Enumerates the actual voices exposed by the loaded model (`listVoices()`).
5. Synthesizes a short text sample to 24 kHz mono float32 PCM.
6. Converts the PCM to a 16-bit WAV file and plays it through a normal HTML `<audio>` element.
7. Exposes Media Session metadata/actions where supported so lock-screen controls can be tested.
8. Includes device diagnostics and a test log.

This is a technical proof of concept, not a book reader. It deliberately limits input to 1,200 characters to keep the first mobile test small.

## Deploy to GitHub + Vercel (no build step)

1. Create a new GitHub repository, for example `pwa-local-ai-tts-lab`.
2. Upload the contents of this folder to the repository root. `index.html` must be directly in the root.
3. Import the repository into Vercel.
4. Choose **Other** as Framework Preset. Leave Build Command, Output Directory, and Install Command empty. Root Directory should be `./`.
5. Deploy. Open the HTTPS URL in Safari on iPhone or Chrome on Android.
6. Add it to the Home Screen and launch the installed PWA.

## Test procedure

1. Open the app while online.
2. Tap **Download & load model**. The Phonon model is about 87 MB. Keep the app open until download and model initialization finish.
3. Select one of the model-reported English voices.
4. Leave the default short test text or enter your own short sample (maximum 1,200 characters).
5. Tap **Generate speech** and wait for WAV conversion.
6. Press Play on the audio player.
7. On iPhone, lock the screen for 60–90 seconds and test switching to another app. Check whether audio continues and whether Lock Screen controls appear.
8. Repeat on Android Chrome.
9. Reload the PWA and check whether the model is reused from Cache Storage. Browser storage can still be evicted by the OS/browser.

## Model and runtime URLs

- MediaPipe Tasks Audio JavaScript SDK: `@mediapipe/tasks-audio@1.2.3`
- WebAssembly files: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@1.2.3/wasm`
- Phonon model: `https://huggingface.co/litert-community/phonon-31m-en/resolve/main/phonon_int8.litertlm`
- Official MediaPipe guide: https://developers.google.com/edge/mediapipe/solutions/audio/text_to_speech

The application downloads the model and WebAssembly runtime from those external hosts. TTS inference is performed locally in the browser; this prototype does not send the entered test text to a cloud TTS endpoint. MediaPipe Tasks may collect usage/performance metrics; see Google's MediaPipe privacy notice.

## Model details

Google documents Phonon 31M as an approximately 87 MB INT8 CPU model for English (`en-US`) with five voices: `freya`, `claire`, `lucas`, `lukas`, and `sofia`. The app calls `listVoices()` instead of assuming the model's available voice list.

The model is distributed under Apache 2.0 according to Google's model table. The MediaPipe Tasks Audio npm package is also Apache 2.0. Review the model and SDK notices before redistributing them as part of a commercial product.

## Important limitations

- Background playback is tested with a generated WAV file using HTML audio, not with the model running continuously in the background.
- iOS may suspend the PWA's JavaScript after the app is backgrounded. Therefore, generate the audio clip before locking the screen.
- WAV output is larger than MP3. This prototype uses WAV to avoid adding an audio encoder dependency.
- The model may be too slow or memory-intensive on older or entry-level phones. Record device, generation time, generated audio duration, and real-time factor.
- Cache Storage is not guaranteed permanent. iOS/Android may clear site data. Users can remove the saved model from the prototype.
- Browser, model-host CORS, network, and available memory can affect model loading.

## Reading the real-time factor

`real-time factor = synthesis time / generated audio duration`

- Below `1.0×`: generated faster than playback duration.
- Around `1.0×`: generated at approximately playback speed.
- Above `1.0×`: synthesis is slower than playback duration.

A single short phrase is not enough to approve a phone for long-form audiobook generation. Test longer passages only after the short sample is stable.
