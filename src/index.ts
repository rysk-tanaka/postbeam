import { ConfigError, type Env, loadConfig } from "./config";
import { isWebhookPayload, noteUrl } from "./misskey";
import { createPoster, PosterError } from "./posters";
import { timingSafeEqual } from "./secret";
import { buildPost, shouldForward } from "./transform";

const SECRET_HEADER = "X-Misskey-Hook-Secret";

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function log(level: "info" | "warn" | "error", msg: string, extra = {}) {
  console[level](JSON.stringify({ level, msg, ...extra }));
}

export async function handleRequest(
  request: Request,
  env: Env,
  fetcher?: typeof fetch,
): Promise<Response> {
  if (request.method !== "POST") {
    return json(405, { error: "method not allowed" });
  }

  const provided = request.headers.get(SECRET_HEADER) ?? "";
  if (
    !env.MISSKEY_HOOK_SECRET ||
    !timingSafeEqual(provided, env.MISSKEY_HOOK_SECRET)
  ) {
    log("warn", "invalid webhook secret");
    return json(401, { error: "unauthorized" });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "invalid json" });
  }
  if (!isWebhookPayload(payload)) {
    return json(400, { error: "unexpected payload" });
  }

  if (payload.type !== "note" || !payload.body.note) {
    return json(200, { skipped: `event:${payload.type}` });
  }
  const note = payload.body.note;

  // Misskey の設定画面の「テスト送信」はダミーのノートを送ってくる
  if (note.id.startsWith("dummy-")) {
    log("info", "test webhook received", { noteId: note.id });
    return json(200, { skipped: "test-event" });
  }

  try {
    const config = loadConfig(env);
    const filter = shouldForward(note, config);
    if (!filter.ok) {
      log("info", "skipped", { noteId: note.id, reason: filter.reason });
      return json(200, { skipped: filter.reason });
    }

    const link = noteUrl(note, payload.server ?? config.misskeyUrl);
    const post = buildPost(note, config, link);
    if (!post.text && post.imageUrls.length === 0) {
      return json(200, { skipped: "empty" });
    }

    const poster = createPoster(env, config, fetcher);
    const result = await poster.post(post);
    log("info", "posted", {
      noteId: note.id,
      poster: poster.name,
      postId: result.id,
      truncated: post.truncated,
      images: post.imageUrls.length,
    });
    return json(200, { posted: result.id, poster: poster.name });
  } catch (err) {
    if (err instanceof ConfigError) {
      log("error", "config error", { error: err.message });
      return json(500, { error: "misconfigured" });
    }
    if (err instanceof PosterError) {
      log("error", "post failed", {
        noteId: note.id,
        error: err.message,
        status: err.status,
      });
      // 投稿先の一時的な障害だけ 5xx を返し、Misskey に再送してもらう
      const retryable =
        err.status === undefined || err.status >= 500 || err.status === 429;
      return json(retryable ? 502 : 422, { error: err.message });
    }
    log("error", "unexpected error", { noteId: note.id, error: String(err) });
    return json(502, { error: "upstream failure" });
  }
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
