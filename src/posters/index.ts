import { type Config, ConfigError, type Env } from "../config";
import { BufferPoster } from "./buffer";
import type { Poster } from "./types";
import { XPoster } from "./x";

export type { Poster, PostResult } from "./types";
export { PosterError } from "./types";

function required(env: Env, names: (keyof Env)[]): string[] {
  const missing = names.filter((n) => !env[n]);
  if (missing.length > 0) {
    throw new ConfigError(`missing secrets: ${missing.join(", ")}`);
  }
  return names.map((n) => env[n] as string);
}

export function createPoster(
  env: Env,
  config: Config,
  fetcher?: typeof fetch,
): Poster {
  switch (config.poster) {
    case "buffer": {
      const [apiKey, channelId] = required(env, [
        "BUFFER_API_KEY",
        "BUFFER_CHANNEL_ID",
      ]);
      return new BufferPoster(apiKey as string, channelId as string, fetcher);
    }
    case "x": {
      const [consumerKey, consumerSecret, token, tokenSecret] = required(env, [
        "X_API_KEY",
        "X_API_SECRET",
        "X_ACCESS_TOKEN",
        "X_ACCESS_SECRET",
      ]);
      return new XPoster(
        {
          consumerKey: consumerKey as string,
          consumerSecret: consumerSecret as string,
          token: token as string,
          tokenSecret: tokenSecret as string,
        },
        fetcher,
      );
    }
  }
}
