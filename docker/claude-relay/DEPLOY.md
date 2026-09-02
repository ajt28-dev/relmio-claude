# Deploying Claude Relay beside n8n (manual, Phase 4)

Claude Relay runs as a **private Docker sidecar** on the same Docker network as
your n8n container. n8n reaches it over Docker DNS at
`http://n8n-claude-relay:10532/v1`. Nothing is published to the VPS host, no
reverse proxy or domain is involved, and your n8n container is never modified,
restarted, or recreated.

Two different secrets are involved. Keep them straight:

| Secret | Who uses it | Where it goes |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | the relay container only, to reach Claude | `.env` on the VPS, never n8n |
| `CLAUDE_RELAY_API_KEY` | n8n, to authenticate to the relay | `.env` on the VPS **and** n8n's OpenAI credential "API Key" |

## 1. SSH into the VPS

```bash
ssh root@<your-vps-ip>
```

## 2. Identify the n8n container and its Docker network

```bash
docker ps
```

Pick the n8n container you want to connect (if you run two instances, choose
one for this first test). Then list its networks:

```bash
docker inspect <n8n-container-name> --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}'
```

(Full detail if needed: `docker inspect <n8n-container-name> --format '{{json .NetworkSettings.Networks}}'`.)

Write down the exact network name. That value becomes `N8N_DOCKER_NETWORK`.

## 3. Put the project on the VPS

```bash
mkdir -p /opt/claude-relay
```

Either clone it (if the repository is reachable from the VPS):

```bash
git clone <your-repository-url> /opt/claude-relay
```

or copy it securely from your computer (run this **on your computer**, not the
VPS; excludes local dependencies and secrets):

```bash
rsync -av --exclude node_modules --exclude .git --exclude '.env' --exclude '.env.*' ./ root@<your-vps-ip>:/opt/claude-relay/
```

## 4. Create the environment file

The Compose project lives in `/opt/claude-relay/docker/claude-relay`, so the
`.env` file goes there:

```bash
cd /opt/claude-relay/docker/claude-relay
cp .env.example .env
```

Generate the relay key **on the VPS**:

```bash
openssl rand -hex 32
```

Generate the Claude token **on a trusted computer** where Claude Code is
installed and signed in to your subscription:

```bash
claude setup-token
```

Edit `.env` (for example `nano .env`) and set:

```text
CLAUDE_CODE_OAUTH_TOKEN=<output of claude setup-token>
CLAUDE_RELAY_API_KEY=<output of openssl rand -hex 32>
N8N_DOCKER_NETWORK=<network name from step 2>
```

Then lock it down:

```bash
chmod 600 .env
```

## 5. Build and start ONLY the relay

```bash
cd /opt/claude-relay/docker/claude-relay
cp compose.example.yml compose.yml
docker compose build
docker compose up -d
```

The build runs an in-image check that the Linux Claude runtime is present and
executable as the non-root user; a missing runtime fails the build rather than
starting a broken container. n8n is not restarted by any of these commands.

## 6. Check the container

```bash
docker ps --filter name=n8n-claude-relay
docker logs n8n-claude-relay
docker inspect n8n-claude-relay --format '{{.State.Health.Status}}'
```

Logs should show `Listening on http://0.0.0.0:10532`, `Relay auth: enabled`,
and `Claude auth mode: subscription_oauth`. Health becomes `healthy` within
about 30 seconds. Logs never contain the token or relay key.

## 7. CRITICAL: confirm no host port is published

```bash
docker inspect n8n-claude-relay --format '{{json .HostConfig.PortBindings}}'
```

Safe output is `null` or `{}`. Programmatic fail-safe:

```bash
if docker inspect n8n-claude-relay --format '{{json .HostConfig.PortBindings}}' | grep -q HostPort; then
  echo "PORT PUBLISHED - stopping the relay"; docker compose down
else
  echo "OK: no host port binding"
fi
```

In `docker ps`, the PORTS column must show only `10532/tcp`. That means
"container port, private to Docker". It must **not** show
`0.0.0.0:10532->10532/tcp` or `:::10532->10532/tcp` - those mean the port is
reachable from the internet. If you ever see an arrow form, run
`docker compose down` in this directory immediately (this removes only the
relay; n8n is untouched).

## 8. Confirm the relay joined the n8n network

```bash
docker inspect n8n-claude-relay --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}'
```

It must print exactly the network from step 2.

## 9. Test over the private Docker network

Use a disposable client container on the same network (nothing is installed
into n8n). Replace `<network>` and `<relay-key>`:

```bash
docker run --rm --network <network> curlimages/curl:8.10.1 -s http://n8n-claude-relay:10532/health
```

Expected: `{"status":"ok","provider":"claude","auth_mode":"subscription_oauth",...}`.

```bash
docker run --rm --network <network> curlimages/curl:8.10.1 -s \
  -H "Authorization: Bearer <relay-key>" http://n8n-claude-relay:10532/v1/models
```

Expected: a list containing `claude-relay-default`.

```bash
docker run --rm --network <network> curlimages/curl:8.10.1 -s \
  -H "Authorization: Bearer <relay-key>" -H "Content-Type: application/json" \
  -d '{"model":"claude-relay-default","messages":[{"role":"user","content":"Reply exactly with CLAUDE DOCKER RELAY WORKS"}]}' \
  http://n8n-claude-relay:10532/v1/chat/completions
```

Expected: HTTP 200 with `choices[0].message.content` containing
`CLAUDE DOCKER RELAY WORKS`. This proves Linux container -> Agent SDK Linux
runtime -> subscription OAuth -> Claude. The first call can take 30-60 s.

## 10. Configure n8n

In n8n: **Credentials -> Add -> OpenAI**

- API Key: your `CLAUDE_RELAY_API_KEY` (never the Claude token)
- Base URL: `http://n8n-claude-relay:10532/v1`

Save; n8n validates the credential by calling `/v1/models`.

Workflow: **AI Agent** with Chat Model **OpenAI Chat Model** using that
credential, Model `claude-relay-default` (type it if not listed). If the node
shows **Use Responses API**, turn it **OFF**. Disable streaming if the option
exists. Attach the **Calculator** tool.

Prompt: `What is 1847 multiplied by 392? Use the calculator.`
Expected final answer: **724024**, after one Calculator round-trip.

## Debugging an n8n failure

Set `CLAUDE_RELAY_DEBUG=1` in `.env`, then restart only the relay:

```bash
docker compose up -d
```

`docker logs n8n-claude-relay` then shows one `request.shape` line per request
(roles, tool names, tool_choice, flags - never content or credentials). Set it
back to `0` afterwards.

## Rollback (removes only Claude Relay)

```bash
cd /opt/claude-relay/docker/claude-relay
docker compose down
```

Add `-v` to also delete the relay's own config volume. This never removes
n8n, Traefik, the shared n8n network, or any other container or volume: the
network is declared `external`, so Compose will not delete it.
