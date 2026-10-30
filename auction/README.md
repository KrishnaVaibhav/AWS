<h1 align="center">🔨 auction</h1>

<p align="center">
  <em>A fully configurable auction platform on AWS serverless. Idle cost ≈ $0.<br/>
  One CloudFormation stack per stage, deployed <strong>and destroyed</strong> from the same pipeline.</em>
</p>

<p align="center">
  <img alt="IaC" src="https://img.shields.io/badge/IaC-SAM%20%2F%20CloudFormation-C7215C?style=for-the-badge&logo=amazonwebservices&logoColor=white">
  <img alt="CI" src="https://img.shields.io/badge/CI-GitHub%20Actions-2088FF?style=for-the-badge&logo=githubactions&logoColor=white">
  <img alt="Region" src="https://img.shields.io/badge/Region-us--east--1-FF9900?style=for-the-badge">
  <img alt="Idle cost" src="https://img.shields.io/badge/Idle%20cost-~%240-277116?style=for-the-badge">
</p>

---

## 🧭 Table of contents

| # | Section |
|---|---|
| 🏗️ | [Architecture](#️-architecture) |
| 📁 | [Layout](#-layout) |
| 🧱 | [Resource inventory](#-resource-inventory) |
| 🏷️ | [Stages and parameters](#️-stages-and-parameters) |
| 🔄 | [Pipeline](#-pipeline) |
| 🛠️ | [Setup](#️-setup) |
| 🚀 | [Deploy](#-deploy) |
| 💥 | [Destroy](#-destroy) |
| 📤 | [Outputs](#-outputs) |
| ⚠️ | [Gotchas](#️-gotchas) |

---

## 🏗️ Architecture

<p align="center">
  <img src="docs/architecture.svg" alt="auction runtime architecture" width="100%">
</p>

The full design is in **[docs/architecture.md](docs/architecture.md)**: services and free tiers, the bid / close / media flows, the data model, the rules engine with every auction setting, the host and bidder features, security, cost, and build phases.

**The request path in one line:** `CloudFront` ⟶ `S3` (app + media) or `Lambda Function URL` (API) ⟶ `DynamoDB` ⟶ `Streams` ⟶ `AppSync Events` (live bids).

---

## 📁 Layout

The app is self-contained. Nothing here touches `stacks/` or `deploy.yml`, and nothing there touches this folder.

```
auction/
├── template.yaml            🧱 SAM template: the whole app, one stack per stage
├── functions/
│   ├── api/index.mjs        ⚡ /api/* router (health check live, rest phase 1)
│   ├── media/index.mjs      🖼️ incoming/ → magic-byte check → media/
│   ├── stream/index.mjs     📣 DynamoDB Streams fan-out (stub)
│   ├── closer/index.mjs     ⏱️ Scheduler target at closesAt (stub)
│   └── cron/index.mjs       🔁 every minute: ending-soon alerts (stub)
├── web/
│   └── index.html           🌐 placeholder page; the React PWA replaces it
├── scripts/
│   ├── deploy.sh            🚀 sam deploy → config.json → s3 sync → invalidate → smoke test
│   └── destroy.sh           💥 unlock data → empty buckets → delete stack
├── docs/
│   ├── architecture.md      📐 full design
│   ├── architecture.svg     🏗️ runtime diagram
│   └── pipeline.svg         🔄 CI/CD and lifecycle diagram
└── README.md
.github/workflows/auction.yml  🔄 Run workflow: preview | deploy | destroy (push/PR = lint only)
```

The pipeline and a laptop run the **same two scripts**, so a local deploy or destroy behaves exactly like CI.

---

## 🧱 Resource inventory

| Logical ID | Type | Note |
|---|---|---|
| `Table` | `AWS::DynamoDB::Table` | 🗄️ single table, GSI1 + GSI2, Streams, TTL `ttl`, PITR in prod |
| `WebBucket` / `WebBucketPolicy` | `AWS::S3::Bucket` + policy | 🌐 app + `config.json`, readable only by this distribution |
| `MediaBucket` / `MediaBucketPolicy` | `AWS::S3::Bucket` + policy | 🖼️ `incoming/` (expires in 1 day) → `media/` (served) |
| `UserPool` / `UserPoolClient` / `UserPoolDomain` | Cognito | 🔑 Essentials tier, email sign-in, TOTP MFA, hosted domain |
| `AdminGroup` / `HostGroup` | `AWS::Cognito::UserPoolGroup` | 👥 `admin`, `host` |
| `EventsApi` / `PublicNamespace` / `UserNamespace` / `EventsApiKey` | AppSync Events | 📡 `/public/*` for everyone, `/user/{sub}` for its owner only |
| `ScheduleGroup` / `SchedulerRole` | Scheduler + IAM | ⏱️ runtime `at(closesAt)` schedules live here; deleted with the stack |
| `ApiFunction` / `ApiFunctionUrl` / `Api*Permission` | Lambda + URL | ⚡ `AWS_IAM` URL, only CloudFront may call it |
| `MediaFunction` | Lambda | 🖼️ S3 event on `incoming/` |
| `StreamFunction` | Lambda | 📣 DynamoDB Streams consumer |
| `CloserFunction` | Lambda | 🔨 Scheduler target |
| `CronFunction` | Lambda | 🔁 `rate(1 minute)` via Scheduler |
| `*LogGroup` (5) | `AWS::Logs::LogGroup` | 📊 7-day retention, inside the stack so a delete removes them |
| `S3OriginAccessControl` / `LambdaOriginAccessControl` | CloudFront OAC | 🛡️ signs requests to the buckets and the API |
| `SpaRewriteFunction` | `AWS::CloudFront::Function` | 🔀 extension-less paths → `/index.html` |
| `Distribution` | `AWS::CloudFront::Distribution` | 🌍 `/*` web · `/media/*` media · `/api/*` API |

---

## 🏷️ Stages and parameters

| | `auction-dev` | `auction-prod` |
|---|---|---|
| DynamoDB | on-demand (idle = $0) | provisioned 15/15 + 5/5 + 5/5 = the free 25/25 |
| PITR | off | on |
| `DataProtection` | `false` | `true`: table and user pool refuse deletion |
| Deployed by | Run workflow, `stage: dev` | Run workflow, `stage: prod` |

| Parameter | Default | Set by |
|---|---|---|
| `Stage` | — | `deploy.sh <dev\|prod>` |
| `DataProtection` | `true` | `deploy.sh` (from stage); `destroy.sh` flips it to `false` |
| `ApiKeyExpires` | — | `deploy.sh`: today + 360 days, on every deploy |
| `ApiReservedConcurrency` | `0` (no cap) | set by hand to cap API cost and blast radius |

---

## 🔄 Pipeline

<p align="center">
  <img src="docs/pipeline.svg" alt="auction CI/CD and lifecycle" width="100%">
</p>

Nothing reaches AWS until someone runs the workflow by hand: **Actions → 🔨 Auction App → Run workflow**. Pushes and PRs only lint.

| Trigger | Jobs | Touches AWS? |
|---|---|---|
| 🔀 Push or PR touching `auction/**` | 🔍 validate → 🧾 summary | ❌ lint only |
| 🎛️ Run workflow, `action: preview` | 🔍 validate → 📋 changeset → 🧾 summary | 👀 change set only, nothing applied |
| 🎛️ Run workflow, `action: deploy` | 🔍 validate → 🚀 deploy `auction-<stage>` → 🧾 summary | ✅ after your approval |
| 🎛️ Run workflow, `action: destroy` | 🛑 confirm → 💥 destroy `auction-<stage>` → 🧾 summary | 💥 deletes everything, after your approval |

- `validate` needs no AWS access: it runs `cfn-lint`, `node --check` and `shellcheck`.
- `deploy` and `destroy` run in the `aws` environment, so they wait for your approval.
- `preview` changes nothing, so it skips the approval. Run it from `main`, `dev` or `feature/*`, the branches the deploy role trusts.

---

## 🛠️ Setup

Nothing new is needed if the budget-nuke setup in the [root README](../README.md#️-setup) is done:

| Needed | Status |
|---|---|
| 🛡️ `github-oidc` bootstrap stack + `AWS_DEPLOY_ROLE_ARN` secret | reused as-is |
| 🚦 GitHub environment `aws` (with required reviewers) | reused as-is |
| 🔒 New secrets or variables | **none** |

For local runs you need AWS CLI v2, SAM CLI, `curl` and bash (Linux, macOS, WSL or Git Bash).

---

## 🚀 Deploy

**Pipeline:** **Actions → 🔨 Auction App → Run workflow → `action: deploy`, `stage: dev|prod`**, then approve. Pushing code alone never deploys.

From a terminal, the same run:

```bash
gh workflow run auction.yml -f action=deploy -f stage=dev    # then approve in Actions
gh workflow run auction.yml -f action=preview -f stage=prod  # change set only, no approval
```

**Local:**

```bash
auction/scripts/deploy.sh dev              # deploy + publish web + smoke test
auction/scripts/deploy.sh prod --preview   # change set only, applies nothing
```

The first create takes about 5–15 minutes, mostly CloudFront. Later deploys take a minute or two. The script ends by calling `GET /api/health` through CloudFront and prints the app URL.

---

## 💥 Destroy

> [!CAUTION]
> Destroy deletes the stage completely: the user pool and every account, the table with all bids, both buckets with every uploaded file, the CloudFront distribution, all functions, schedules and logs. The only safety net is the system backup DynamoDB makes automatically when a PITR-enabled table (prod) is deleted, which it keeps for up to 35 days. Users, media and everything else cannot be recovered.

**Pipeline:** **Actions → 🔨 Auction App → Run workflow →**
- `action: destroy`
- `stage: dev|prod`
- `confirm: auction-<stage>` (the exact stack name).

A wrong confirm fails at once, before anyone is asked to approve. The destroy itself then waits for the `aws` environment approval.

**Local:**

```bash
auction/scripts/destroy.sh dev
```

What the script does, in order:

1. **Unlock:** if `DataProtection=true`, update the stack with `DataProtection=false`, reusing the previous template and parameters. If the stack is stuck in a state that can't take an update (for example `DELETE_FAILED`), it turns off protection on the table and the user pool directly.
2. **Empty:** delete every object, old version and delete marker in both buckets, 1,000 at a time.
3. **Delete:** `delete-stack`, then wait. CloudFront needs ~15 minutes to disable and remove.

If any step fails, fix the cause and run it again. It continues from wherever the last run stopped.

**Left behind on purpose:** the `aws-sam-cli-managed-default` stack and its bucket. They hold the Lambda zips for every SAM app in the account, cost cents, and are recreated if missing.

---

## 📤 Outputs

| Output | Meaning |
|---|---|
| `AppUrl` | 🌍 `https://<id>.cloudfront.net`, the app |
| `DistributionId` | 🌍 for invalidations |
| `WebBucketName` / `MediaBucketName` | 🪣 buckets |
| `TableName` | 🗄️ `auction-<stage>` |
| `UserPoolId` / `UserPoolClientId` / `CognitoDomain` | 🔑 auth config for the web app |
| `EventsHttpDomain` / `EventsRealtimeDomain` / `EventsApiKey` | 📡 live-update endpoints and the public subscribe-only key |
| `ScheduleGroupName` | ⏱️ where item-close schedules go |
| `DataProtection` | 🛡️ current value |

`deploy.sh` writes the browser-facing values to `/config.json` in the web bucket. The page loads them from there, so nothing is hard-coded per stage.

---

## ⚠️ Gotchas

- **Budget-nuke.** In the same account as `budget-nuke`, this app is **not** protected by its keep filters, so a live nuke deletes it. Run production in its own AWS account (see [architecture §8](docs/architecture.md#8-cost)).
- **Auth header.** CloudFront OAC overwrites `Authorization`. Send the Cognito token in `x-auth-token`.
- **POST/PUT bodies.** Include `x-amz-content-sha256: <hex sha256 of body>`, or the Lambda URL rejects the request.
- **Public API key.** It expires 365 days after it was last refreshed. Every deploy moves it to +360 days. Deploy at least once a year, or the public live feed stops.
- **Previews.** A preview against a stack that doesn't exist yet leaves an empty `auction-<stage>` in `REVIEW_IN_PROGRESS`. The next deploy (or `destroy.sh`) clears it.
- **Concurrency quota.** New accounts may have a Lambda concurrency quota of 10. Raise it before you set `ApiReservedConcurrency`.
