# Zernio API facts for WP10 (TikTok via Zernio)

**Date:** 15 November 2026.

**How this was read.** The pages of docs.zernio.com were downloaded with `curl` from the build environment on
15 November 2026 and read as plain text (data only). Three readers covered auth/accounts, media/posts and
status/webhooks. A fourth pass downloaded the pages again to settle conflicts between them. No Zernio account was
created, no API key exists, and no request was sent to the Zernio API itself. The OpenAPI file read was version
`1.611.2`. The docs change often (the changelog has entries from September 2026), so recheck anything that matters
before the first live post. Each fact below carries the exact quote and the page it came from.

Used by: `docs/design/publishing.md` §7.2 (the adapter design) and `docs/design/stage-bc-plan.md` WP10.

---

## 1. Base URL and authentication

| Fact | Quote | Page |
| --- | --- | --- |
| Base URL is `https://zernio.com/api/v1`. There is no `api.zernio.com`. | "**Base URL:** `https://zernio.com/api/v1`" | https://docs.zernio.com/api-reference.mdx |
| The OpenAPI server is `https://zernio.com/api`, and every path starts with `/v1`. So `ZERNIO_API_BASE_URL=https://zernio.com/api` and the adapter calls `{base}/v1/...`. | "servers:\n  - url: https://zernio.com/api\n    description: Production" | https://docs.zernio.com/api/openapi |
| The version lives in the path. Breaking changes ship only under a new path version. | "all endpoints are versioned in the URL path\n    (current version: /v1). Breaking changes only ship in a new path version;\n    existing versions keep working." | https://docs.zernio.com/api/openapi |
| Every request sends `Authorization: Bearer <key>`. | "**[Authentication](/quickstart):** `Authorization: Bearer YOUR_API_KEY` header" | https://docs.zernio.com/api-reference.mdx |
| Keys are created in the dashboard, shown once and stored only as a hash. A full key is `sk_` plus 64 hex characters. | "Copy the key now. Zernio stores a SHA-256 hash of it and never shows it again.\n\nA key is `sk_` followed by 64 hex characters (67 in total)." | https://docs.zernio.com/quickstart.mdx |
| A restricted key (any resource group disabled) starts with `zrk_`. A disabled group returns 403 `insufficient_permissions` with `required_group`. So the app must **not** require the `sk_` prefix. | "A key with any group disabled:\n\n- mints with the zrk_ prefix;\n- gets 403 with code=insufficient_permissions and required_group on operations in disabled groups (each operation's group is published as x-resource-group)" | https://docs.zernio.com/api-keys/create-api-key.mdx |
| Keys can also be read-only, profile-scoped and set to expire. A read-only key cannot post. | "**permission** `string`: 'read-write' allows all operations (default), 'read' restricts to GET requests only" and "**expiresIn** `integer`: Days until expiry" | https://docs.zernio.com/api-keys/create-api-key.mdx |
| Resource groups the adapter needs (from the OpenAPI `x-resource-group` of each operation): `POST /v1/media/presign`, `GET`/`POST /v1/posts`, `GET /v1/posts/{postId}` and `POST /v1/posts/{postId}/retry` are `publishing`. `GET /v1/accounts`, `GET /v1/accounts/{accountId}/health` and `GET /v1/accounts/{accountId}/tiktok/creator-info` are `accounts`. `GET /v1/auth/verify` is `public`. `/v1/webhooks/settings` is `webhooks`. | `/v1/media/presign:` … `x-resource-group: "publishing"`; `/v1/accounts:` … `x-resource-group: "accounts"`; `/v1/auth/verify:` … `x-resource-group: "public"` | https://docs.zernio.com/api/openapi |
| A key can be checked without reading any data. | "## GET /v1/auth/verify ... Checks whether the bearer credential on this request is valid, without reading any data." | https://docs.zernio.com/api-keys/verify-credential.mdx |

## 2. Rate limits and errors

