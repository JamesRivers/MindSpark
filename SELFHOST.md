# Self-hosting MindSpark on a VM (GitHub OAuth + GitHub-backed maps + Cloudflare Tunnel)

This deployment keeps the editor static and stateless, but replaces SQLite with a
**GitHub repository**: each map is a JSON file, every save is a commit, and history
is the git history. GitHub OAuth is used only to obtain a token in the browser.
The server never sees map content and stores no sessions.

```
Browser ──HTTPS──> Cloudflare edge ──tunnel──> VM (selfhost/server.js) ── serves public/
   │
   └── GitHub API (OAuth token in localStorage): read/write maps repo
   └── LLM provider (BYOK key in localStorage): AI map generation
```

Two GitHub things are involved:

| Thing | Purpose |
|---|---|
| **OAuth App** | "Sign in with GitHub"; the VM holds the client secret and performs the code→token exchange at `/callback`. |
| **Maps repository** (e.g. `you/mindspark-maps`) | Stores `_index.json` and `maps/<id>.json`. Every signed-in user must have write access. |

## 1. Create the maps repository

Create a private repository, e.g. `you/mindspark-maps`. It only needs a README.
MindSpark writes into it; it does not need any workflow.

> GitHub *fine-grained* tokens cannot create repositories, and the OAuth flow
> uses an existing repo. Creating it once is part of setup.

## 2. Create the GitHub OAuth App

<https://github.com/settings/developers> → **New OAuth App**

- **Application name:** MindSpark
- **Homepage URL:** `https://mindspark.example.com`
- **Authorization callback URL:** `https://mindspark.example.com/callback`

Copy the **Client ID** and generate a **Client secret**. The secret lives only in
`/etc/mindspark/env` on the VM.

Scope requested by the app is `repo` (needed to read/write a private repository).

## 3. Create the Cloudflare Tunnel

Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel**
(Cloudflared). Copy the **tunnel token**.

Add a **Public hostname**:

- **Subdomain / domain:** `mindspark.example.com`
- **Service:** `http://localhost:8080`

The origin is plain HTTP on loopback; Cloudflare terminates TLS. No inbound
ports, DNS records, or certificates are needed on the VM.

## 4. Create the VM and install

On the Proxmox host, clone an Ubuntu cloud-init template and give the VM a
static address on the same bridge as the host. Example (adjust IDs/IPs):

```bash
qm clone 81902 81202 --name mindspark --full --storage local-lvm-thin
qm set 81202 --cores 2 --memory 2048 --balloon 0 \
  --ciuser james --sshkeys /tmp/mindspark.pub \
  --ide2 local-lvm-thin:cloudinit --boot order=scsi0 --serial0 socket \
  --agent enabled=1 --ipconfig0 ip=192.168.90.152/24,gw=192.168.90.2 \
  --nameserver 8.8.8.8 --onboot 1
qm start 81202
```

On the VM, with this repository available (clone it or copy a checkout):

```bash
sudo -i
cd /path/to/MindSpark
GITHUB_CLIENT_ID=... \
GITHUB_CLIENT_SECRET=... \
APP_ORIGIN=https://mindspark.example.com \
DEFAULT_REPO=you/mindspark-maps \
TUNNEL_TOKEN=... \
./selfhost/install.sh
```

Or pre-create `/etc/mindspark/env` from
[`selfhost/config.example.env`](config.example.env) and run
`./selfhost/install.sh` with `SRC_DIR=/path/to/MindSpark`.

The installer:

- installs Node.js 22 and cloudflared
- deploys the checkout to `/opt/mindspark/app`
- writes `/etc/mindspark/env` (mode 640, contains the OAuth secret)
- installs and starts `mindspark.service` on `127.0.0.1:8080`
- installs the tunnel with `cloudflared service install <token>`

Verify:

```bash
curl -s http://127.0.0.1:8080/status | jq
systemctl status mindspark cloudflared
journalctl -u mindspark -f
```

`/status` shows `"storage":"github-repo"`, `"oauth":true`, and the configured
repo. **`/healthz` intentionally returns 404** so the client selects forge
storage instead of local SQLite mode. Do not "fix" it.

## 5. Sign in

Open `https://mindspark.example.com`. The login card shows **Sign in with GitHub**.
After authorizing, maps are committed to the configured repository. The
repository field is pre-filled from `DEFAULT_REPO`.

To restrict who can sign in, set `ALLOWED_GITHUB_LOGINS=alice,bob`. The callback
verifies the GitHub login before delivering the token and revokes the grant for
anyone else. Repository write access is a second, independent gate: an
unlisted-but-authorized account still cannot read or write a private maps repo.

## BYOK AI (bring your own key)

The **✦** button beside **＋** opens *Create a mind map with AI*:

- pick a provider (Anthropic, OpenAI, OpenRouter, Groq, **OpenCode Console**,
  **OpenCode Go**, or a custom OpenAI-compatible endpoint added in
  Preferences)
- paste your own API key
- describe the topic

### OpenCode

Both OpenCode endpoints are built in:

| Provider | Endpoint | Use it with |
|---|---|---|
| OpenCode (Console) | `https://opencode.ai/inference/openai/v1/chat/completions` | Pay-as-you-go Console credits |
| OpenCode Go | `https://opencode.ai/inference/go/openai/v1/chat/completions` | A Go / Go Plus subscription |

Create a personal API key at <https://opencode.ai/console> → **Account →
Personal API keys** (format `oc_sk_...`), then paste it into the ✦ panel and
type the model id (for example `glm-5.3`, `kimi-k3`, `claude-sonnet-5-5`).
Free-tier models are only available inside OpenCode itself; use paid credits or
Go from another client such as MindSpark.

The key is stored in that browser's `localStorage` under
`mindspark:llm:key:<provider>` and sent **directly to the provider** — never to
the VM. The same key is shared with the existing branch-level
*Build prompt → Run with API* panel. "Forget key" removes it.

For a custom provider, add its origin to `EXTRA_CONNECT_SRC` in
`/etc/mindspark/env` and restart (`systemctl restart mindspark`), otherwise the
Content-Security-Policy blocks the request.

## Updates

```bash
git -C /opt/mindspark/app pull --ff-only
systemctl restart mindspark
```

The service reads `public/` on every request (short cache headers), so a restart
is enough. A deploy from a new VM is the same installer with the same variables.

## Why not the Cloudflare Worker?

The upstream worker mode is excellent and needs no VM. This variant exists
because the requirement was a VM on `colo-pve81`, a Cloudflare Tunnel, and map
storage in a repository. The OAuth callback here is a drop-in equivalent of
`worker/oauth-worker.js`; live collaboration (`#shared=`, Durable Objects) is
not included, and the client is told so via `collab:false` in `/config.js`.

## Security notes

- The OAuth client secret is only in `/etc/mindspark/env` (root:mindspark, 0640)
  and in the process environment. It is never sent to the browser.
- The GitHub access token lives in the browser's `localStorage`, scoped to the
  OAuth App's `repo` grant. Signing out clears it. Do not sign in on a shared
  machine.
- The server binds loopback by default; expose it only through the tunnel.
- CSP is enforced on every response. `EXTRA_CONNECT_SRC` is the sanctioned way
  to allow another LLM origin.
