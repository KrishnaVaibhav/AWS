# 🚀 GitHub → AWS deploy pipeline

## 📁 Repo layout

```
your-repo/
├── .github/workflows/deploy.yml
└── stacks/
    └── budget-nuke.yaml
```

`github-oidc-bootstrap.yaml` is deployed by hand, not by the pipeline. Keep it
in the repo for reference but it doesn't live under `stacks/`.

## 1️⃣ Bootstrap (manual, once)

```bash
aws cloudformation deploy \
  --template-file github-oidc-bootstrap.yaml \
  --stack-name github-oidc \
  --region us-east-1 \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
      GitHubOrg=YOUR_USERNAME \
      GitHubRepo=YOUR_REPO \
      AllowedBranch=main
```

Copy the `DeployRoleArn` output.

## 2️⃣ Repo settings

Settings → Secrets and variables → Actions

**Secrets:**
| Name | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | the ARN from step 1 |
| `ALERT_EMAIL` | your email |

**Variables:**
| Name | Value |
|---|---|
| `BUDGET_AMOUNT` | e.g. `10` |

## 3️⃣ Environment gate (recommended)

Settings → Environments → New environment → `aws`

Add yourself under **Required reviewers**. Arming the nuke then needs an
approval click instead of firing on a push.

The workflow references `environment: aws`. If you skip this step, delete that
line or deploys will hang.

## 4️⃣ Push

```bash
git add . && git commit -m "budget nuke" && git push
```

Deploys disarmed. Confirm the SNS email that arrives.

## 🔥 Arming

Actions tab → Deploy CloudFormation → Run workflow → `arm_nuke: true`

Deliberately manual. A push to main never arms it — the workflow defaults
`ArmNuke` to false whenever the run wasn't a manual dispatch.

## ⚙️ What each trigger does

| Trigger | Result |
|---|---|
| Pull request touching `stacks/` | 🔎 validate + lint + change set preview, no apply |
| Push to main | 🚢 deploy, disarmed |
| Manual dispatch | 🎛️ deploy, armed or not, your choice |

## 🔁 Circularity

The nuke would delete the OIDC provider and deploy role, locking GitHub out.
Both are filtered in `budget-nuke.yaml`. If you rename either one, update the
`IAMRole` and `IAMOpenIDConnectProvider` filters to match or you'll lose access.

## 📝 Notes

- Region is pinned to `us-east-1` in the workflow. Budgets only lives there.
- The deploy role is scoped to one repo and one branch. A fork or another
  branch cannot assume it.
- AdministratorAccess on the deploy role is needed because the nuke stack
  creates IAM roles. Narrow it if you later split IAM into its own stack.
- Cost: $0. Public repos get unlimited Actions minutes; private gets 2,000/mo.