| Fact | Quote | Page |
| --- | --- | --- |
| The limit depends on the team's connected-account count: 60 requests/min for 0–2 accounts. | "\| 0 to 2 (free) \| 60 \| 6 \|" | https://docs.zernio.com/guides/rate-limits.mdx |
| Headers `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (Unix seconds); `Retry-After` on 429. | "\| `Retry-After` \| `429` responses only: seconds to wait before retrying \|" | https://docs.zernio.com/guides/rate-limits.mdx |
| The API-key window 429 has **no** `type` or `code`. Branch on the status. | "\| `429` with `error` and `details` only \| Your window is full. No `code`: branch on the status. \| Wait `Retry-After` seconds … then retry. \|" | https://docs.zernio.com/guides/rate-limits.mdx |
| Window 429 body. | `{ "error": "Rate limit exceeded. Please retry after 12 seconds.", "details": { "currentCount": 601, "limit": 600, "retryAfterSeconds": 12 } }` | https://docs.zernio.com/guides/rate-limits.mdx |
| A create can also get 429 for an account cooldown or a daily platform limit. | "#### 429: Rate limit exceeded. Possible causes: API rate limit, account cooldown, or daily platform limits." | https://docs.zernio.com/posts/create-post.mdx |
| The account cooldown is visible in advance as `rateLimitedUntil` on the account. | "End of the account's publishing cooldown. Compare it with the current time: a value in the past means the cooldown has ended" and "While it is in the future, POST /v1/posts (drafts excepted) and POST /v1/posts/{postId}/retry return 429 for this account." | https://docs.zernio.com/api/openapi (SocialAccount) |
| The error envelope is flat: `{error, type, code, param, details, ...}`. `type` and `code` are stable; `error` is free text. | `{ "error": "budgetAmount is required", "type": "invalid_request_error", "code": "missing_required_field", "param": "budgetAmount" }` | https://docs.zernio.com/guides/error-handling.mdx |
| Type → status table. | "\| `authentication_error` \| 401 \| Missing or invalid API key. \|" … "\| `rate_limit_error` \| 429 \|" … "\| `api_error` \| 500 / 503 \|" | https://docs.zernio.com/guides/error-handling.mdx |
| 401 codes. | "`code` is `missing_credentials` when no Authorization header was sent and `invalid_credentials` when the key is unknown, revoked or expired." | https://docs.zernio.com/posts/create-post.mdx |
| 403 codes on create post. | "- `ACCOUNT_DISCONNECTED`: a target account's platform connection is no longer active (token expired or revoked, or disconnected). … - `ACCOUNT_NOT_ENABLED_FOR_POSTING` … - `PROFILE_OVER_LIMIT` … - No `code`: a target `accountId` does not belong to the authenticated user (or is outside the API key's profile scope)." | https://docs.zernio.com/posts/create-post.mdx |
| 409 for an account that needs reconnecting. | "\| `ads_connection_required` \| invalid_request_error \| `409`: the account is inactive or needs reconnecting." | https://docs.zernio.com/guides/error-handling.mdx |
| 503 may hide a completed write. | "#### 503: An upstream service or database is temporarily unavailable. Retry after the indicated delay. A timed-out write may have completed upstream; check its outcome before resubmitting." | https://docs.zernio.com/posts/create-post.mdx |
| **207 is a 2xx.** | "**207 is a 2xx status.** `fetch(...).ok` is `true` and axios' default `validateStatus` resolves, so a client that only checks for success reads this as a published post. Branch on the status code explicitly." | https://docs.zernio.com/posts/create-post.mdx |
| Unknown request fields are silently dropped. | "**Unknown parameters are dropped, not rejected.**" | https://docs.zernio.com/guides/error-handling.mdx |

## 3. Idempotency

| Fact | Quote | Page |
| --- | --- | --- |
| `POST /v1/posts` accepts an `Idempotency-Key` header with a 24-hour window. A replay returns 200 with the original post. | "Send an `Idempotency-Key` header (a UUID per logical post, up to 255 characters). Reuse it when you retry after a 5xx, a timeout or a dropped connection.\n\nA retry with the same key within 24 hours returns **HTTP 200** with the original post in the `post` field, and no new post is created." | https://docs.zernio.com/posts/create-post.mdx |
| The match is on the key alone, and it covers posts saved despite a 5xx or timeout. | "The match is on the key alone, not on the body … It covers drafts, and a post that was saved even though the original response was a 5xx or timed out." | https://docs.zernio.com/posts/create-post.mdx |
| While the first request is still running: 409 `idempotency_conflict`. If the first created nothing, the retry is new. | "- If the first request is still being processed, the retry gets **HTTP 409** with `code: idempotency_conflict` and a `Retry-After` header; retry after that delay.\n- If the first request failed without creating a post, the retry is processed as a new request.\n\nKeys are scoped to your user." | https://docs.zernio.com/posts/create-post.mdx |
| A new post is always 201. | "Treat that `200` as success; a new post is always `201`." | https://docs.zernio.com/guides/idempotency.mdx |
| Content-hash dedup: the same (platform, account, content + media URLs) within 24 h returns 409 with `details.existingPostId`, whatever headers are sent. | "Independently, we hash `(platform, accountId, content + media URLs)` and reject duplicates within 24 hours with **HTTP 409**." and "- `details.existingPostId`: Zernio `_id` of the original post" | https://docs.zernio.com/posts/create-post.mdx |
| Only live content counts for the dedup. | "Only scheduled, publishing or published content counts, not failed or cancelled targets." | https://docs.zernio.com/guides/idempotency.mdx |
| There is no external-reference field, but `metadata` is free-form, stored, returned on reads and echoed in webhooks. | "**metadata** `object`: Free-form key/value pairs of your own, stored on the post and returned on reads and in webhook payloads. Zernio also writes the bookkeeping keys `usageCounted`, `usageRefunded` and `hidden` into this object; do not set them" | https://docs.zernio.com/posts/create-post.mdx |
| Posts can be listed by account and change time, with `metadata` in the returned fields (used to find a post after a crash). | "**updatedSince** (optional) in query: Only posts whose `updatedAt` is at or after this ISO 8601 timestamp (an offset or `Z` required)." … "**accountId** (optional) in query: Filter posts to those published via a specific account" … "**fields** … Accepted: … `metadata` …" | https://docs.zernio.com/posts/list-posts.mdx |
| Idempotency on create is recent. | "\"date\": \"2026-09-25 ...\" \"title\": \"Post creation now supports idempotency keys\"" | https://docs.zernio.com/changelog.json |
| The retry endpoint does not list an `Idempotency-Key`. It refuses a post that is already publishing. | "#### 409: Post is currently publishing" | https://docs.zernio.com/posts/retry-post.mdx |

## 4. Accounts and TikTok account requirements

| Fact | Quote | Page |
| --- | --- | --- |
| `GET /v1/accounts` lists accounts, filterable by `platform`. | "## GET /v1/accounts … Returns connected accounts. Only includes accounts within the plan limit by default." and "- **platform** (optional) in query: Filter accounts by platform" | https://docs.zernio.com/accounts/list-accounts.mdx |
| Response wrapper. | "- **accounts** (required) `array[ListedAccount]`: \n- **hasAnalyticsAccess** (required) `boolean`" | https://docs.zernio.com/accounts/list-accounts.mdx |
| Account fields: `_id`, `platform`, `profileId`, `isActive` required, and `username`, `displayName`, `needsReconnection`, `rateLimitedUntil`, `tiktokAccountType`. **No connected/created date is documented.** | "SocialAccount:\n      type: object\n      required: [_id, platform, profileId, isActive]" and "needsReconnection: … The platform definitively reported the stored OAuth token as dead." and "tiktokAccountType: … enum: [business, personal, unknown]" | https://docs.zernio.com/api/openapi |
| The TikTok lane is reported as `integrationLane` on the single-account health endpoint (not on the bulk one). | "- **integrationLane** `string`: TikTok only. The TikTok integration the account is connected through: business (TikTok for Business, Accounts API) or developer (the original integration). Absent on other platforms. - one of: business, developer" | https://docs.zernio.com/accounts/get-account-health.mdx |
| Health also reports token and posting permission. | "- **status** `string`: Overall health status - one of: healthy, warning, error\n- **tokenStatus** `object`: \n  - **valid** `boolean`" and "**canPost** `boolean`: Whether the granted OAuth scopes allow posting." | https://docs.zernio.com/accounts/get-account-health.mdx |
| New connections use the Business app; older ones stay on the developer app until reconnected. The switch was a breaking change dated 11 Sep 2026. | "TikTok connections now go through the TikTok for Business app.\n\nAn account connected earlier stays on TikTok's developer app until its owner reconnects it. The lane is decided when the account is connected." | https://docs.zernio.com/platforms/tiktok.mdx |
| | "\"date\": \"2026-09-11T17:31:31.767Z\", \"type\": \"breaking_change\", \"title\": \"TikTok connections now use TikTok for Business\"" | https://docs.zernio.com/changelog.json |
| Business-lane video direct posts are public only. | "**Video privacy**: Business app accounts publish videos as public only, and [Creator Inbox drafts](/platforms/tiktok/posts#draft-delivery) are the only route to a non-public video." | https://docs.zernio.com/platforms/tiktok.mdx |
| A partial permission grant changes nothing. | "If the authorization leaves out a permission the already-connected account needs, nothing changes and the flow returns `missing_tiktok_permissions`." | https://docs.zernio.com/platforms/tiktok.mdx |
| Missing scope error on publish. | "\| \"Missing required TikTok permissions. Please reconnect with all required scopes.\" \| The OAuth token lacks a required scope \|" | https://docs.zernio.com/platforms/tiktok/reference.mdx |
| Creator info must be read before building a post. | "Call `GET /v1/accounts/{accountId}/tiktok/creator-info` ([Get TikTok creator info](/accounts/get-tiktok-creator-info)) before you build a post." | https://docs.zernio.com/platforms/tiktok/posts.mdx |
| Creator info fields. | "**canPostMore** `boolean`: Whether the creator can publish more posts right now\n- **privacyLevels** `array[object]` … **value** `string`: Privacy level value to use when creating posts" and "**maxVideoDurationSec** `integer`" and "**interactionSettings** `object`: Per-interaction descriptors for the comment, duet and stitch toggles." | https://docs.zernio.com/accounts/get-tiktok-creator-info.mdx |
| Interaction descriptors: `enabled` is availability, `default` is a UI seed only. | "**enabled** `boolean`: Whether the creator permits this interaction. False means they disabled it in the TikTok app. This is availability, never the value the user selected." and "**default** `boolean`: Initial value a post composer should render. A UI seed only, never applied server-side when the field is omitted." | https://docs.zernio.com/accounts/get-tiktok-creator-info.mdx |
| DMs need a TikTok Business Account. **Nothing is documented about publishing from a personal account.** | "- The account is a TikTok Business Account. TikTok refuses personal accounts." (inbox page only) | https://docs.zernio.com/platforms/tiktok/inbox.mdx |

## 5. Media upload

| Fact | Quote | Page |
| --- | --- | --- |
| `POST /v1/media/presign` with `filename`, `contentType` (both required) and optional `size`. | "## POST /v1/media/presign ... - **filename** (required) `string`: Name of the file to upload\n- **contentType** (required): No description\n- **size** `integer`: Optional file size in bytes for pre-validation (max 5GB)" | https://docs.zernio.com/media/get-media-presigned-url.mdx |
| Response: `uploadUrl` (1 hour), `publicUrl`, `key`, `expiresIn`. | "- **uploadUrl** `string` (uri): Presigned URL to PUT your file to (expires in 1 hour)\n- **publicUrl** `string` (uri): Public URL where the file will be accessible after upload\n- **key** `string`: Storage key/path of the file\n- **expiresIn** `integer`: Seconds until the presigned uploadUrl expires (always 3600)" | https://docs.zernio.com/media/get-media-presigned-url.mdx |
| Upload with `PUT` to `uploadUrl`, same Content-Type, no Authorization. | "`PUT` the file to `uploadUrl` with the same `Content-Type`. It goes to storage, not the API, so no `Authorization` header." | https://docs.zernio.com/guides/media-uploads.mdx |
| Storage replies with an empty 200 and an ETag. | "Storage answers an empty `200` with an `ETag` header, never JSON. The file is now at `publicUrl`." | https://docs.zernio.com/guides/media-uploads.mdx |
| 400 on presign for a bad content type or > 5 GB. | "\| `400` on `POST /v1/media/presign` \| Missing `filename`, unaccepted `contentType` (such as `application/octet-stream`), or `size` above 5 GB. \|" | https://docs.zernio.com/guides/media-uploads.mdx |
| Uploads expire after 7 days (1 day and single-use under zero content retention). Creating a post copies the file to permanent storage. | "**Uploads expire after 7 days.** A post created or updated with the `publicUrl` copies the file to permanent storage" | https://docs.zernio.com/guides/media-uploads.mdx |
| An expired upload makes the create return 400. | "\| `400` creating a scheduled, queued or `publishNow` post \| Upload older than 7 days. With zero content retention: older than 1 day, or already used by another post or email." | https://docs.zernio.com/guides/media-uploads.mdx |
| A stale `uploadUrl` is refused. | "\| `PUT` refused by storage \| `uploadUrl` older than 1 hour. \| Request a new one. \|" | https://docs.zernio.com/guides/media-uploads.mdx |
| Content-Length on the PUT: **not documented.** Every example sends a whole buffer (`body: fileBuffer`, `--data-binary @photo.jpg`). | — | https://docs.zernio.com/guides/media-uploads.mdx |

## 6. Create post and TikTok settings

| Fact | Quote | Page |
| --- | --- | --- |
| `POST /v1/posts` with `content`, `mediaItems[{type,url}]`, `platforms[{platform,accountId}]`, `tiktokSettings`, `publishNow`. | curl example: `"content": "New cooking tutorial #recipe #foodtok", "mediaItems": [ {"type": "video", "url": "https://cdn.example.com/cooking-tutorial.mp4"} ], "platforms": [ {"platform": "tiktok", "accountId": "66b2e19d8c3f5a7e9d0b1c2d"} ], "tiktokSettings": { "privacy_level": "PUBLIC_TO_EVERYONE", "allow_comment": true, "allow_duet": true, "allow_stitch": true, "content_preview_confirmed": true, "express_consent_given": true }, "publishNow": true` | https://docs.zernio.com/platforms/tiktok/posts.mdx |
| `tiktokSettings` goes at the top level and is required on every TikTok post. | "Send `tiktokSettings` at the request body's top level: it applies to every TikTok entry, and TikTok requires it on every post." | https://docs.zernio.com/platforms/tiktok/posts.mdx |
| Required TikTok fields. `allow_comment`, `allow_duet` and `allow_stitch` have no default. | "\| `allow_comment` \| boolean \| \| Required. … \|\n\| `allow_duet` \| boolean \| \| Required for videos. … \|\n\| `allow_stitch` \| boolean \| \| Required for videos. … \|\n\| `content_preview_confirmed` \| boolean \| \| Required, must be `true`. Legal requirement from TikTok. \|\n\| `express_consent_given` \| boolean \| \| Required, must be `true`. Legal requirement from TikTok. \|" | https://docs.zernio.com/platforms/tiktok/fields.mdx |
| `privacy_level` must come from creator info; Business-lane videos must be public unless a draft. | "\| `privacy_level` \| string \| \| Required. One of the creator's values from [creator info] … Accounts connected through TikTok's Business app publish videos as public only: non-public values on video direct posts are rejected unless `draft: true`" | https://docs.zernio.com/platforms/tiktok/fields.mdx |
| None of the consent/privacy fields has a default. | "TikTok publishes only with `content_preview_confirmed` and `express_consent_given` `true` and a `privacy_level` from the account's [creator info](/accounts/get-tiktok-creator-info). None of the three has a default." | https://docs.zernio.com/guides/platform-settings.mdx |
| Cover from a timestamp (default 1000 ms). | "\| `video_cover_timestamp_ms` \| number \| `1000` \|" | https://docs.zernio.com/platforms/tiktok/fields.mdx |
| AI disclosure and commercial disclosure are optional fields. | "\| `video_made_with_ai` \| boolean \| \| AI-generated content disclosure." and "\| `commercialContentType` \| `\"none\"` \\| `\"brand_organic\"` \\| `\"brand_content\"` \| \| Commercial content disclosure." | https://docs.zernio.com/platforms/tiktok/fields.mdx |
| `publishNow` publishes synchronously inside the request; the response may be 207. | "**publishNow** `boolean`: Publish to every platform synchronously in this request instead of scheduling; the response then carries each platform result and `platformPostUrl`, with HTTP 207 when some platforms failed." | https://docs.zernio.com/posts/create-post.mdx |
| With no scheduling field the post is saved as a Zernio draft. `isDraft: true` never publishes. | "With none of them and `isDraft` unset, the post is saved as a draft." and "`isDraft: true` wins over `publishNow` and `scheduledFor` (the post is saved, never published)." | https://docs.zernio.com/posts/create-post.mdx |
| `publish_type` is not supported. | "Important: The field publish_type is NOT supported. Use draft: true for Creator Inbox flow." | https://docs.zernio.com/posts/create-post.mdx |
| 201 body: `{ message, post, warnings }`; the post id is `post._id`. | "#### 201: Post created … - **message** `string` … - **post**: `Post` … - **warnings** `array[string]`" and `"post": { "_id": "65f1c0a9e2b5af0012ab34cd", "status": "published", "platforms": [ { "platform": "tiktok", "status": "published", "platformPostUrl": null } ] }` | https://docs.zernio.com/posts/create-post.mdx, https://docs.zernio.com/platforms/tiktok/posts.mdx |
| 207 outcomes: `partial`, `failed` (terminal), `scheduled` (transient, Zernio retries; not a failure). | "- `failed`: no platform published. Terminal; nothing will be retried. … - `scheduled`: every platform hit a transient error and was reset to `pending`. Zernio retries automatically. This is **not** a failure; do not surface it to an end user as one." | https://docs.zernio.com/posts/create-post.mdx |
| A 207 can also mean the publish aborted before it started. | "A publish attempt that aborted before it started (for example the post was already being processed) reports none of the three: `post.status` is unchanged and `platformResults` is absent." | https://docs.zernio.com/posts/create-post.mdx |
| `dryRun: true` checks a TikTok post without creating anything. | "Returns HTTP 200 with `{ dryRun: true, canPublish, tiktok: [...] }` instead of 201." | https://docs.zernio.com/posts/create-post.mdx |

