export interface ToolBinaryAsset { url: string; sha256?: string; archive?: 'tar.gz' | 'zip' | 'none'; binPath?: string; }
export interface ToolEntry {
  name: string;
  description: string;
  kind: 'binary' | 'npm' | 'script';
  binary?: Record<string, ToolBinaryAsset>; // platform key -> asset
  npm?: { package: string; version?: string };
  script?: { install: string };
  bins: string[];
  authEnv?: string[];
  envAlias?: Record<string, string>; // CLI-expected var -> source env var name
  docs?: string;
}
export interface ToolStatus {
  name: string;
  description: string;
  kind: ToolEntry['kind'];
  installed: boolean;
  version?: string;
  authed: boolean;
  docs?: string;
}
