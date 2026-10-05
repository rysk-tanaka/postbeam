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
pnpm test -- -t "stripMfm"

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
src/index.ts::handleRequest(request, env, fetcher?)
  → POST 以外は 405
  → X-Misskey-Hook-Secret を timingSafeEqual で検証（不一致は 401）
  → payload.type が "note" 以外はスキップ
  → ダミーノート（id が "dummy-" で始まる）はスキップ
  → loadConfig(env) で [vars] を解釈
  → shouldForward(note, config) で転送対象か判定
  → buildPost(note, config, link) で本文と画像 URL を組み立てる
  → createPoster(env, config)
  → DeliveryLog（KV）に記録のあるノートはスキップし、なければ記録する（KV がない・障害時は確認しない）
  → poster.post(post)。再送で投稿し直せる失敗（unavailable）のときだけ記録を消す
```

- `src/config.ts` — `Env`（シークレットと [vars]）の型と `loadConfig()`。不正な値は `ConfigError` を投げる
- `src/misskey.ts` — Misskey の webhook payload とノートの型（必要な項目のみ）
- `src/transform.ts` — 転送判定（`shouldForward`）と整形（`stripMfm` / `stripCustomEmoji` / `defuseMentions` / `buildPost`）。`stripCustomEmoji` と `defuseMentions` は URL の外側だけを置換する
- `src/weighted-length.ts` — X の文字数カウント（twitter-text v3 の重み付けの簡易実装）と切り詰め、URL の検出（`findUrls`）
- `src/dedupe.ts` — KV による転送の記録（`DeliveryLog`、キーは `claimed:<noteId>`）
- `src/oauth1.ts` — OAuth 1.0a の署名（Web Crypto の HMAC-SHA1）
- `src/posters/` — 投稿先。`buffer.ts`（GraphQL、`mode: shareNow`）と `x.ts`（X API v2、本文のみ）。失敗は `PosterError` の `kind`（`rejected` / `unavailable` / `unknown`）で、投稿されたかどうかを区別する

## 実装上の注意

- Workers では `fetch` をプロパティに保持して `this.fetcher(...)` のように呼ぶと「Illegal invocation」になる。投稿先の既定の fetch は必ず `src/posters/fetch.ts` の `globalFetch` を使う。`test/posters.test.ts` がこの挙動を再現して検知する
- Node 上の Vitest では上記の不具合が再現しないため、ランタイム依存の変更は `pnpm dev` で workerd 上でも確認する
- レスポンスコードは Misskey の再送挙動に合わせている。Misskey は 5xx と無応答のときだけ再送する
  - 転送しないノート、KV に記録のあるノート → 200（`skipped`）
  - `rejected`（4xx、GraphQL の `MutationError`、X で本文が空）→ 422。再送しても無駄なので再送させず、記録も消さない
  - `unavailable`（408、425、429、503、521〜523）→ 502。記録を消すので、再送で投稿し直す。記録を書き込めていて消せなかったときは再送が重複として捨てられるため、`rejected` に変えて 422 にする。記録の書き込みに失敗していたときは、記録はおそらくないので 502 のまま
  - `unknown`（通信エラー、それ以外の 5xx、2xx で投稿 ID がない、投稿中の想定外の例外）→ 422。記録を残し、再送させない。二重投稿より取りこぼしを選ぶ方針で、KV がなくても同じ
- Buffer の応答は、投稿 ID があれば `errors` が混じっていても成功とみなす。2xx の応答で `data` キーのない `errors` は実行前のエラーなので `rejected`。2xx 以外は `MutationError` があってもステータスで分類する
- KV が使えないときも、転送を止めないよう投稿を続ける。障害で記録を確認できないときは重複を確認せずに投稿し（`unchecked`）、無料枠の書き込み上限などで記録だけを書けないときは記録のないまま投稿する（`claim-failed`）。その再送は重複として防げない
- KV は同じキーへの書き込みが 1 秒に 1 回まで。記録の直後に消すことがあるため、削除は失敗したら間を空けて再試行する
- `findUrls` は X（twitter-text）が確実に URL とみなす範囲だけを返す。英数字の直後や一覧（`GENERIC_TLDS`）にも英字 2 文字にも当てはまらない TLD のホストは URL にせず、パスとクエリは ASCII だけにし、対応の取れない括弧の手前で打ち切る。URL を広く取るとその中のメンションが無害化されずに別人へ通知が飛ぶため、ずれるなら狭い側に倒す。URL の外側だけを置換する処理と文字数のカウントの両方がこれに依存する。2 文字の TLD は実在するかを確認しないため、この部分だけは X より広い
- Buffer の GraphQL: `ChannelId` と `mode: shareNow` は実際の API で確認済み。画像は `assets: [{ image: { url } }]`（2026 年 5 月の仕様変更後の配列形式、型名は `AssetInput`）
- Buffer は `assets: null` を受け付けず「Argument "input" has invalid value」を返す。画像がないときは `createPostMutation(false)` で assets を変数ごと含めない
- Buffer API キーの権限は `posts:write` だけで足りる。API で取得するには `account:read` などの追加権限が要るため、チャンネル ID は Web 画面の URL から取得する
- メンションの無害化は `@` の直後にゼロ幅スペース（U+200B）を挟む方式。全角の `＠` は X でもメンションとして扱われるため使わない
- 文字数カウントは Buffer の作成画面の残り文字数表示（「てすとなう」で残り 270）と一致することを確認済み

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