## 7. TikTok limits and the daily cap

| Fact | Quote | Page |
| --- | --- | --- |
| Video limits. | "\| Video formats \| MP4, MOV, WebM \|\n\| Video max size \| 4 GB \|\n\| Video duration \| 3 seconds to 10 minutes \|" | https://docs.zernio.com/platforms/tiktok.mdx |
| Caption limit. | "\| Character limit \| 2,200 (video caption), 4,000 (photo `description`) \|" | https://docs.zernio.com/platforms/tiktok.mdx |
| Format advice. | "\| Aspect ratio \| 9:16 vertical (the only format that works well) \|\n\| Resolution \| 1080 x 1920 px recommended \|\n\| Codec \| H.264 \|" | https://docs.zernio.com/platforms/tiktok/media.mdx |
| 15 videos per rolling 24 h on Business-lane accounts; over the cap a post is **held, not failed**. | "On an account connected through TikTok's Business app, Zernio allows 15 videos and 15 photo posts per account per rolling 24 hours." and "A post beyond the cap is not failed. Zernio holds it and publishes it by itself once the rolling window frees a slot." | https://docs.zernio.com/platforms/tiktok/posts.mdx |
| Settled conflict: the rate-limits page says a daily cap returns 429 in general, but carves out TikTok in the same section. For TikTok Business-lane accounts the cap holds the post; an account **cooldown** still returns 429. | "A daily cap or an account cooldown still returns `429` with the cooldown in the message." followed by "- **TikTok:** the 2 counts are separate, over a rolling 24 hours. A post past the cap is held until a slot frees, not rejected" | https://docs.zernio.com/guides/rate-limits.mdx |
| Developer-lane accounts keep the generic daily cap (which returns 429). | "Accounts on TikTok's developer app keep Zernio's generic per-platform daily cap instead" | https://docs.zernio.com/platforms/tiktok/posts.mdx |
| Velocity cap 25/hour; over it the post is held. | "\| Velocity cap \| 25 posts per hour per account \|" and "A post over the hourly cap is held and published automatically, not rejected." | https://docs.zernio.com/guides/rate-limits.mdx |
| TikTok's own API limit fails the post. | "A post TikTok rejects for it fails with \"You have created too many posts in the last 24 hours via the API\"." | https://docs.zernio.com/platforms/tiktok/posts.mdx |
| "Direct posting at capacity" affects developer-lane accounts only; the post is failed and not retried. Business lane never sees it. | "The post is marked `failed` and is not retried automatically. Either:\n\n- [Retry](/posts/retry-post) it a few hours later, or reschedule it." and "Accounts connected through TikTok's Business app do not draw on that budget and never see this error." | https://docs.zernio.com/platforms/tiktok/posts.mdx |
| API moderation is stricter than in the app. | "Content moderation is stricter through the API than in the app." | https://docs.zernio.com/platforms/tiktok.mdx |
| The post status while held: **not documented**. | — | — |

