import { ConfigError, type Env, loadConfig } from "./config";
import { DeliveryLog } from "./dedupe";
import { isWebhookPayload, noteUrl } from "./misskey";
import {
  createPoster,
  type Poster,
  PosterError,
  type PostOptions,
  type PostResult,
} from "./posters";
import { truncate } from "./posters/fetch";
import { timingSafeEqual } from "./secret";
import { buildPost, type OutgoingPost, shouldForward } from "./transform";

const SECRET_HEADER = "X-Misskey-Hook-Secret";

// 投稿先との通信の上限は webhook の受信から数え、KV の操作が遅れたぶんも含める。
// Misskey は 5 秒で切断し、無応答として再送する。記録がないと再送を重複として防げないため、
// 5 秒に収まるよう打ち切る
const UNCLAIMED_BUDGET_MS = 4000;
// 記録があれば再送は重複としてスキップされるので、切断後も waitUntil の 30 秒の猶予の中で長めに待つ。
// 遅れて届く確定した応答（503 など）を取りこぼさないためで、記録の削除の時間は残す。
// Misskey の再送が 60 秒以上あとに来る前提で、それより早く再送が届くと、
// 削除が間に合わずに重複としてスキップされることがある
const CLAIMED_BUDGET_MS = 20_000;
// 投稿先との通信は往復だけで数百 ms かかるため、これより短いと成功しうる投稿まで打ち切ってしまう
const MIN_REQUEST_TIMEOUT_MS = 1000;

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

interface ClaimOutcome {
  result: ClaimResult;
  /** duplicate のとき、記録から読めた前回の記録の日時 */
  claimedAt?: string;
}

/**
 * KV にノートの転送を引き受けた記録を書く。すでに記録があれば duplicate。
 * KV が使えなくても転送そのものは止めない。障害で記録を確認できないときは、
 * 重複を確認せずに投稿を続ける（unchecked）。無料枠の書き込み上限などで
 * 記録の書き込みだけが失敗したときも投稿を続ける（claim-failed）。
 */
async function claimNote(
  deliveries: DeliveryLog,
  noteId: string,
): Promise<ClaimOutcome> {
  try {
    const existing = await deliveries.findClaim(noteId);
    if (existing) {
      return { result: "duplicate", claimedAt: existing.claimedAt };
    }
  } catch (err) {
    log("error", "dedupe unavailable, continuing without it", {
      noteId,
      error: String(err),
    });
    return { result: "unchecked" };
  }
  try {
    await deliveries.claim(noteId);
  } catch (err) {
    // 保存されたまま例外になることもあるので、claim-failed として返し、
    // unavailable のときに削除を試みて、再送が重複として捨てられないようにする
    log("error", "failed to claim, continuing without it", {
      noteId,
      error: String(err),
    });
    return { result: "claim-failed" };
  }
  return { result: "claimed" };
}

/** 想定外の例外は、投稿先に届いたかどうかわからないので unknown として扱う */
async function deliver(
  poster: Poster,
  post: OutgoingPost,
  options: PostOptions,
): Promise<PostResult> {
  try {
    return await poster.post(post, options);
  } catch (err) {
    if (err instanceof PosterError) throw err;
    throw new PosterError(
      `unexpected error: ${String(err)}`,
      "unknown",
      undefined,
      undefined,
      err,
    );
  }
}

/**
 * 記録を消す。応答を返した後も waitUntil で続けるため、失敗はログに残すだけにする。
 * 消せなかった記録が残ると、再送は重複としてスキップされる。
 */
async function releaseClaim(
  deliveries: DeliveryLog,
  noteId: string,
  claim: Extract<ClaimResult, "claimed" | "claim-failed">,
  postError: Pick<PosterError, "message" | "kind" | "status">,
): Promise<void> {
  try {
    await deliveries.release(noteId);
  } catch (err) {
    // この 1 行で取りこぼしかどうかと元の失敗がわかるようにする。
    // 記録の書き込みに失敗していた（claim-failed）なら記録はおそらくなく、再送で投稿し直されうる。
    // ただし保存されたまま例外になっていれば、再送はスキップされる
    log("error", "failed to release claim", {
      noteId,
      error: String(err),
      dedupe: claim,
      retries: claim === "claimed" ? "skipped" : "may-repost",
      postError: limitText(postError.message),
      kind: postError.kind,
      status: postError.status,
    });
  }
}

const MAX_DETAIL_LENGTH = 1000;
const MAX_MESSAGE_LENGTH = 500;

