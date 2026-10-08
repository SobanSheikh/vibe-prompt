const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;

export const MIN_PREVIEW_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * 2;
export const MAX_PREVIEW_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * 60;

export function previewAudio(pcm: Buffer): Buffer | undefined {
  if (pcm.length < MIN_PREVIEW_BYTES || pcm.length > MAX_PREVIEW_BYTES) {
    return undefined;
  }
  return pcm;
}

export function shouldApplyPreview(
  previewGeneration: number,
  currentGeneration: number,
  phase: string,
): boolean {
  return previewGeneration === currentGeneration && phase === "recording";
}
