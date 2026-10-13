# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

postbeam は Misskey の webhook を受け取り、ノートを整形して Buffer API（既定）または X API へ転送する Cloudflare Worker。投稿元・投稿先を将来増やせるよう、投稿先は `Poster` インターフェースで抽象化している。

## コマンド

```bash
# 依存関係インストール
pnpm install

# ローカル起動（.dev.vars にシークレットが必要。.dev.vars.example を参照）
pnpm dev

# テスト実行
pnpm test

# 単一テストファイル実行
pnpm test test/transform.test.ts

# 特定の describe/test のみ実行
pnpm test -t "stripMfm"

# 型チェック
pnpm typecheck

# lint（Biome + markdownlint 一括実行）
pnpm lint

# lint 自動修正
pnpm lint:fix

# wrangler のドライラン（バンドルできるかの確認）
pnpm build

# デプロイ
pnpm run deploy
```

テストフレームワーク: Vitest（`test/` ディレクトリ、Node 環境で実行）

## アーキテクチャ

```text
src/index.ts::handleRequest(request, env, ctx, fetcher?)
  → POST 以外は 405
  → X-Misskey-Hook-Secret を timingSafeEqual で検証（不一致は 401）
  → payload.type が "note" 以外はスキップ
  → ダミーノート（id が "dummy-" で始まる）はスキップ
  → loadConfig(env) で [vars] を解釈
  → shouldForward(note, config) で転送対象か判定
  → buildPost(note, config, link) で本文と画像 URL を組み立てる
  → createPoster(env, config)
  → DeliveryLog（KV）に記録のあるノートはスキップし、なければ記録する（KV がない・障害時は確認しない）
  → 受信からの経過で投稿先の上限（timeoutMs）を決める。記録がなく残りが 1 秒未満なら、投稿せずに unavailable
  → poster.post(post, { timeoutMs })。再送で投稿し直せる失敗（unavailable）で、記録を書き込んだか書き込みを試みた（claimed / claim-failed）ときだけ、削除を ctx.waitUntil に登録し、完了を待たずに応答する
```

Worker の `fetch` は、`handleRequest` の処理全体を `ctx.waitUntil` にも登録する。Misskey が 5 秒で切断しても、最大 30 秒は記録・投稿・ログを続ける。

- `src/config.ts` — `Env`（シークレットと [vars]）の型と `loadConfig()`。不正な値は `ConfigError` を投げる
- `src/misskey.ts` — Misskey の webhook payload とノートの型（必要な項目のみ）
- `src/transform.ts` — 転送判定（`shouldForward`）と整形（`stripMfm` / `stripCustomEmoji` / `defuseMentions` / `buildPost`）。`stripCustomEmoji` と `defuseMentions` は URL の外側だけを置換する。`findUrls` が URL にしない国際化ドメインの URL なども X はリンクにするため、`stripCustomEmoji` はプロトコルで始まる走査のかたまりの中も書き換えない。リンク記法の前後と、詰めて取り除くカスタム絵文字の跡に空白を入れるかは、前後の本文とつなげたときに、`findUrls` と同じ走査で URL と認める範囲か消費する範囲が変わるかで決める（URL でなくなる場合と、`findUrls` が URL にしないリンク先を含む）。手前の `@` には後でゼロ幅スペースが入るので、入れた後の本文でも確かめる。まだ残っている目印は消える場合と空白になる場合の両方で確かめる。同じ語の中に並ぶ絵文字の跡も目印にして、同じように確かめる。リンクの直後の `#`・`＃`・`$` と、絵文字の跡の直後の `#`・`＃` は、詰めると X がハッシュタグやキャッシュタグとして読まなくなるので、確かめずに区切る。手前の語がハッシュタグやキャッシュタグで終わるときも、詰めるとタグが変わるか消えるので区切る。崩れた MFM で判定できずに残ったリンクの後ろの目印は、空白にする。つなげたときに後ろの結合文字が手前の文字と合成される（NFC の結果が変わる）ときも区切る。正規化で URL の直前の文字が変わると、X が URL とみなす範囲が変わるため、`buildPost` は X と同じく NFC に正規化してから整形と無害化をする。空白のない長い本文で時間がかからないよう、`.` を含まない語は走査せず、走査する文字数には `stripMfm` と `stripCustomEmoji` の呼び出しごとに上限を設け、超えたら確かめずに区切る。`defuseMentions` は、ゼロ幅スペースを入れると X が `@` の後ろのドメインから読み始めて URL の範囲が変わるため、変わらなくなるまで繰り返す。3 回で変わり続けるときは、URL の中かどうかにかかわらず残りを無害化する
- `src/weighted-length.ts` — X の文字数カウント（twitter-text v3 の重み付けの簡易実装）と切り詰め、URL の検出（`findUrls`）
- `src/tlds.ts` — twitter-text 3.1.0 の TLD の一覧（`validGTLD` と `validCCTLD`）
- `src/dedupe.ts` — KV による転送の記録（`DeliveryLog`、キーは `claimed:<noteId>`）
- `src/oauth1.ts` — OAuth 1.0a の署名（Web Crypto の HMAC-SHA1）
- `src/posters/` — 投稿先。`buffer.ts`（GraphQL、`mode: shareNow`）と `x.ts`（X API v2、本文のみ）。失敗は `PosterError` の `kind`（`rejected` / `unavailable` / `unknown`）で、投稿されたかどうかを区別する

