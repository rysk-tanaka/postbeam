# postbeam

[![lint](https://github.com/rysk-tanaka/postbeam/actions/workflows/lint.yml/badge.svg)](https://github.com/rysk-tanaka/postbeam/actions/workflows/lint.yml)
[![test](https://github.com/rysk-tanaka/postbeam/actions/workflows/test.yml/badge.svg)](https://github.com/rysk-tanaka/postbeam/actions/workflows/test.yml)
[![deploy](https://github.com/rysk-tanaka/postbeam/actions/workflows/deploy.yml/badge.svg)](https://github.com/rysk-tanaka/postbeam/actions/workflows/deploy.yml)
[![license](https://badgers.space/github/license/rysk-tanaka/postbeam?corner_radius=5)](./LICENSE)

> Misskey の投稿を webhook で受け取り、X などの SNS へ転送する Cloudflare Worker

---

## 概要

postbeam は Misskey の webhook を受け取り、ノートを整形して X へ転送します。
Cloudflare Workers の無料プランで動き、キューやデータベースは使いません。

```text
Misskey ──webhook──▶ postbeam（Cloudflare Worker）──▶ Buffer API ──▶ X
                                                  └─▶ X API（予備）
```

- 投稿先は [Buffer](https://buffer.com/) と X API から選べます
  - Buffer（既定）: 無料プランで使え、X API の従量課金や開発者アカウントの管理が不要です
  - X API: OAuth 1.0a で直接投稿します。Buffer が使えなくなったときの予備です
- Misskey 固有の書式を X 向けに整えます
  - MFM（`$[tada ...]`、`<center>` など）を取り除き、中身のテキストだけを残す
  - カスタム絵文字（`:blobcat:`）を取り除く
  - `@user` が X 上の別人へのメンションにならないよう無害化する
  - X の文字数ルール（日本語は 1 文字 2、URL は 23）で数え、280 を超えたら切り詰める
- 画像は 4 枚まで添付します（Buffer のみ）

## 転送ルール

既定では次のノートだけを転送します。設定は「[設定](#設定)」で変えられます。

| ノート | 既定の扱い |
| --- | --- |
| 公開範囲が「パブリック」「ホーム」 | 転送する |
| 公開範囲が「フォロワー」「ダイレクト」 | 転送しない |
| 連合なし（ローカルのみ） | 転送しない |
| 返信 | 転送しない |
| 本文のない Renote | 転送しない（引用 Renote は本文を転送） |
| CW 付き | 転送しない |
| `#nox` タグ付き | 転送しない |
| センシティブ指定の画像 | 添付しない（本文は転送） |

## セットアップ

### 1. Buffer の準備

1. [Buffer](https://buffer.com/) に登録し、X のアカウントをチャンネルとして接続します
2. [API 設定](https://publish.buffer.com/settings/api)で API キーを発行します（権限は `posts:write` だけで足ります）
3. チャンネルを開いたときの URL（`https://publish.buffer.com/channels/<ここ>/...`）からチャンネル ID を控えます

### 2. デプロイ

```bash
pnpm install
pnpm exec wrangler login

# 先にデプロイして Worker を作る（pnpm deploy は pnpm の組み込みコマンドなので run を付ける）
pnpm run deploy

# シークレットを登録（値は対話的に入力。登録した時点で反映される）
pnpm exec wrangler secret put MISSKEY_HOOK_SECRET
pnpm exec wrangler secret put BUFFER_API_KEY
pnpm exec wrangler secret put BUFFER_CHANNEL_ID
```

`MISSKEY_HOOK_SECRET` には、推測されにくいランダムな文字列を設定します（例: `openssl rand -hex 32`）。
シークレットを登録するまでの間に届いた webhook は、401 または 500 で弾かれます。

### 3. Misskey に webhook を登録

Misskey の「設定 → Webhook」で新規作成します。

| 項目 | 値 |
| --- | --- |
| URL | デプロイした Worker の URL（`https://postbeam.<account>.workers.dev/`） |
| シークレット | `MISSKEY_HOOK_SECRET` と同じ値 |
| トリガー | 「ノートを投稿したとき」だけを有効にする |

設定画面の「テスト」で送られるダミーのノートは、投稿せずにスキップします。

### GitHub Actions からの自動デプロイ

`main` への push で自動デプロイする場合は、リポジトリに次を設定します。

- シークレット: `CLOUDFLARE_API_TOKEN`（「Edit Cloudflare Workers」テンプレートで作成）、`CLOUDFLARE_ACCOUNT_ID`
- 変数: `DEPLOY_WORKER` = `true`

Worker のシークレット（`MISSKEY_HOOK_SECRET` など）は `wrangler secret put` で一度登録すれば、デプロイし直しても残ります。

## 設定

`wrangler.toml` の `[vars]` で変更します。

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `POSTER` | `buffer` | 投稿先。`buffer` または `x` |
| `VISIBILITIES` | `public,home` | 転送する公開範囲（カンマ区切り） |
| `CW_MODE` | `skip` | CW 付きノートの扱い。`skip`（転送しない）または `include`（CW 文と本文を続けて転送） |
| `INCLUDE_REPLIES` | `false` | 返信も転送するか |
| `EXCLUDE_TAGS` | `nox` | このタグが付いたノートは転送しない（カンマ区切り、`#` なし） |
| `APPEND_LINK` | `never` | 元ノートへのリンク。`never` / `truncated`（切り詰めたときだけ）/ `always` |
| `ATTACH_SENSITIVE` | `false` | センシティブ指定の画像も添付するか |
| `STRIP_CUSTOM_EMOJI` | `true` | カスタム絵文字を取り除くか |
| `MISSKEY_URL` | （なし） | 元ノートの URL を組み立てるサーバー URL。webhook に `server` が含まれない古い Misskey 向け |

### シークレット

| 名前 | 必要なとき |
| --- | --- |
| `MISSKEY_HOOK_SECRET` | 常に |
| `BUFFER_API_KEY`, `BUFFER_CHANNEL_ID` | `POSTER=buffer` |
| `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` | `POSTER=x` |

### X API を使う場合の注意

`POSTER=x` では X API の従量課金がかかります（2026 年 10 月時点で通常の投稿 1 件 $0.015、URL を含む投稿は $0.20）。
`APPEND_LINK` を `never` 以外にすると、リンク付きの投稿が増えて費用が上がります。
クレジットが尽きると投稿が失敗するため、Developer Console で自動チャージを設定しておくと安心です。

## 開発

```bash
pnpm install
cp .dev.vars.example .dev.vars   # ローカル用のシークレット
pnpm dev                         # http://localhost:8787 で起動

pnpm test        # テスト
pnpm typecheck   # 型チェック
pnpm lint        # Biome + markdownlint
pnpm build       # wrangler のドライラン
```

ローカルで webhook を試す例:

```bash
curl -X POST http://localhost:8787/ \
  -H "X-Misskey-Hook-Secret: change-me" \
  -d '{"type":"note","body":{"note":{"id":"n1","text":"てすと","visibility":"public"}}}'
```

## 制限事項

- Misskey 側でノートを削除しても、転送先の投稿は削除されません（Misskey の webhook に削除イベントがないため）
- 自分のノートへの返信をスレッドとしてつなげる機能はありません
- `POSTER=x` では画像を添付せず、本文だけを投稿します
- 動画は転送しません
- Buffer の無料プランでは、同時に予約できる投稿がチャンネルごとに 10 件までです（すぐ投稿する使い方では問題になりません）

## ライセンス

[MIT](./LICENSE)
