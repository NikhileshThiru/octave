import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Mic capture + a live AnalyserNode for the visualizer.
 *
 * Audio graph (built once in initStream, torn down in stop):
 *
 *     mic source ─┬─> analyser (visualizer reads frequency data per frame)
 *                 └─> processor (one persistent ScriptProcessor that
 *                                fans out chunks to every active subscriber)
 *
 * Each `recordClip(seconds)` call subscribes to the processor and resolves
 * once it has accumulated `seconds` worth of samples. Subscribers run
 * concurrently — that's how the listen loop pipelines the next recording
 * against the previous /identify request, hiding the network RTT.
 *
 * Public API:
 *   { ready, error, analyser, recordClip(seconds) -> Promise<Blob|null>, stop() }
 *
 * `recordClip` resolves to `null` if the mic is torn down mid-recording.
 */

const TARGET_SAMPLE_RATE = 16000;

export function useAudioCapture() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);
  const [analyser, setAnalyser] = useState(null);

  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const sourceRef = useRef(null);
  const analyserRef = useRef(null);
  const processorRef = useRef(null);
  const subscribersRef = useRef(new Set());
  const inputSampleRateRef = useRef(48000);

  const initStream = useCallback(async () => {
    if (streamRef.current) return streamRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
      streamRef.current = stream;

      // Defensive: some platforms hand back tracks with .enabled = false
      // (Bluetooth handoffs, prior call state, certain Android stacks).
      // A disabled track produces silence even though the source is "live."
      for (const track of stream.getAudioTracks()) {
        if (!track.enabled) track.enabled = true;
      }

      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      // Browsers (Safari especially, Chrome under autoplay policy) construct
      // the AudioContext in a "suspended" state until explicitly resumed
      // inside a user gesture. initStream is always called from the Listen
      // click handler, so resuming here is the right place — without this,
      // the analyser receives no frames and getByteFrequencyData returns a
      // flat zero array regardless of mic input.
      if (ctx.state === "suspended") {
        try {
          await ctx.resume();
        } catch {
          // resume() can reject in obscure cases (e.g. tab backgrounded
          // between the click and the await); the source will still be
          // wired and a later interaction will revive it.
        }
      }
      audioCtxRef.current = ctx;
      inputSampleRateRef.current = ctx.sampleRate;

      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;

      // Visualizer analyser — independent fan-out from the source.
      //
      // Default min/max dB (-100/-30) is calibrated for music-level signals
      // and leaves conversational speech sitting in the bottom third of the
      // byte-data range. Tightening to -80/-25 compresses the input so
      // everyday voices and ambient sound visibly drive the wave.
      const analyserNode = ctx.createAnalyser();
      analyserNode.fftSize = 2048;
      // Very low internal smoothing → snappy frame-to-frame response so
      // speech transients aren't damped before the visualizer sees them.
      analyserNode.smoothingTimeConstant = 0.25;
      // Wide dB window biased toward the quiet end. -90 dB floor catches
      // ambient room signal and quiet speech; -15 dB ceiling means even
      // dramatic peaks have room to register without clipping at the top.
      analyserNode.minDecibels = -90;
      analyserNode.maxDecibels = -15;
      source.connect(analyserNode);
      analyserRef.current = analyserNode;
      setAnalyser(analyserNode);

      // Single persistent ScriptProcessor. Each onaudioprocess fans the
      // latest 4096-sample chunk to every active subscriber. Subscribers
      // resolve once they've collected `targetSamples` worth.
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        const subs = subscribersRef.current;
        if (subs.size === 0) return;
        // Copy out — the underlying buffer is reused by the audio thread.
        const chunk = new Float32Array(e.inputBuffer.getChannelData(0));
        // Snapshot the iteration set so resolving subscribers don't mutate
        // it under us.
        const snapshot = Array.from(subs);
        for (const sub of snapshot) {
          sub.chunks.push(chunk);
          sub.samplesAccumulated += chunk.length;
          if (sub.samplesAccumulated >= sub.targetSamples) {
            subs.delete(sub);
            sub.resolve(sub.chunks);
          }
        }
      };
      source.connect(processor);
      // Required for Safari to actually fire onaudioprocess callbacks.
      processor.connect(ctx.destination);
      processorRef.current = processor;

      setReady(true);
      setError(null);
      return stream;
    } catch (err) {
      const msg =
        err && err.name === "NotAllowedError"
          ? "Microphone access was blocked. Allow it in your browser settings to listen."
          : `Couldn't access the microphone: ${err.message || err}`;
      setError(msg);
      throw err;
    }
  }, []);

  const recordClip = useCallback(
    async (seconds = 5) => {
      await initStream();
      const inputRate = inputSampleRateRef.current;
      const targetSamples = Math.ceil(inputRate * seconds);

      const chunks = await new Promise((resolve) => {
        subscribersRef.current.add({
          targetSamples,
          chunks: [],
          samplesAccumulated: 0,
          resolve,
        });
      });

      if (!chunks) return null; // mic torn down mid-recording

      const merged = mergeFloat32(chunks);
      const downsampled = downsample(merged, inputRate, TARGET_SAMPLE_RATE);
      return encodeWav(downsampled, TARGET_SAMPLE_RATE);
    },
    [initStream]
  );

  const stop = useCallback(() => {
    // Cancel anything still waiting for samples.
    for (const sub of subscribersRef.current) sub.resolve(null);
    subscribersRef.current.clear();

    if (processorRef.current) {
      try {
        processorRef.current.disconnect();
      } catch {
        // already disconnected
      }
      processorRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    sourceRef.current = null;
    analyserRef.current = null;
    setAnalyser(null);
    setReady(false);
  }, []);

  useEffect(() => () => stop(), [stop]);

  return { ready, error, analyser, recordClip, stop };
}

function mergeFloat32(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function downsample(buffer, inputRate, outputRate) {
  if (outputRate >= inputRate) return buffer;
  const ratio = inputRate / outputRate;
  const newLen = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLen);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < newLen) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: "audio/wav" });
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}
