export interface DrillConfig {
  accountId: string;
  sourceNamespaceId: string;
  drillNamespaceId: string;
  bucket: string;
}
export function parseBackupLocalConfig(text: string): DrillConfig;
export function readDrillConfig(path: string): Promise<DrillConfig>;