## 8. Drafts (TikTok Creator Inbox)

| Fact | Quote | Page |
| --- | --- | --- |
| The inbox draft is `tiktokSettings.draft: true`, not a top-level `draft` and not `isDraft`. | "Set `tiktokSettings.draft: true` and Zernio uploads the media to the creator's TikTok inbox instead of publishing it." | https://docs.zernio.com/platforms/tiktok/posts.mdx |
| A delivered draft shows as entry `published` with `platformSpecificData.isDraft: true` and no URL. There is no separate draft status. | "Zernio marks the platform entry `published` as soon as TikTok accepts the upload. That is the moment the draft is handed over, not the moment it goes live." and "The entry carries `platformSpecificData.isDraft: true` and no `platformPostUrl`." | https://docs.zernio.com/platforms/tiktok/posts.mdx |
| If the creator later posts it publicly, the URL appears and `post.tiktok.url_resolved` fires. | "When the creator posts the draft publicly, Zernio fills `platformPostUrl` and fires the `post.tiktok.url_resolved` webhook. A draft the creator never posts, or posts as private, keeps no URL." | https://docs.zernio.com/platforms/tiktok/posts.mdx |
| Five pending drafts per 24 h; waiting does not free a slot. | "TikTok allows 5 pending drafts per account in any 24-hour period. A 6th fails … and the only fix is to finish or discard drafts in the TikTok app; waiting does not free the slot." | https://docs.zernio.com/platforms/tiktok/posts.mdx |
| Draft scope and app version. | "Drafts need the `video.upload` scope (granted in the standard connect flow) and TikTok app version 31.8 or later on the creator's phone." | https://docs.zernio.com/platforms/tiktok/posts.mdx |
| Caption, cover, privacy and the Post tap happen in TikTok. | "The creator gets an inbox notification in the TikTok app and finishes the post in TikTok's own editor. Caption, cover, privacy, and the final Post tap all happen there." | https://docs.zernio.com/platforms/tiktok/posts.mdx |
| A draft still needs a scheduling field (`publishNow`), because a post with none is a Zernio draft. This follows from the general rule in §6 above; no TikTok-draft example shows the full body. | "With none of them and `isDraft` unset, the post is saved as a draft." | https://docs.zernio.com/posts/create-post.mdx |