/** 投稿先のエラーの全文が入りうるため、ログと応答が膨らみすぎないよう切り詰める */
function limitText(text: string): string {
  return truncate(text, MAX_MESSAGE_LENGTH);
}

/** 投稿先の応答が大きくても、ログ 1 行が膨らみすぎないよう切り詰める */
function limitDetail(detail: unknown): unknown {
  if (detail === undefined) return undefined;
  let text: string | undefined;
  try {
    text = JSON.stringify(detail);
  } catch {
    // 循環参照などで JSON にできなくても、エラー処理の途中で例外を出さない
  }
  if (text === undefined) return String(detail);
  if (text.length <= MAX_DETAIL_LENGTH) return detail;
  return truncate(text, MAX_DETAIL_LENGTH);
}

function stackOf(err: unknown): string | undefined {
  // DOMException が Error を継承しない環境もあるため、stack の有無だけで判定する
  const stack = (err as { stack?: unknown } | null)?.stack;
  return typeof stack === "string" ? stack : undefined;
}

export async function handleRequest(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  fetcher?: typeof fetch,
): Promise<Response> {
  // 投稿先のタイムアウトに、KV の操作などにかかった時間も含めるため
  const receivedAt = Date.now();
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

  // 重複の防止が効いていたかをログから追えるようにし、unavailable のときに記録を消すかどうかの判定にも使う
  let dedupe: ClaimResult | "disabled" | undefined;
  let deliveries: DeliveryLog | undefined;
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
    deliveries = env.POSTED_NOTES
      ? new DeliveryLog(env.POSTED_NOTES)
      : undefined;
    const claim: ClaimOutcome = deliveries
      ? await claimNote(deliveries, note.id)
      : { result: "unchecked" };
    dedupe = deliveries ? claim.result : "disabled";
    if (claim.result === "duplicate") {
      log("info", "skipped", {
        noteId: note.id,
        reason: "duplicate",
        claimedAt: claim.claimedAt,
      });
      return json(200, { skipped: "duplicate" });
    }

    const elapsedMs = Date.now() - receivedAt;
    const isClaimed = claim.result === "claimed";
    const remainingMs =
      (isClaimed ? CLAIMED_BUDGET_MS : UNCLAIMED_BUDGET_MS) - elapsedMs;
    if (!isClaimed && remainingMs < MIN_REQUEST_TIMEOUT_MS) {
      // 記録がないまま Misskey の切断に間に合わない。投稿すると再送と二重になるため、
      // 投稿せずに再送に任せる。投稿していないことは確実なので unavailable にする
      throw new PosterError(
        `not posted: ${elapsedMs}ms passed before posting without a claim`,
        "unavailable",
      );
    }
    const timeoutMs = Math.max(remainingMs, MIN_REQUEST_TIMEOUT_MS);
    const result = await deliver(poster, post, { timeoutMs });
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
        error: limitText(err.message),
        status: err.status,
        kind: err.kind,
        dedupe,
        detail: limitDetail(err.detail),
        stack: stackOf(err.cause),
      });
      // Misskey は 5xx のときだけ再送する。再送で投稿し直せるのは unavailable だけで、
      // unknown を再送すると二重投稿になりうるため、rejected と同じく再送させない
      const isRetryable = err.kind === "unavailable";
      // 記録を消して、再送で投稿し直せるようにする。成功したときと結果が不明なときは、
      // 再送で二重に投稿しないよう残す。rejected は再送させないので消さない
      const claim = dedupe;
      const hasClaim = claim === "claimed" || claim === "claim-failed";
      if (isRetryable && deliveries && hasClaim) {
        // 応答を遅らせると Misskey の 5 秒のタイムアウトに近づくため、削除の完了を待たない
        // 投稿先の応答の全文（detail）を削除が終わるまで持ち続けないよう、ログに使う項目だけを渡す
        const { message, kind, status } = err;
        ctx.waitUntil(
          releaseClaim(deliveries, note.id, claim, { message, kind, status }),
        );
      }
      return json(isRetryable ? 502 : 422, { error: limitText(err.message) });
    }
    log("error", "unexpected error", {
      noteId: note.id,
      error: String(err),
      stack: stackOf(err),
    });
    return json(502, { error: "upstream failure" });
  }
}

export default {
  fetch(request, env, ctx) {
    const response = handleRequest(request, env, ctx);
    // Misskey が 5 秒で切断しても、記録・投稿・ログを途中で打ち切らせない
    ctx.waitUntil(response.catch(() => {}));
    return response;
  },
} satisfies ExportedHandler<Env>;
