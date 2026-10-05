import { ConfigError, type Env, loadConfig } from "./config";
import { DeliveryLog } from "./dedupe";
import { isWebhookPayload, noteUrl } from "./misskey";
import {
  createPoster,
  type Poster,
  PosterError,
  type PostResult,
} from "./posters";
import { timingSafeEqual } from "./secret";
import { buildPost, type OutgoingPost, shouldForward } from "./transform";

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

type ClaimResult = "claimed" | "claim-failed" | "duplicate" | "unchecked";

/**
 * KV にノートの転送を引き受けた記録を書く。すでに記録があれば duplicate。
 * KV が使えなくても転送そのものは止めない。障害で記録を確認できないときは、
 * 重複を確認せずに投稿を続ける（unchecked）。無料枠の書き込み上限などで
 * 記録の書き込みだけが失敗したときも投稿を続ける（claim-failed）。
 */
async function claimNote(
  deliveries: DeliveryLog,
  noteId: string,
): Promise<ClaimResult> {
  try {
    if (await deliveries.isClaimed(noteId)) return "duplicate";
  } catch (err) {
    log("error", "dedupe unavailable, posting without it", {
      noteId,
      error: String(err),
    });
    return "unchecked";
  }
  try {
    await deliveries.claim(noteId);
  } catch (err) {
    // 保存されたまま例外になることもあるので、claim-failed として返し、
    // deliver が unavailable のときに削除を試みて、再送が重複として捨てられないようにする
    log("error", "failed to claim, posting anyway", {
      noteId,
      error: String(err),
    });
    return "claim-failed";
  }
  return "claimed";
}

/**
 * 投稿する。再送で投稿し直せる失敗（unavailable）のときだけ記録を消す。
 * 成功したときと結果が不明なときは、再送で二重に投稿しないよう記録を残す。
 * rejected は再送させないので消す必要がなく、同じキーへの余計な書き込みもしない。
 */
async function deliver(
  poster: Poster,
  post: OutgoingPost,
  noteId: string,
  deliveries: DeliveryLog | undefined,
  claim: ClaimResult,
): Promise<PostResult> {
  try {
    return await poster.post(post);
  } catch (err) {
    // 想定外の例外は、投稿先に届いたかどうかわからないので unknown として扱う
    const error =
      err instanceof PosterError
        ? err
        : new PosterError(`unexpected error: ${String(err)}`, "unknown");
    const hasClaim = claim === "claimed" || claim === "claim-failed";
    const canRelease =
      deliveries !== undefined && hasClaim && error.kind === "unavailable";
    if (!canRelease) throw error;

    try {
      await deliveries.release(noteId);
    } catch (releaseErr) {
      log("error", "failed to release claim", {
        noteId,
        error: String(releaseErr),
      });
      // 記録の書き込みに失敗していれば、記録はおそらくない。再送させても、
      // 記録が残っていた場合に重複として捨てられるだけなので、再送で投稿し直せる余地を残す
      if (claim === "claim-failed") throw error;
      // 記録が残ると再送は重複として捨てられるので、再送させずに失敗として残す
      throw new PosterError(
        `${error.message} (claim not released, so retries would be skipped)`,
        "rejected",
        error.status,
        error.detail,
      );
    }
    throw error;
  }
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

  // 重複の防止が効いていたかを、ログから追えるようにする
  let dedupe: ClaimResult | "disabled" | undefined;
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

    // シークレット不足で記録だけが残らないよう、KV に書く前に作る
    const poster = createPoster(env, config, fetcher);
    const deliveries = env.POSTED_NOTES
      ? new DeliveryLog(env.POSTED_NOTES)
      : undefined;
    const claim = deliveries
      ? await claimNote(deliveries, note.id)
      : "unchecked";
    dedupe = deliveries ? claim : "disabled";
    if (claim === "duplicate") {
      log("info", "skipped", { noteId: note.id, reason: "duplicate" });
      return json(200, { skipped: "duplicate" });
    }

    const result = await deliver(poster, post, note.id, deliveries, claim);
    log("info", "posted", {
      noteId: note.id,
      poster: poster.name,
      postId: result.id,
      truncated: post.truncated,
      images: post.imageUrls.length,
      dedupe,
    });
    return json(200, { posted: result.id, poster: poster.name });
  } catch (err) {
    if (err instanceof ConfigError) {
      // 設定を直すまでに再送が終わると取りこぼすので、どのノートか追えるようにする
      log("error", "config error", { noteId: note.id, error: err.message });
      return json(500, { error: "misconfigured" });
    }
    if (err instanceof PosterError) {
      log("error", "post failed", {
        noteId: note.id,
        error: err.message,
        status: err.status,
        kind: err.kind,
        dedupe,
      });
      // Misskey は 5xx のときだけ再送する。再送で投稿し直せるのは unavailable だけで、
      // unknown を再送すると二重投稿になりうるため、rejected と同じく再送させない
      const isRetryable = err.kind === "unavailable";
      return json(isRetryable ? 502 : 422, { error: err.message });
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