## 9. Read post and statuses

| Fact | Quote | Page |
| --- | --- | --- |
| `GET /v1/posts/{postId}` returns `{ post }`. | "## GET /v1/posts/{postId}\n\n**Get post**\n\nFetch a single post by ID. For published posts, this returns platformPostUrl for each platform." and "#### 200: Post … - **post**: `Post`" | https://docs.zernio.com/posts/get-post.mdx |
| Post status values. | "- one of: draft, pending_approval, scheduled, publishing, published, partial, failed, cancelled" | https://docs.zernio.com/posts/get-post.mdx |
| Entry status values and error fields. | "Entry `status`: `pending`, `processing`, `uploading`, `published`, `failed` or `cancelled`, plus `platformPostUrl` once published. Failed entries add `errorMessage` (readable), `errorCategory` and `errorSource`." | https://docs.zernio.com/guides/post-lifecycle.mdx |
| Entry fields (list summary view; the get-post schema lists `platforms` as "No description"). | "- Each platform: `platform`, `status`, `accountId` (the id), `username`, `scheduledFor`, `publishedAt`, `platformPostId`, `platformPostUrl`, `errorMessage`, `errorCategory`." | https://docs.zernio.com/posts/list-posts.mdx |
| `errorSource` says who can fix it. | "`errorSource` says who can fix it: `user` errors need action from you or your user; `platform` and `system` errors are worth retrying." | https://docs.zernio.com/guides/post-lifecycle.mdx |
| TikTok may hold the post at `publishing` for up to 48 h. | "**TikTok can hold the rollup for up to 48 hours.** A TikTok entry stays `uploading` while TikTok processes it, and the post stays `publishing`." | https://docs.zernio.com/guides/post-lifecycle.mdx |
| The TikTok URL arrives minutes later. | "TikTok exposes the video id some minutes after publishing, so `platformPostUrl` can be empty at first." | https://docs.zernio.com/platforms/tiktok/posts.mdx |
| A removed post stays `published`. | "**Removed posts stay `published`.** An entry that disappears from the platform keeps `status: \"published\"` and gets `removedFromPlatformAt`." | https://docs.zernio.com/guides/post-lifecycle.mdx |
| `updatedAt` changes on any platform change. | "- **updatedAt** `string`: Last change to the post or to any of its platforms (a publish, a failure, a resolved URL)." | https://docs.zernio.com/posts/get-post.mdx |
| Nothing can edit or remove a live TikTok post through Zernio. | "Not supported on Instagram, TikTok, or Snapchat." (unpublish) and "- **No edit API:** Instagram, Threads, TikTok, Snapchat, WhatsApp and Bluesky." | https://docs.zernio.com/posts/unpublish-post.mdx, https://docs.zernio.com/guides/post-lifecycle.mdx |

