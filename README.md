# cloudpin account check

A GitHub Action that stops a job before it deploys to the wrong cloud account. Your repository pins its accounts in a
[`.cloudpin.yml`](https://github.com/paureis/cloudpin#configuration) file (an Azure subscription, an AWS account, a
Kubernetes server, a Vercel team, and so on). Add this step after the job's cloud logins and before its deploy: it
runs [cloudpin](https://github.com/paureis/cloudpin) against the logins the job actually has, and fails the job when a
checked cloud isn't installed, isn't logged in, or is logged in to an account other than the pinned one. A wrong
secret, a copied workflow or a stale variable then fails at this step instead of deploying.

> **Not released yet.** `v1` ships together with cloudpin 1.2.0, which adds the `check --only` and `--json` modes
> this action uses.

## Usage

```yaml
steps:
  - uses: actions/checkout@v7
  - uses: actions/setup-node@v7     # the action needs Node.js 22 or later
    with:
      node-version: 22
  # ... your cloud logins ...
  - uses: paureis/cloudpin-action@v1
    with:
      check: azure, aws             # optional; empty means every cloud pinned in .cloudpin.yml
  # ... your deploy ...
```

The step reads `.cloudpin.yml` from the repository root (or `working-directory`), checks each cloud and writes a
short table to the job summary. Each failing cloud gets an error annotation with the reason and the fix, both taken
from cloudpin's own output.

### Which clouds are checked

- **`check` set** (for example `azure, aws`): each listed cloud must be pinned, installed and logged in to the pinned
  account. Pinned clouds that aren't listed are ignored. This is the setting for most jobs: GitHub's hosted runners
  come with az, aws, gcloud, gh and kubectl installed, and a job usually logs into only some of them.
- **`check` empty** (the default): every cloud pinned in `.cloudpin.yml`, with the same strict rule.
- **No `.cloudpin.yml`**: with `check` empty the step passes (result `unpinned`) and says nothing is pinned. With
  `check` set it fails, because the workflow expected pins that aren't there.

Cloud names are cloudpin's pin names: `azure`, `aws`, `gcloud`, `vercel`, `github`, `kubernetes`, `supabase`,
`cloudflare`.

### Environments

If `.cloudpin.yml` defines [environments](https://github.com/paureis/cloudpin#environments), the `environment` input
picks one. Without it, cloudpin's `branches:` mapping applies: the action passes the pull request's head branch (or,
on a push or tag, the branch or tag name) as `CLOUDPIN_BRANCH`, because CI checks out a detached commit where
cloudpin can't see a branch.

## Examples

The Azure and AWS examples are written from the official docs of
[azure/login](https://github.com/Azure/login#readme) and
[aws-actions/configure-aws-credentials](https://github.com/aws-actions/configure-aws-credentials#readme) (read
2026-10-16) and have not yet been run against a real account. The IDs below are placeholders.

### Azure

```yaml
# .cloudpin.yml
azure:
  subscription: 00000000-0000-0000-0000-000000000000
```

```yaml
permissions:
  id-token: write   # GitHub OIDC for azure/login
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - uses: azure/login@v3
        with:
          client-id: ${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: ${{ secrets.AZURE_TENANT_ID }}
          subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
      - uses: paureis/cloudpin-action@v1
        with:
          check: azure
      - run: az deployment group create ...   # runs only if the subscription is the pinned one
```

### AWS

```yaml
# .cloudpin.yml
aws:
  account: "111111111111"
```

```yaml
permissions:
  id-token: write   # GitHub OIDC for configure-aws-credentials
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: arn:aws:iam::111111111111:role/deploy
          aws-region: us-east-1
      - uses: paureis/cloudpin-action@v1
        with:
          check: aws
      - run: aws s3 sync ./site s3://my-bucket
```

### Two clouds in one job

```yaml
# .cloudpin.yml
azure:
  subscription: 00000000-0000-0000-0000-000000000000
aws:
  account: "111111111111"
```

```yaml
      # after both logins above
      - uses: paureis/cloudpin-action@v1
        id: cloudpin
        with:
          check: azure, aws
      - run: ./deploy.sh                       # runs only if both accounts match
      - if: failure() && steps.cloudpin.outputs.result == 'mismatch'
        run: echo "A login points at the wrong account; see the cloudpin step's summary."
```

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `check` | empty (every pinned cloud) | Comma-separated clouds that must be installed, logged in and on the pinned account. |
| `version` | the cloudpin version this release was tested with | The cloudpin version to install from npm: an exact version such as `1.2.0`, or `latest`. |
| `working-directory` | `.` | Where to look for `.cloudpin.yml`; cloudpin searches upward from there. |
| `environment` | empty | The `.cloudpin.yml` environment to check (sets `CLOUDPIN_ENV`). Empty lets cloudpin pick it. |

## Output

| Output | Values |
|---|---|
| `result` | `match`, `mismatch`, `unpinned` or `error`. Empty if the step failed before checking (no Node.js, install failure). |

The step passes only for `match` and `unpinned`. Anything it can't read as a cloudpin result fails the step.

## What it does not do

- **It doesn't log in, switch accounts or read credentials.** Log in with your usual actions first; this step only
  checks which accounts those logins point at.
- **It checks the logins at the moment it runs**, not each later command. A deploy step that switches profile or
  subscription itself (`aws --profile other ...`) isn't checked.
- **It has no warn-only mode.** A mismatch always fails the job.

## Pin it by commit

Tags can be moved. For the strongest guarantee, pin this action (and every third-party action in the job) to a full
commit SHA, with the tag in a comment:

```yaml
- uses: paureis/cloudpin-action@<full commit SHA> # v1.0.0
```

Dependabot and Renovate keep SHA pins up to date.

## How it works

A composite action with bash steps, written for Linux, Windows and macOS runners (its tests run on Linux, and on
Windows before each release):

1. Checks that Node.js 22 or later is on the runner.
2. Installs the exact cloudpin version into the runner's temp folder with `npm install --ignore-scripts` (no install
   script runs), then verifies the registry signatures of what was installed with `npm audit signatures`.
3. Runs `cloudpin check --json --only <clouds>`. With `check` empty it first runs a plain `cloudpin check --json` to
   learn which clouds are pinned, then checks those strictly.
4. Turns the JSON into the job summary, the annotations and the `result` output.

The summary and annotations contain only cloudpin's own texts (the reason and the fix), which never include a token
or credential value. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
