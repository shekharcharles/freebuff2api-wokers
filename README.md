# freebuff2api-wokers

> Welcome! Issues and pull requests are appreciated.
>
> License: **AGPL-3.0**

Expose the free models available through **Freebuff / Codebuff** as an **OpenAI-compatible API**.

The project is designed to run as a lightweight gateway that can be used with OpenAI-compatible SDKs and clients. Docker or a self-hosted VPS is recommended.

> ⚠️ **Deployment warning**
>
> Freebuff can detect Cloudflare Worker deployments through edge-specific request markers such as `cf-worker` and `cf-ray`. Deploying through Cloudflare can increase the risk of an account being restricted. For that reason, **Docker/VPS deployment is recommended instead of Cloudflare Workers**.

## Features

- OpenAI-compatible `/v1/chat/completions`
- OpenAI Responses-compatible `/v1/responses`
- Model listing through `/v1/models`
- Preliminary Anthropic Messages compatibility through `/v1/messages`
- Multiple Freebuff accounts with automatic account rotation
- Per-account SOCKS5 proxy support
- Active-session reuse to reduce unnecessary Freebucks consumption
- Automatic cooldown and account failover when quota is exhausted
- Dynamic model discovery from the upstream Freebuff source
- Web administration panel at `/admin`
- Freebucks balance / quota visibility
- Docker and Vercel support

## Important quota behavior

Freebuff uses a **Freebucks wallet**. Creating a new model session can consume Freebucks. Continuing to use an already active session generally avoids paying the session creation cost again.

This gateway therefore tries to reuse an active session for the requested model before opening a new one.

Actual limits, model availability and prices are controlled by Freebuff and may change at any time. Check the administration panel or upstream service for current values.

## Docker deployment

### 1. Clone your repository

```bash
git clone https://github.com/shekharcharles/freebuff2api-wokers.git
cd freebuff2api-wokers
```

### 2. Configure environment variables

At minimum, configure your client-facing API key:

```bash
export FREEBUFF_API_KEY="change-this-api-key"
```

Freebuff accounts should normally be added from the web administration panel instead of being hard-coded into environment variables.

### 3. Start with Docker Compose

```bash
docker compose up -d --build
```

The examples in this repository expose the service on host port **8877**.

Open:

```text
http://YOUR_SERVER_IP:8877/admin
```

The container itself listens on port **8787** by default. With a mapping such as `8877:8787`, clients connect to **8877** on the host.

## Administration panel

Open:

```text
http://YOUR_SERVER_IP:8877/admin
```

Default first-login password:

```text
admin
```

You will be required to change the initial password after logging in.

The panel can manage:

- Freebuff account tokens
- account enable/disable state
- a separate SOCKS5 outbound proxy per account
- API key used by your clients
- upstream Codebuff API override
- quota information
- account connectivity tests
- service health

Panel data is stored in:

```text
credentials/admin.json
```

Keep this file private. It can contain authentication tokens and other sensitive configuration.

## Add Freebuff accounts

Accounts can be added from the **Account Pool** section in `/admin`.

For each account you can configure:

- a display name
- Freebuff authentication token
- optional SOCKS5 proxy
- enabled/disabled state

The gateway automatically chooses usable accounts and can move to another account when an account is unavailable or reaches quota limits.

## Helper tool

The repository includes:

```text
freebuff_tools/extract_freebuff.py
```

It can assist with Freebuff login/token extraction and basic account checks.

Examples:

```bash
cd freebuff_tools

python3 extract_freebuff.py login
python3 extract_freebuff.py show
python3 extract_freebuff.py session
python3 extract_freebuff.py quota
python3 extract_freebuff.py chat "Hello"
python3 extract_freebuff.py export
```

Telegram delivery is optional and can be configured through:

```text
TG_BOT_TOKEN
TG_CHAT_ID
```

Never commit extracted authentication tokens to Git.

## API usage

### Base URL

```text
http://YOUR_SERVER_IP:8877/v1
```

### List models

```bash
curl http://YOUR_SERVER_IP:8877/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Chat Completions

```bash
curl http://YOUR_SERVER_IP:8877/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mimo/mimo-v2.5",
    "messages": [
      {"role": "user", "content": "Hello"}
    ],
    "stream": false
  }'
```

### Responses API

```bash
curl http://YOUR_SERVER_IP:8877/v1/responses \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mimo/mimo-v2.5",
    "input": "Hello"
  }'
```

### Anthropic Messages API

The project contains preliminary compatibility with Anthropic-style requests.

```bash
curl http://YOUR_SERVER_IP:8877/v1/messages \
  -H "x-api-key: YOUR_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mimo/mimo-v2.5",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Hello"}
    ]
  }'
```

Anthropic compatibility should be tested with your intended client before depending on it for production agent workflows.

## Environment variables

Common variables include:

| Variable | Purpose |
|---|---|
| `FREEBUFF_API_KEY` | API key required from OpenAI-compatible clients |
| `FREEBUFF_DEBUG` | Enables additional debugging when set to `true` |
| `CODEBUFF_API` | Optional upstream API override; blank uses the official upstream |
| `RELAY_KEY` | Optional relay credential when using a custom upstream relay |
| `PORT` | Internal Node.js listen port; default is `8787` |
| `FREEBUFF_TOKEN` | Legacy/bootstrap token input; the admin panel account pool is preferred |

## SOCKS5 routing

Each Freebuff account can use a different SOCKS5 proxy.

Example:

```text
socks5://username:password@host:port
```

Leave the value empty for a direct connection.

This can be useful when separate accounts need independent outbound routes.

## Model list

See [MODELS.md](MODELS.md) for the generated model snapshot.

The model-generation workflow periodically reads the official Freebuff source and refreshes the snapshot. A model appearing in the snapshot does not guarantee that a particular account currently has enough Freebucks or permission to use it.

## Updating the container

```bash
git pull
docker compose up -d --build
```

## Security notes

- Do not commit Freebuff tokens.
- Do not expose `credentials/admin.json`.
- Change the initial `admin` password immediately.
- Use HTTPS through a trusted reverse proxy when exposing the service over the internet.
- Use a strong client-facing `FREEBUFF_API_KEY`.
- Restrict access to the admin panel where possible.
- Treat all account tokens as secrets.

## License

This project is distributed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**.

The repository retains upstream copyright and attribution notices contained in the LICENSE file.

## Disclaimer

This project is an unofficial compatibility gateway and is not an official Freebuff, Codebuff, OpenAI, Anthropic or model-provider product.

Upstream APIs, model availability, quotas, pricing and account policies can change without notice. Use the project in accordance with the applicable service terms and local requirements.