## 実装上の注意

- Workers では `fetch` をプロパティに保持して `this.fetcher(...)` のように呼ぶと「Illegal invocation」になる。投稿先の既定の fetch は必ず `src/posters/fetch.ts` の `globalFetch` を使う。`test/posters.test.ts` がこの挙動を再現して検知する
- Node 上の Vitest では上記の不具合が再現しないため、ランタイム依存の変更は `pnpm dev` で workerd 上でも確認する
- レスポンスコードは Misskey の再送挙動に合わせている。Misskey は 5xx と無応答のときだけ再送する
  - 転送しないノート、KV に記録のあるノート → 200（`skipped`）
  - `rejected`（4xx、GraphQL の `MutationError`、X で本文が空）→ 422。再送しても無駄なので再送させず、記録も消さない
  - `unavailable`（408、425、429、503、521〜523）→ 502。記録を消すので、再送で投稿し直す。削除は応答の後も続けるため、消せなかったときはステータスを変えられない。再送は重複としてスキップされ、取りこぼす。ログの `failed to release claim` で追える。ログの `retries` は、削除の前に待った記録の書き込みの結果（`ClaimWrite`）で決める。保存できていれば `skipped` で、`claim-failed` でも打ち切った書き込みが待っている間に保存されていればこれに当たる。書き込みが例外で終わっていれば、記録はおそらくないので、再送で投稿し直されうる（`may-repost`）。終わらないまま消せなかったときは、後で保存されるかどうかで決まるため `unknown`
  - `unknown`（通信エラー、投稿先がステータスを返す前のタイムアウト、それ以外の 5xx、2xx で投稿 ID がない、投稿中の想定外の例外）→ 422。記録を残し、再送させない。二重投稿より取りこぼしを選ぶ方針で、KV がなくても同じ。投稿に 5 秒以上かかると Misskey は 422 を受け取る前に切断して再送するが、その再送は記録で重複としてスキップされる。本文の受信中に途切れたときは、受け取ったステータスで分類する
- Buffer の応答は、投稿 ID があれば `errors` が混じっていても成功とみなす。2xx の応答で `data` キーのない `errors` は実行前のエラーなので `rejected`。2xx 以外は `MutationError` があってもステータスで分類する
- KV が使えないときも、転送を止めないよう投稿を続ける。障害で記録を確認できないときは重複を確認せずに投稿し（`unchecked`）、無料枠の書き込み上限などで記録だけを書けないときは記録のないまま投稿する（`claim-failed`）。その再送は重複として防げない。KV の読み書きは 1 秒で打ち切り、遅いときも記録なしとして進む（遅い KV に Misskey の 5 秒を使い切られないようにするため）
- KV は同じキーへの書き込みが 1 秒に 1 回まで。記録の直後に消すことがあるため、削除は記録の書き込みが終わってから 1 秒以上たつまで待ってから行い、失敗したら間を空けて再試行する。どちらも応答を待たせずに続ける。1 秒で打ち切った書き込みも裏で続くため、その完了も待つ（削除の後に届くと記録が作り直され、再送がスキップされる）。待つのは 5 秒までで、待ちきれずに消したときは warn のログ `released claim before the claim write finished` を出す。削除は 2 秒で打ち切り、waitUntil の猶予の中で失敗をログに残せるようにする
- 投稿先との通信の上限は、記録の有無で変え、webhook の受信から数える（KV の操作が遅れたぶんも含める）。Misskey は 5 秒で切断して再送するが、処理は waitUntil で続く
  - 記録があるとき（`claimed`）は 20 秒（`CLAIMED_BUDGET_MS`）。再送は重複としてスキップされるので、遅れて届く 503 などの確定した応答を待つ。waitUntil の 30 秒の猶予の中で、記録の削除の時間を残す。期限を過ぎていても最低 1 秒は投稿を試みる。Misskey の再送が 60 秒以上あとに来ることが前提で、それより早い再送は、削除が間に合わず重複としてスキップされうる
  - 記録がないとき（KV なし、`unchecked`、`claim-failed`）は 4 秒（`UNCLAIMED_BUDGET_MS`）。再送を防げないため、5 秒の切断の前に打ち切って二重投稿を避ける。残りが 1 秒を切っていたら投稿せず、`unavailable`（502）にして再送に任せる
