# 試験の原本

2026-10-02 に、読み取り専用のトークン（Billing Read、Account Analytics Read）で実物の Cloudflare API を叩いた応答である。
アカウント ID は `0123456789abcdef0123456789abcdef`、アカウント名は `Example Account`、契約の ID は `SUBSCRIPTION0000000000000000` に伏せてある。

- `billable-usage.json` … `GET /accounts/{id}/billable-usage`（引数なし）の生の応答。55 行、R2 の 3 項目だけ。
- `graphql-today.json` … GraphQL の `d1AnalyticsAdaptiveGroups` と `workersInvocationsAdaptive` を 2026-09-28〜10-02 で引いた生の応答。
- `subscriptions.json` … `GET /accounts/{id}/subscriptions`。**生の応答は取り損ねたので、実物が返した項目（rate_plan.id、public_name、price、currency、frequency、state、product.name、current_period_start と end）から組み立てた。** 実物での確認のときに取り直して差し替える。

`ConsumedUnit` は空文字で、単位は `PricingUnit`（`Count`、`GB-months`）に入っている。
