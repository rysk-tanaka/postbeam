# postbeam

[![lint](https://github.com/rysk-tanaka/postbeam/actions/workflows/lint.yml/badge.svg)](https://github.com/rysk-tanaka/postbeam/actions/workflows/lint.yml)
[![test](https://github.com/rysk-tanaka/postbeam/actions/workflows/test.yml/badge.svg)](https://github.com/rysk-tanaka/postbeam/actions/workflows/test.yml)
[![deploy](https://github.com/rysk-tanaka/postbeam/actions/workflows/deploy.yml/badge.svg)](https://github.com/rysk-tanaka/postbeam/actions/workflows/deploy.yml)
[![license](https://badgers.space/github/license/rysk-tanaka/postbeam?corner_radius=5)](./LICENSE)

> Misskey の投稿を webhook で受け取り、X などの SNS へ転送する Cloudflare Worker

---

## 概要

postbeam は Misskey の webhook を受け取り、ノートを整形して X へ転送します。
Cloudflare Workers の無料プランで動きます。キューやデータベースは使わず、重複投稿の防止に Workers KV だけを使います。

```text
Misskey ──webhook──▶ postbeam（Cloudflare Worker）──▶ Buffer API ──▶ X
                                                  └─▶ X API（予備）
```

- 投稿先は [Buffer](https://buffer.com/) と X API から選べます
  - Buffer（既定）: 無料プランで使え、X API の従量課金や開発者アカウントの管理が不要です
  - X API: OAuth 1.0a で直接投稿します。Buffer が使えなくなったときの予備です
- Misskey 固有の書式を X 向けに整えます
  - MFM（`$[tada ...]`、`<center>` など）を取り除き、中身のテキストだけを残す
  - リンク記法（`[ラベル](URL)`）は「ラベル URL」にする
  - カスタム絵文字（`:blobcat:`）を取り除く
  - `@user` が X 上の別人へのメンションにならないよう無害化する
  - X の文字数ルール（日本語は 1 文字 2、URL は 23）で数え、280 を超えたら切り詰める
- 画像は 4 枚まで添付します（Buffer のみ）
- Misskey の再送で同じノートを二度投稿しないよう、転送したノートを KV に記録します（「[重複投稿の防止](#重複投稿の防止)」）

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

## 重複投稿の防止

Misskey は、webhook の応答が 5xx か無応答のときに再送します。
再送で同じノートを二度投稿しないよう、投稿の直前に Workers KV へ記録し、記録のあるノートは投稿しません。

- 記録は投稿に成功しても残り、7 日で消えます
- 一時的で、確実に投稿されていない失敗（投稿先の 429 / 503 など）のときだけ記録を消して 502 を返し、再送で投稿し直します。記録を消せなかったときは、再送が重複としてスキップされ、その投稿は失われます。ログの `failed to release claim` で追えます。記録を消す前に、遅れている記録の書き込みの完了を最大 5 秒待ち、ログの `retries` はその結果で決まります。書き込みが保存できていれば記録は残っているので `skipped` で、取りこぼしです。書き込み自体が失敗していれば、記録はおそらくないので、再送で投稿し直されることがあり、`may-repost` になります。完了を待ちきれなかったときは、書き込みが後から保存されたかどうかで、再送で投稿し直されるか、スキップされるかが決まります。記録を消せていればログに `released claim before the claim write finished` が、消せなければ `retries` が `unknown` の `failed to release claim` が出ます
- 投稿されたかどうかわからない失敗（通信エラー、投稿先が制限時間内に応答しない、投稿先の 500 / 502 / 504、成功の応答に投稿 ID がないなど）は 422 を返し、再送させません。投稿に 5 秒以上かかって Misskey が先に再送した場合も、記録により重複としてスキップされます。二重投稿を避ける代わりに、実際には投稿されていなかった場合はその投稿が失われます。Misskey の webhook の画面とログの `noteId` で追えます。KV がない構成でも同じです。制限時間は webhook の受信から数え、記録があれば 20 秒、記録がなければ Misskey の再送を防げないため 4 秒です。記録がないまま受信から 3 秒以上たっていたときは、投稿せずに 502 を返し、再送で投稿し直します
- 記録の書き込みはふつう 1 件につき 1 回で、投稿先の一時的な失敗（429 / 503 など）で記録を消したときは、再送のたびに 1 回加わります。記録の削除は書き込みとは別の上限で数え、無料プランの KV では書き込みと削除がそれぞれ 1 日 1,000 回までです
- 書き込みの上限を超えた分は記録が残らないため、再送されると二重に投稿されることがあります。KV の障害で記録を確認できないときは、重複を確認せずに投稿します
- `wrangler.toml` の `[[kv_namespaces]]` を削除すると、この仕組みを使わずに動きます

## セットアップ

### 1. Buffer の準備

1. [Buffer](https://buffer.com/) に登録し、X のアカウントをチャンネルとして接続します
2. [API 設定](https://publish.buffer.com/settings/api)で API キーを発行します（権限は `posts:write` だけで足ります）
3. チャンネルを開いたときの URL（`https://publish.buffer.com/channels/<ここ>/...`）からチャンネル ID を控えます

### 2. デプロイ

```bash
pnpm install
pnpm exec wrangler login

# 重複投稿の防止に使う KV を作る。出力された id を wrangler.toml の [[kv_namespaces]] に書く
pnpm exec wrangler kv namespace create POSTED_NOTES

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

真偽値は `true` / `1` / `yes` または `false` / `0` / `no` で指定します。それ以外の値や、空の `VISIBILITIES`、`public` / `home` / `followers` / `specified` 以外を含む `VISIBILITIES` は設定エラーになり、webhook に 500 を返します。

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

- Misskey の webhook に削除イベントがないため、Misskey 側でノートを削除しても、転送先の投稿は削除されません
- 自分のノートへの返信をスレッドとしてつなげる機能はありません
- `POSTER=x` では画像を添付せず、本文だけを投稿します
- 動画は転送しません
- 少なく数えて投稿が拒否されるのを避けるため、`misskey.io` のようなプロトコルなしのドメインは、X が URL とみなすかどうかにかかわらず 23 文字以上として数えます。`Node.js` のような語も同じ扱いになるため、上限付近の長文は少し早めに切り詰められることがあります
- 別人へのメンションになるのを防ぐため、主要な TLD（`.com` など）と英字 2 文字の TLD 以外の URL は URL として扱わず、その中の `@user` も無害化します。そのため、リンクが壊れることがあります
- KV の記録は、書き込んだ拠点以外へ反映されるまで最大 60 秒ほどかかります。異なる拠点に再送が届いた場合、まれに重複を防げないことがあります
- Buffer の無料プランでは、同時に予約できる投稿がチャンネルごとに 10 件までです。すぐ投稿する使い方では問題になりません

## ライセンス

[MIT](./LICENSE)