## 10. Retry

| Fact | Quote | Page |
| --- | --- | --- |
| `POST /v1/posts/{postId}/retry` re-runs only the failed platforms of a `failed` or `partial` post. | "## POST /v1/posts/{postId}/retry\n\n**Retry failed post**\n\nImmediately retries publishing a failed post. Returns the updated post with its new status." and "\| [Retry](/posts/retry-post) \| `failed`, `partial` \| Retries only the failed platforms. \|" | https://docs.zernio.com/posts/retry-post.mdx, https://docs.zernio.com/guides/post-lifecycle.mdx |
| 207 on retry: read `post.status`. | "This response carries no `platformResults`. Read `post.status` (`partial`, `failed`, or `scheduled` when transient errors will be retried automatically) and `post.platforms[]` for per-platform detail." | https://docs.zernio.com/posts/retry-post.mdx |
| Other retry statuses. | "#### 409: Post is currently publishing", "#### 422: Invalid resource state (`invalid_resource_state`): this team does not retain content …", "#### 429: Rate limit exceeded. Possible causes: API rate limit (requests per minute) or account cooldown" | https://docs.zernio.com/posts/retry-post.mdx |
| A file used by a post is copied to permanent storage, so a retry needs no new upload. | "A post created or updated with the `publicUrl` copies the file to permanent storage" | https://docs.zernio.com/guides/media-uploads.mdx |

