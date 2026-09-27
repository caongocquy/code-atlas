import { createThumbnail, createWaveform, publishPreview, transcodeAsset } from "./processing.js";

export function routeMediaJob(kind: "image" | "audio"): string {
  return kind === "image" ? createThumbnail() : createWaveform();
}

export function makePreviewAvailable(): string {
  transcodeAsset();
  return publishPreview();
}

export function transcodeForArchive(): string {
  return transcodeAsset();
}
