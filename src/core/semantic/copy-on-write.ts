export type CopyOnWriteGeneration<T> = {
  stage: () => Promise<T>;
  cleanup: (generation: T) => Promise<void>;
  activate: (generation: T) => Promise<void>;
};

export async function runCopyOnWriteGeneration<T>(
  generation: CopyOnWriteGeneration<T>,
): Promise<void> {
  const staged = await generation.stage();
  await generation.cleanup(staged);
  await generation.activate(staged);
}
