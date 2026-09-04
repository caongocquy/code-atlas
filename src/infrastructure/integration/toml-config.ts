import { parse, stringify, type TomlTableWithoutBigInt } from "smol-toml";

import {
  readConfigFile,
  type ConfigFile,
  ConfigParseError,
  writeConfigFile,
} from "./config-file.js";

export type TomlObject = Record<string, unknown>;

function isTomlObject(value: unknown): value is TomlObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readTomlConfig(configPath: string): Promise<{ file: ConfigFile; value: TomlObject }> {
  const file = await readConfigFile(configPath);
  if (!file.exists || file.text.trim() === "") return { file, value: {} };
  try {
    const value = parse(file.text) as TomlTableWithoutBigInt;
    if (!isTomlObject(value)) throw new Error("root value must be a table");
    return { file, value };
  } catch (error) {
    throw new ConfigParseError(file.path, error instanceof Error ? error.message : String(error));
  }
}

export async function writeTomlValue(
  configPath: string,
  key: string,
  value: unknown,
): Promise<boolean> {
  const current = await readTomlConfig(configPath);
  const servers = current.value.mcp_servers;
  if (servers !== undefined && !isTomlObject(servers)) {
    throw new ConfigParseError(current.file.path, "mcp_servers must be a table");
  }
  const currentServers = (servers ?? {}) as TomlObject;
  if (JSON.stringify(currentServers[key]) === JSON.stringify(value)) return false;

  const updated = {
    ...current.value,
    mcp_servers: {
      ...currentServers,
      [key]: value,
    },
  };
  await writeConfigFile(
    current.file,
    `${stringify(updated)}\n`,
  );
  return true;
}

export async function removeTomlValue(configPath: string, key: string): Promise<boolean> {
  const current = await readTomlConfig(configPath);
  const servers = current.value.mcp_servers;
  if (!isTomlObject(servers) || !(key in servers)) return false;
  const nextServers = { ...servers };
  delete nextServers[key];
  const updated = { ...current.value, mcp_servers: nextServers };
  await writeConfigFile(current.file, `${stringify(updated)}\n`);
  return true;
}