- `findUrls` は X（twitter-text 3.1.0）の `extractUrl` の正規表現をもとに、X と同じく直前の 1 文字を消費しながら本文を走査する。X が URL にしないかたまり（プロトコルのないドメインのクエリ、`$https://…`、BOM の直後など）も消費したまま次を探すので、その中の `https://…/@user` は URL とみなさない。ドメインは X の `validDomain` と同じく、TLD の一覧（`src/tlds.ts`）に当たる位置で終える。一覧の正規表現はコンパイルに数十 ms かかるため、正規表現にはせずに一覧を引く。TLD の大文字と小文字は、X の正規表現（u フラグのない `i`）と同じく 1 文字ずつ大文字にそろえて比べる。返すのはプロトコル付きの URL だけで、ホストが ASCII でラベルが 1〜63 文字のものに限る（X は国際化ドメインの URL も URL にするが、狭い側に倒して URL にしない。`xn--` で始まるホストは英数字・`-`・`.` だけのものに限る）。t.co の URL、URL の長さの上限（4096）も X に合わせる。URL を広く取るとその中のメンションが無害化されずに別人へ通知が飛ぶため、ずれるなら狭い側に倒す。URL の外側だけを置換する処理とリンク記法の区切りがこれに依存する。文字数のカウントは同じ走査を使うが、狭い側には倒さず、X が URL とみなす範囲（国際化ドメインの URL を含む）を 23 と数える。`xn--` で始まり英数字・`-`・`.` 以外を含むホストは、X が URL とみなすかを確かめないので、みなす場合の 23 とみなさない場合の文字ごとの重みの大きいほうで数える
- Buffer の GraphQL: `ChannelId` と `mode: shareNow` は実際の API で確認済み。画像は `assets: [{ image: { url } }]`（2026 年 5 月の仕様変更後の配列形式、型名は `AssetInput`）
- Buffer は `assets: null` を受け付けず「Argument "input" has invalid value」を返す。画像がないときは `createPostMutation(false)` で assets を変数ごと含めない
- Buffer API キーの権限は `posts:write` だけで足りる。API で取得するには `account:read` などの追加権限が要るため、チャンネル ID は Web 画面の URL から取得する
- メンションの無害化は `@` の直後にゼロ幅スペース（U+200B）を挟む方式。全角の `＠` は X でもメンションとして扱われるため使わない
- 文字数カウントは Buffer の作成画面の残り文字数表示（「てすとなう」で残り 270）と一致することを確認済み
- 絵文字（`Extended_Pictographic`）を含む書記素は、RGI の並びなら 2、それ以外は文字ごとの重みの合計で最低 2。`❤︎` や、標準にない ZWJ・肌色の組み合わせが後者に当たる。twitter-text 3.1.0 の `parseTweet` と照らし合わせて決めた。`🇯🇵` のような地域指示子の旗とキーキャップは文字ごとの合計で、X より多めになる。例外として、`🧑‍💻`・`♾️`・`🐦‍🔥` のように twitter-text 3.1.0 の絵文字の表にない RGI の並びは 2 と数え、X が古い表を使っていれば 2〜7 少なく数える

## 技術スタック

- TypeScript（strict、`noUncheckedIndexedAccess`）、Cloudflare Workers
- パッケージマネージャ: pnpm（`esbuild` と `workerd` のビルドスクリプトのみ許可）
- リンター / フォーマッター: Biome（ダブルクォート、セミコロン必須、trailing comma あり、インデント 2 スペース、行幅 80）
- 実行時の依存パッケージはなし

## コミット規約

- 英語で Conventional Commits 形式（`feat:`, `fix:`, `chore:` 等）
- コミットメッセージは単一行にする（マルチライン・HEREDOC 不可）

## CI/CD

- `lint.yml` — push / PR で Biome と markdownlint を実行
- `test.yml` — push / PR で型チェック、テスト、wrangler のドライランを実行。PR 時は `update-lockfile` ジョブが先行して `pnpm-lock.yaml` の未同期を自動更新する
- `deploy.yml` — `main` への push（Markdown などの変更のみは除く）で `wrangler deploy`。リポジトリ変数 `DEPLOY_WORKER=true` と、シークレット `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` が必要
- `claude.yml` / `claude-code-review.yml` — `rysk-tanaka/workflows` の reusable workflow を呼び出すラッパー

Worker のシークレットは CI では扱わず、`wrangler secret put` で手動登録する。

## 依存関係の自動更新

Renovate で npm と GitHub Actions の依存を自動更新（毎週土曜 9:00 JST 前）。`wrangler` と `@cloudflare/workers-types` は 1 本の PR にまとめる。
