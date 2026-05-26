/**
 * Noise-level gate for incoming audio chunks.
 *
 * Stub: always returns false (never too noisy). Will later be backed by a
 * Transformers.js audio classifier (e.g. YAMNet) that distinguishes music
 * from speech/crowd/silence. Keep this interface stable — the rest of the
 * app already treats a `true` return as "pause recognition and show the
 * too-noisy banner".
 *
 * @param {Blob} audioBlob - raw WAV blob from useAudioCapture
 * @returns {Promise<boolean>} - true if the clip is too noisy to identify
 */
export async function checkIfTooNoisy(audioBlob) {
  // intentionally unused until the model lands
  void audioBlob;
  return false;
}