## 11. Webhooks and signatures

| Fact | Quote | Page |
| --- | --- | --- |
| Contract: POST JSON, answer 2xx within 5 s, up to 7 attempts over about 51 h, dedupe on `id`, `X-Zernio-Signature`. | "\| Your answer \| Any `2xx` within 5 seconds \|\n\| Retries \| Up to 7 attempts over about 51 hours …\|\n\| Duplicates \| Possible. Dedupe on `id`, also sent as `X-Zernio-Event-Id` \|\n\| Signature \| `X-Zernio-Signature`, HMAC-SHA256 of the raw body with your `secret` \|" | https://docs.zernio.com/webhooks.mdx |
| Signature: lowercase hex HMAC-SHA256 of the raw body, keyed with the secret we set. Only sent when the endpoint has a secret. | "When the endpoint has a `secret`, `X-Zernio-Signature` is the lowercase hex HMAC-SHA256 of the raw body. Compute it and reject any request that does not match." | https://docs.zernio.com/webhooks.mdx |
| Zernio never generates the secret. | "**1. Create an endpoint.** Send `name`, `url`, `events` and a `secret`. Zernio signs with that secret and never generates one for you." | https://docs.zernio.com/webhooks.mdx |
| Registration: dashboard or `POST /v1/webhooks/settings` (`name`, `url`, `events` required; `secret` optional). | "Create endpoints with `POST /v1/webhooks/settings` or in the [webhooks dashboard](https://zernio.com/dashboard/webhooks)." and "- **secret** `string`: Secret key for HMAC-SHA256 signature verification" | https://docs.zernio.com/webhooks.mdx, https://docs.zernio.com/webhooks/create-webhook-settings.mdx |
| Retry rules: 408, 429, 5xx, timeouts and an HTML 2xx are retried; any other 4xx dead-letters at once. | "Zernio retries a `408`, a `429`, any `5xx`, a timeout, a connection error and a `2xx` whose body is an HTML page. Any other `4xx` ends delivery on the first attempt and dead-letters the event." | https://docs.zernio.com/webhooks.mdx |
| Envelope: `id`, `event`, `timestamp`, `profiles`, `test`. `id` is stable across retries. | "\| `id` \| string \| The event id, identical on every retry and redelivery. \|\n\| `event` \| string \| The event name, such as `post.published`. \|\n\| `timestamp` \| string \| When Zernio generated the event (ISO 8601, UTC). Retries keep it. \|" | https://docs.zernio.com/webhooks.mdx |
| Headers. | "Content-Type: application/json\nUser-Agent: Zernio-Webhooks/1.0\nX-Zernio-Event: webhook.test\nX-Zernio-Event-Id: …\nX-Zernio-Signature: …" | https://docs.zernio.com/webhooks.mdx |
| The post id in post events is `post.id` (not `_id`). | "- **post** (required) `object`: \n  - **id** (required) `string`" | https://docs.zernio.com/webhooks/social/post-failed.mdx |
| Per-platform events carry `platform.publishedUrl` (not `platformPostUrl`). | "**publishedUrl** `string`: Public URL to the platform-side post. Present on `published` (when the platform exposes one and it is not a draft)" | https://docs.zernio.com/webhooks/social/post-platform-published.mdx |
| `metadata` from create is echoed on post events. | "The free-form `metadata` from [Create post](/posts/create-post) comes back as `post.metadata` on every rollup event … and every per-platform event." | https://docs.zernio.com/webhooks/social.mdx |
| Event names (all exist): `post.published`, `post.partial`, `post.failed`, `post.platform.published`, `post.platform.failed`, `post.tiktok.url_resolved`. | "\| `post.platform.published` / `post.platform.failed` \| Per platform target, as soon as it reaches a terminal state \|\n\| `post.tiktok.url_resolved` \| A published TikTok post's public URL is available" | https://docs.zernio.com/guides/post-lifecycle.mdx |
| Events can contradict earlier ones. | "It can fire for a target that already emitted `post.platform.published`, if background reconciliation finds the publish never completed." | https://docs.zernio.com/webhooks/social/post-platform-failed.mdx |
| | "It can follow a `post.partial` or `post.failed` for the same post when TikTok later reports a failed TikTok target as published." | https://docs.zernio.com/webhooks/social/post-published.mdx |
| `post.platform.failed` fires only on permanent failure. | "Only on permanent failure; retryable errors stay silent." | https://docs.zernio.com/webhooks/social/post-platform-failed.mdx |
| Redeliveries are byte-for-byte replays for 30 days. | "Replay a past delivery: the original payload is re-sent, byte for byte, to the\nsubscription's current URL. The original event ID is preserved so your endpoint can\ndedupe" | https://docs.zernio.com/webhooks/redeliver-webhook-event.mdx |
| Replay protection or a signed timestamp: **not documented.** Only dedupe on `id` is described. | "Store `id` (also `X-Zernio-Event-Id`) in a unique index before processing, and skip the event when the insert conflicts." | https://docs.zernio.com/webhooks.mdx |

