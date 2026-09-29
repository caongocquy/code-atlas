import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";

export type PromoteBaselineOptions = {
  candidateJsonPath: string;
  candidateMarkdownPath: string;
  baselineJsonPath: string;
  baselineMarkdownPath: string;
  confirmReviewed?: boolean;
};

export async function promoteReviewedBaseline(options: PromoteBaselineOptions): Promise<void> {
  if (!options.confirmReviewed) throw new Error("Baseline promotion requires explicit review confirmation");
  const destinations = [path.resolve(options.baselineJsonPath), path.resolve(options.baselineMarkdownPath)];
  await Promise.all(destinations.map((destination) => mkdir(path.dirname(destination), { recursive: true })));
  let copiedJson = false;
  try {
    await copyFile(path.resolve(options.candidateJsonPath), destinations[0]!, constants.COPYFILE_EXCL);
    copiedJson = true;
    await copyFile(path.resolve(options.candidateMarkdownPath), destinations[1]!, constants.COPYFILE_EXCL);
  } catch (error) {
    if (copiedJson) {
      const { unlink } = await import("node:fs/promises");
      await unlink(destinations[0]!).catch(() => undefined);
    }
    throw new Error("Baseline already exists or candidate could not be promoted; reviewed baselines are never overwritten", { cause: error });
  }
}
