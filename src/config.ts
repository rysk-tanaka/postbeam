export interface Env {
  // シークレット
  MISSKEY_HOOK_SECRET: string;
  BUFFER_API_KEY?: string;
  BUFFER_CHANNEL_ID?: string;
  X_API_KEY?: string;
  X_API_SECRET?: string;
  X_ACCESS_TOKEN?: string;
  X_ACCESS_SECRET?: string;

  // 設定値（wrangler.toml の [vars]）
  POSTER?: string;
  VISIBILITIES?: string;
  CW_MODE?: string;
  INCLUDE_REPLIES?: string;
  EXCLUDE_TAGS?: string;
  APPEND_LINK?: string;
  ATTACH_SENSITIVE?: string;
  STRIP_CUSTOM_EMOJI?: string;
  /** webhook の payload に server が含まれない古い Misskey 向け */
  MISSKEY_URL?: string;
}

export type PosterKind = "buffer" | "x";
export type CwMode = "skip" | "include";
export type AppendLink = "never" | "truncated" | "always";

export interface Config {
  poster: PosterKind;
  visibilities: ReadonlySet<string>;
  cwMode: CwMode;
  includeReplies: boolean;
  excludeTags: ReadonlySet<string>;
  appendLink: AppendLink;
  attachSensitive: boolean;
  stripCustomEmoji: boolean;
  misskeyUrl?: string;
}

export class ConfigError extends Error {}

function parseList(value: string | undefined, fallback: string): Set<string> {
  return new Set(
    (value ?? fallback)
      .split(",")
      .map((s) => s.trim().toLowerCase().replace(/^#/, ""))
      .filter((s) => s.length > 0),
  );
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return ["true", "1", "yes"].includes(value.trim().toLowerCase());
}

function parseEnum<T extends string>(
  name: string,
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined || value === "") return fallback;
  const v = value.trim().toLowerCase();
  if ((allowed as readonly string[]).includes(v)) return v as T;
  throw new ConfigError(`${name} must be one of: ${allowed.join(", ")}`);
}

export function loadConfig(env: Env): Config {
  return {
    poster: parseEnum("POSTER", env.POSTER, ["buffer", "x"], "buffer"),
    visibilities: parseList(env.VISIBILITIES, "public,home"),
    cwMode: parseEnum("CW_MODE", env.CW_MODE, ["skip", "include"], "skip"),
    includeReplies: parseBool(env.INCLUDE_REPLIES, false),
    excludeTags: parseList(env.EXCLUDE_TAGS, "nox"),
    appendLink: parseEnum(
      "APPEND_LINK",
      env.APPEND_LINK,
      ["never", "truncated", "always"],
      "never",
    ),
    attachSensitive: parseBool(env.ATTACH_SENSITIVE, false),
    stripCustomEmoji: parseBool(env.STRIP_CUSTOM_EMOJI, true),
    misskeyUrl: env.MISSKEY_URL?.replace(/\/+$/, "") || undefined,
  };
}