## 12. Pricing, as stated

| Fact | Quote | Page |
| --- | --- | --- |
| First 2 connected accounts included (a $12 monthly credit), then graduated per account per month. | "\| Connected accounts \| 2 accounts (a $12 monthly credit) \| $6 per account for accounts 3 to 10, $3 for 11 to 100, $1 from 101, no cap. Per account per month \|" | https://docs.zernio.com/pricing/social.mdx |
| A TikTok account is one account. | "- Posting accounts: an Instagram account, a Facebook Page, a YouTube channel, a TikTok account. One each." | https://docs.zernio.com/pricing/social.mdx |
| No card for the first 2 accounts; posts unlimited. | "- **Do I need a card?** Not for the first 2 accounts. … - **Are posts limited?** No. Posts are unlimited on every current plan." | https://docs.zernio.com/pricing.mdx |
| A third account without a card is refused with 402. | "\| Connecting a third social account (`GET /v1/connect/{platform}`, ...) \| `free_tier_exceeded` \|" | https://docs.zernio.com/pricing/payment-method-required.mdx |
| Every account includes every feature (no separate API tier). | "Every account includes every feature." | https://docs.zernio.com/pricing.mdx |
| Currency: shown as "$"; the usage API field is `totalUsd`, so treat amounts as US dollars. | — | https://docs.zernio.com/usage/get-usage.mdx |

---

## Not documented / still to confirm with a live check or the first post

These are the gaps. None of them needs a guess in code: each has a safe fallback in publishing §7.2.

1. **Status of a post held over TikTok's daily cap.** The docs say it is held, not which `post.status` or entry
   status it carries. Fallback: any `scheduled` post or `pending` entry maps to `queued` with a neutral message.
2. **Content-Length / streamed PUT to `uploadUrl`.** Not mentioned. Fallback: send an explicit `Content-Length`
   (the byte size we already know) with a streamed body; never chunked transfer encoding. A refused PUT happens
   before any post exists, so it is safe to retry with a new presign.
3. **How long a `publishNow` create takes.** It is synchronous, but no duration or timeout is documented. Fallback:
   a long client timeout and, on timeout, the "outcome unknown" path (read-only lookup by `metadata`, then the owner).
4. **Whether a personal (non-Business) TikTok account can publish on the Business lane.** Only DMs are documented as
   needing a Business Account. Fallback: trust `permissions.canPost` from the health endpoint and creator info.
5. **Whether Zernio's own TikTok app is audited** (no page mentions audit or forced `SELF_ONLY`). The documented rule
   is lane-based: Business-lane video direct posts are public only.
6. **The full body of a TikTok inbox draft.** That `publishNow` must accompany `tiktokSettings.draft: true` follows
   from the general rule; no example shows it. Confirm with the separate draft verification.
7. **Whether the dashboard lets the owner type the webhook secret.** The API accepts `secret`; the dashboard page is
   not described. Fallback: polling only (webhooks are optional), or register once with
   `POST /v1/webhooks/settings`.
8. **Webhook body size limit and delivery order after retries.** Not documented. Fallback: 256 KB route limit; never
   trust order; every event only triggers a read.
9. **Accounts per profile for TikTok.** The 11 Sep 2026 changelog said one TikTok account per profile; the current
   TikTok page says "A profile can hold several TikTok accounts." The adapter does not depend on it.
10. **Whether `Idempotency-Key` values other than UUIDs are accepted.** The docs ask for "a UUID per logical post, up
    to 255 characters" and only reject longer keys. Fallback: send a UUID (the target id).
11. **Live behaviour to record on the first verification post:** URL resolution delay, `integrationLane` of the
    owner's account, the exact `errorCategory` values TikTok errors map to, and whether the pricing above still holds.
