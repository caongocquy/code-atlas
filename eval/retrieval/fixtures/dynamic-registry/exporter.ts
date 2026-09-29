export type Exporter = () => string;

export function exportReport(registry: Record<string, Exporter>, key: string): string {
  return registry[key]();
}
