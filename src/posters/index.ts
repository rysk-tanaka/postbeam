import { type Config, ConfigError, type Env } from "../config";
import { BufferPoster } from "./buffer";
import type { Poster } from "./types";
import { XPoster } from "./x";

export type { Poster, PostOptions, PostResult } from "./types";
export { PosterError, type PosterErrorKind } from "./types";

/** Env のうち、値が文字列のもの（シークレットと設定値）の名前 */
type SecretName = {
  [K in keyof Env]-?: Env[K] extends string | undefined ? K : never;
}[keyof Env];

function requireSecrets<K extends SecretName>(
  env: Env,
  names: readonly K[],
): Record<K, string> {
  const secrets = {} as Record<K, string>;
  const missing: K[] = [];
  for (const name of names) {
    const value: string | undefined = env[name];
    if (value) {
      secrets[name] = value;
    } else {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new ConfigError(`missing secrets: ${missing.join(", ")}`);
  }
  return secrets;
}

export function createPoster(
  env: Env,
  config: Config,
  fetcher?: typeof fetch,
): Poster {
  switch (config.poster) {
    case "buffer": {
      const s = requireSecrets(env, ["BUFFER_API_KEY", "BUFFER_CHANNEL_ID"]);
      return new BufferPoster(s.BUFFER_API_KEY, s.BUFFER_CHANNEL_ID, fetcher);
    }
    case "x": {
      const s = requireSecrets(env, [
        "X_API_KEY",
        "X_API_SECRET",
        "X_ACCESS_TOKEN",
        "X_ACCESS_SECRET",
      ]);
      return new XPoster(
        {
          consumerKey: s.X_API_KEY,
          consumerSecret: s.X_API_SECRET,
          token: s.X_ACCESS_TOKEN,
          tokenSecret: s.X_ACCESS_SECRET,
        },
        fetcher,
      );
    }
  }
}
