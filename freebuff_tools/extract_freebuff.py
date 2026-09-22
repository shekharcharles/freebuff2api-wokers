#!/usr/bin/env python3
"""Freebuff authentication and account utility."""
import argparse
import base64
import json
import os
import secrets
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

BASE_URL = "https://www.codebuff.com"
CRED_FILE = Path(__file__).resolve().parent / "freebuff_credentials.json"
POLL_INTERVAL = 5
POLL_TIMEOUT = 5 * 60
REQUEST_TIMEOUT = 30

MODEL_DEFAULT = "deepseek/deepseek-v4-flash"


# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------

def in_ci():
    return os.environ.get("GITHUB_ACTIONS") == "true"


def tg_configured():
    return bool(os.environ.get("TG_BOT_TOKEN") and os.environ.get("TG_CHAT_ID"))


def send_tg(text):
    """Freebuff authentication and account utility."""
    token = os.environ.get("TG_BOT_TOKEN")
    chat = os.environ.get("TG_CHAT_ID")
    if not token or not chat:
        return False
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    body = json.dumps({"chat_id": chat, "text": text}).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode() or "{}")
            if not data.get("ok", True):
                print(f"   ⚠️ Telegram API error: {data.get('description', data)}")
                return False
            return True
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read().decode() or "{}")
            desc = err.get("description", str(e))
        except Exception:
            desc = str(e)
        print(f"   ⚠️ Telegram send failed: {desc}")
        return False
    except Exception as e:
        print(f"   ⚠️ Telegram send failed: {e}")
        return False


def mask_value(value):
    """Freebuff authentication and account utility."""
    if in_ci() and value:
        print(f"::add-mask::{value}")


# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------

def _http(method: str, path: str, body=None, headers=None, query=None, timeout=REQUEST_TIMEOUT):
    url = BASE_URL + path
    if query:
        url += "?" + urllib.parse.urlencode(query)
    data = None
    hdrs = {
        "User-Agent": "ai-sdk/openai-compatible/1.0.25/codebuff",
        "Accept": "application/json",
    }
    if body is not None:
        data = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, json.loads(raw) if raw else None, resp.headers
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            parsed = json.loads(raw) if raw else None
        except Exception:
            parsed = raw.decode(errors="replace")[:500]
        return e.code, parsed, e.headers
    except Exception as e:
        return None, {"error": str(e)}, None


def get_token():
    tok = os.environ.get("FREEBUFF_TOKEN")
    if tok:
        return tok
    if CRED_FILE.exists():
        cred = json.loads(CRED_FILE.read_text())

        tok = cred.get("authToken")
        if not tok:
            tok = cred.get("default", {}).get("authToken")
        if not tok:

            accts = cred.get("accounts") or {}
            for u in accts.values():
                tok = u.get("authToken")
                if tok:
                    break
        return tok
    return None


def _account_key(user: dict) -> str:
    """Freebuff authentication and account utility."""
    uid = user.get("id") or ""
    email = user.get("email") or ""
    if uid:
        return str(uid)
    if email:
        return str(email)
    tok = user.get("authToken") or ""
    return f"token-{tok[:12]}" if tok else "unknown"


def save_credentials(user: dict, append: bool = True):
    """Freebuff authentication and account utility."""
    existing = {}
    if CRED_FILE.exists():
        try:
            existing = json.loads(CRED_FILE.read_text())
        except Exception:
            pass
    if append:

        accts = existing.get("accounts")
        if not isinstance(accts, dict):
            accts = {}

            if isinstance(existing.get("default"), dict):
                accts[_account_key(existing["default"])] = existing["default"]
            existing = {"accounts": accts}
        key = _account_key(user)
        accts[key] = user
        existing["accounts"] = accts
    else:

        existing["default"] = user
    CRED_FILE.write_text(json.dumps(existing, indent=2, ensure_ascii=False))
    accts = existing.get("accounts")
    acct_count = len(accts) if isinstance(accts, dict) else (1 if existing.get("default") else 0)
    print(f"💾 Credentials saved → {CRED_FILE}（current {acct_count} accounts）")


# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------

def gen_fingerprint():
    """Freebuff authentication and account utility."""
    rand = base64.urlsafe_b64encode(secrets.token_bytes(6)).decode().rstrip("=")[:8]
    return f"codebuff-cli-{rand}"


def cmd_tgsend(args):
    """Freebuff authentication and account utility."""
    if not tg_configured():
        print("❌ TG_BOT_TOKEN / TG_CHAT_ID is not configured")
        sys.exit(1)
    ok = send_tg("✅ Telegram connectivity test succeeded!\nThe Freebuff extraction workflow can send you messages normally.")
    if ok:
        print("✅ Test message sent to Telegram.")
    else:
        print("❌ Telegram send failed; check TG_BOT_TOKEN / TG_CHAT_ID.")
        sys.exit(1)


def cmd_login(args):

    if in_ci() and not tg_configured():
        print("::error::GitHub Actions requires Telegram mode; configure TG_BOT_TOKEN and TG_CHAT_ID first")
        sys.exit(1)
    use_tg = tg_configured()

    fingerprint_id = args.fingerprint or gen_fingerprint()
    print(f"🚀 Starting Freebuff login flow（fingerprintId: {fingerprint_id}）...\n")

    status, data, _ = _http("POST", "/api/auth/cli/code", {"fingerprintId": fingerprint_id})
    if status != 200 or not data:
        msg = f"❌ Failed to request login URL: HTTP {status} {data}"
        print(msg)
        if use_tg:
            send_tg("⚠️ Freebuff extraction failed：\n" + msg)
        sys.exit(1)

    login_url = data["loginUrl"]
    fingerprint_hash = data["fingerprintHash"]
    expires_at = data["expiresAt"]

    mask_value(login_url)


    poll_timeout = POLL_TIMEOUT
    env_timeout = os.environ.get("OAUTH_POLL_TIMEOUT")
    if env_timeout:
        try:
            poll_timeout = int(env_timeout)
        except ValueError:
            pass


    if use_tg:
        tg_msg = (
            "🔑 *Freebuff authorization request*\n\n"
            "Open the following link in a browser and complete sign-in：\n"
            f"{login_url}\n\n"
            f"The script will poll automatically for up to {poll_timeout} seconds。"
        )
        ok = send_tg(tg_msg)
        if not ok:
            print("❌ Failed to send authorization link to Telegram (check TG_BOT_TOKEN / TG_CHAT_ID)")
            sys.exit(1)
        print("📨 Authorization link sent to Telegram (URL is not printed in logs).")
    else:

        print("=" * 60)
        print("1️⃣  Open the following link in your browser：")
        print(f"    {login_url}")
        print("2️⃣  Sign in with your Google account and authorize")
        print(f"3️⃣  The script polls automatically for up to {poll_timeout} seconds")
        print("=" * 60)

    print(f"\n🔄 Waiting for authorization (automatic polling for up to {poll_timeout} seconds）...")
    start = time.time()
    attempts = 0
    while time.time() - start < poll_timeout:
        attempts += 1
        status, data, _ = _http(
            "GET", "/api/auth/cli/status",
            query={
                "fingerprintId": fingerprint_id,
                "fingerprintHash": fingerprint_hash,
                "expiresAt": expires_at,
            },
        )
        if status == 200 and data and data.get("user"):
            user = data["user"]
            if not user.get("authToken"):
                print(f"⚠️ User returned without authToken: {json.dumps(user)[:300]}")
                sys.exit(1)
            print(f"✅ Login successful!（attempt  {attempts}  polling attempt，{int(time.time()-start)}s）")

            email = user.get("email", "unknown")

            mask_value(email)
            mask_value(str(user.get("id", "")))
            print(f"✅ Login successful! Account: {email}")


            save_credentials(user, append=not in_ci())


            auth_token = user["authToken"]
            if use_tg:
                mask_value(auth_token)
                ok = send_tg(
                    "🔑 *Freebuff authToken obtained*\n\n"
                    f"Account: `{email}`\n"
                    f"id：`{user.get('id')}`\n"
                    f"credits：`{user.get('credits')}`\n\n"
                    "Put the following line into the Cloudflare Worker secret `FREEBUFF_TOKEN`"
                    " (for multiple accounts, add one per line):\n"
                    f"`{auth_token}`"
                )
                if not ok:
                    print("❌ Failed to send authToken to Telegram. The token was not printed to logs; check Telegram configuration and retry.")
                    sys.exit(1)
                print("🔑 authToken was sent privately through Telegram (not written to logs).")
            else:
                mask_value(auth_token)
                print("\n🔑 Put the following line into the Cloudflare Worker secret FREEBUFF_TOKEN:")
                print("    " + auth_token)
            return user
        elif status == 401:
            print(f"   [{int(time.time()-start)}s] Not signed in yet (401); continuing to wait…")
        elif status == 400:
            print(f"❌ Login request expired: {data}")
            sys.exit(1)
        else:
            print(f"   [{int(time.time()-start)}s] Status {status}: {str(data)[:120]}")
        time.sleep(POLL_INTERVAL)

    print("⏰ Login timed out; retry.")
    sys.exit(1)


def cmd_show(_args):
    """Freebuff authentication and account utility."""
    pairs = _all_tokens()
    if not pairs:
        print("❌ No authToken found (run login first or set FREEBUFF_TOKEN)")
        sys.exit(1)
    print(f"📋 Saved credentials（{len(pairs)} accounts）:")
    print("-" * 60)
    for _key, at, email in pairs:
        verdict, detail = _check_one(at)
        print(f"  [{email}] {verdict}")
        print(f"      {at}")
        print(f"      {detail}")
    print("-" * 60)
    print("\n📋 Summary (one per line; copy into the CF Worker FREEBUFF_TOKEN variable):")
    for _key, at, _email in pairs:
        print(f"   {at}")
    return 0


def cmd_session(args):
    tok = get_token()
    if not tok:
        print("❌ No authToken found")
        sys.exit(1)
    headers = {"Authorization": f"Bearer {tok}"}
    model = args.model or MODEL_DEFAULT
    if args.post:
        headers["x-freebuff-model"] = model
        status, data, _ = _http("POST", "/api/v1/freebuff/session", headers=headers)
    else:
        status, data, _ = _http("GET", "/api/v1/freebuff/session", headers=headers)
    print(f"📡 HTTP {status}")
    print(json.dumps(data, indent=2, ensure_ascii=False) if data else "(Empty response)")
    return data




CANONICAL_BUFFY = "You are Buffy, the strategic coding assistant."


MODEL_AGENTS = {
    "deepseek/deepseek-v4-flash": "base2-free-deepseek-flash",
    "deepseek/deepseek-v4-pro": "base2-free-deepseek",
    "moonshotai/kimi-k2.6": "base2-free-kimi",
    "minimax/minimax-m2.7": "base2-free",
    "minimax/minimax-m3": "base2-free-minimax-m3",
    "mimo/mimo-v2.5": "base2-free-mimo",
    "mimo/mimo-v2.5-pro": "base2-free-mimo-pro",
}


def agent_for_model(model):
    return MODEL_AGENTS.get(model, "base2-free-deepseek-flash")


def cmd_chat(args):
    tok = get_token()
    if not tok:
        print("❌ No authToken found")
        sys.exit(1)


    model = args.model or MODEL_DEFAULT

    sdk_ua = "ai-sdk/openai-compatible/1.0.25/codebuff"
    headers = {"Authorization": f"Bearer {tok}", "User-Agent": sdk_ua}
    status, sess, _ = _http("POST", "/api/v1/freebuff/session",
                            headers={**headers, "x-freebuff-model": model})
    print(f"📡 POST /session → HTTP {status}")
    instance_id = None
    if isinstance(sess, dict) and sess.get("status") == "active":
        instance_id = sess.get("instanceId")
        print(f"   ✅ session active, instanceId={instance_id}, "
              f"model={sess.get('model')}, expires_at={sess.get('expires_at')}")
    else:
        print(f"   ⚠️ {str(sess)[:300]}")
        if not args.force:
            print("   （Using --force; sending chat directly to inspect the error）")
            sys.exit(1)


    run_id = args.run_id
    agent_id = args.agent or agent_for_model(model)
    if not run_id:
        s, sr, _ = _http("POST", "/api/v1/agent-runs",
                         {"action": "START", "agentId": agent_id,
                          "ancestorRunIds": []}, headers)
        if isinstance(sr, dict) and sr.get("runId"):
            run_id = sr["runId"]
            print(f"   📡 START run → HTTP {s} runId={run_id} (agent={agent_id})")
        else:
            print(f"   ⚠️ START run failed HTTP {s}: {str(sr)[:200]}")
            if not args.force:
                sys.exit(1)


    chat_headers = {
        "Authorization": f"Bearer {tok}",
        "Content-Type": "application/json",
        "User-Agent": sdk_ua,
    }
    if instance_id:
        chat_headers["x-freebuff-instance-id"] = instance_id

    uid = None
    if CRED_FILE.exists():
        try:
            uid = json.loads(CRED_FILE.read_text()).get("default", {}).get("id")
        except Exception:
            pass
    if uid:
        chat_headers["x-freebuff-acting-user-id"] = uid

    body = {
        "model": model,
        "messages": [
            {"role": "system",
             "content": CANONICAL_BUFFY + "\n\nYou are the AI agent behind Freebuff. Keep it brief."},
            {"role": "user", "content": args.message or "Say hi in one short sentence."},
        ],
        "stream": False,
        "max_tokens": 200,
        "codebuff_metadata": {
            "run_id": run_id or f"run-{secrets.token_hex(6)}",
            "client_id": f"cli-{secrets.token_hex(6)}",
            "cost_mode": "free",
            **({"freebuff_instance_id": instance_id} if instance_id else {}),
        },
        "provider": {"data_collection": "deny"},
    }
    print(f"📡 POST /api/v1/chat/completions (model={model}, stream=False, run_id={run_id})…")
    status, data, _ = _http("POST", "/api/v1/chat/completions", body, chat_headers)
    print(f"→ HTTP {status}")
    if status == 200 and isinstance(data, dict):
        msg = data.get("choices", [{}])[0].get("message", {})
        print(f"✅ Reply: {msg.get('content', '')[:500]}")
        if msg.get("reasoning_content"):
            print(f"🧠 reasoning: {msg['reasoning_content'][:200]}")
        print(f"   usage: {data.get('usage')}")

        _http("POST", "/api/v1/agent-runs", {"action": "FINISH", "runId": run_id}, headers)
    else:
        print(json.dumps(data, indent=2, ensure_ascii=False)[:1500] if data else "(Empty response)")

        if run_id:
            _http("POST", "/api/v1/agent-runs", {"action": "CANCEL", "runId": run_id}, headers)


def cmd_quota(_args):
    tok = get_token()
    if not tok:
        print("❌ No authToken found")
        sys.exit(1)
    status, data, _ = _http("POST", "/api/v1/usage", {"fingerprintId": "cli-usage"},
                            headers={"Authorization": f"Bearer {tok}"})
    print(f"📡 HTTP {status}")
    print(json.dumps(data, indent=2, ensure_ascii=False) if data else "(Empty response)")


def _all_tokens():
    """Freebuff authentication and account utility."""
    tok = os.environ.get("FREEBUFF_TOKEN")
    if tok:
        return [("env", tok, "Environment variable")]
    if CRED_FILE.exists():
        try:
            cred = json.loads(CRED_FILE.read_text())
        except Exception:
            cred = {}
        accts = cred.get("accounts")
        if isinstance(accts, dict) and accts:
            return [(k, u.get("authToken", ""), u.get("email", "?")) for k, u in accts.items() if u.get("authToken")]
        if isinstance(cred.get("default"), dict) and cred["default"].get("authToken"):
            return [("default", cred["default"]["authToken"], cred["default"].get("email", "?"))]
        if cred.get("authToken"):
            return [("default", cred["authToken"], cred.get("email", "?"))]
    return []


def _format_quota(rate_limits):
    """Freebuff authentication and account utility."""
    if not isinstance(rate_limits, dict) or not rate_limits:
        return "Quota unknown (upstream did not return rateLimitsByModel)"
    rows = []
    for model, info in rate_limits.items():
        if not isinstance(info, dict):
            continue
        rc = info.get("recentCount")
        lim = info.get("limit")
        if rc is None or lim is None:
            continue
        reset = info.get("resetAt") or info.get("reset_at")
        text = f"{model}={rc}/{lim}"
        if reset:
            text += f"，reset={reset}"
        rows.append(text)
    return "Quota " + "；".join(rows) if rows else "Quota unknown (snapshot fields are incomplete)"


def _check_one(tok):
    """Freebuff authentication and account utility."""
    headers = {
        "Authorization": f"Bearer {tok}",

        "x-freebuff-include-unused-rate-limits": "1",
    }
    status, data, _ = _http("GET", "/api/v1/freebuff/session", headers=headers,
                            timeout=REQUEST_TIMEOUT)
    if status is None:
        return "Network error", f"Request failed: {data.get('error') if isinstance(data, dict) else data}"
    if status == 401:
        return "Invalid token ❌", "HTTP 401（authToken is invalid or revoked; the account is not necessarily banned）"
    if status == 403:

        if isinstance(data, dict):
            st = data.get("status")
            if st == "banned":
                return "Banned ❌", "HTTP 403 + status=banned（Upstream status is Terminal; contact support@codebuff.com to appeal）"
            if st == "country_blocked":
                return "Region restricted ⚠️", "HTTP 403 + status=country_blocked (current outbound IP is not in the United States)"
        return "Access denied ⚠️", f"HTTP 403: {str(data)[:200]}"
    if status == 429:
        quota_str = _format_quota(data.get("rateLimitsByModel")) if isinstance(data, dict) else "Quota unknown (429 did not include a quota snapshot)"
        return "Quota exhausted ⚠️", f"HTTP 429（Today's session quota is exhausted; wait for reset），{quota_str}"
    if status == 404:


        quota_str = _format_quota(data.get("rateLimitsByModel")) if isinstance(data, dict) else "Quota unknown (404 did not include a quota snapshot)"
        return "Alive (no active session) ✅", f"HTTP 404（No session; account is usable），{quota_str}"
    if not isinstance(data, dict):
        return "Unknown", f"HTTP {status}: {str(data)[:200]}"
    st = data.get("status")
    if st == "banned":
        return "Banned ❌", "Upstream status is Terminal; contact support@codebuff.com to appeal"

    if st == "active":
        model = data.get("model", "?")
        tier = data.get("accessTier", "?")
        quota_str = _format_quota(data.get("rateLimitsByModel"))
        if quota_str:
            quota_str = "，" + quota_str
        return "Alive ✅", f"session active, model={model}, tier={tier}{quota_str}"
    if st in ("none", "ended"):
        quota_str = _format_quota(data.get("rateLimitsByModel"))
        if st == "ended":
            detail = "Current session ended; account remains usable"
            verdict = "Alive (session ended) ✅"
        else:
            detail = "Zero-cost probe succeeded; account is usable"
            verdict = "Alive (no active session) ✅"
        if quota_str:
            detail += f"，{quota_str}"
        return verdict, detail
    if st == "country_blocked":
        return "Region restricted ⚠️", "Current outbound IP is not in the United States (Freebuff free models are US-only)"
    if st == "model_locked":
        quota_str = _format_quota(data.get("rateLimitsByModel"))
        return "Alive (session locked) ⚠️", f"Another model session is active; it will be released automatically later，{quota_str}"
    if st == "rate_limited":
        quota_str = _format_quota(data.get("rateLimitsByModel"))
        return "Quota exhausted ⚠️", f"Today's session quota is exhausted; wait for reset，{quota_str}"
    if st == "ip_capped":
        return "Alive (IP concurrency limit reached) ⚠️", "Too many active users on the current outbound IP; retry later"
    return "Alive ✅", f"HTTP {status}, status={st}"


def cmd_export(_args):
    """Freebuff authentication and account utility."""
    pairs = _all_tokens()
    if not pairs:
        print("❌ No authToken found (run login first or set FREEBUFF_TOKEN)")
        sys.exit(1)
    print("
    print("
    print("# Warning: this output contains sensitive tokens. Do not disclose or commit them to Git.")
    print("=" * 60)
    for _key, tok, _email in pairs:
        print(tok)
    print("=" * 60)
    return 0


# ---------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(description="Freebuff authToken extraction utility")
    sub = p.add_subparsers(dest="cmd", required=True)

    p_login = sub.add_parser("login", help="Start login (generate URL and poll for token)")
    p_login.add_argument("--fingerprint", help="Specify fingerprintId (generated automatically by default)")

    sub.add_parser("tgsend", help="Test Telegram connectivity (send a test message)")

    sub.add_parser("show", help="Show saved credentials and verify them")
    p_sess = sub.add_parser("session", help="Create/check session")
    p_sess.add_argument("--model", default=MODEL_DEFAULT)
    p_sess.add_argument("--post", action="store_true", help="POST to create a session (GET by default)")

    p_chat = sub.add_parser("chat", help="Send a message to test the model API")
    p_chat.add_argument("message", nargs="?", default=None)
    p_chat.add_argument("--model", default=MODEL_DEFAULT)
    p_chat.add_argument("--agent", default=None, help="agentId for START run (automatically mapped by model by default)")
    p_chat.add_argument("--run-id", default=None, help="Specify run_id (START one by default)")
    p_chat.add_argument("--force", action="store_true", help="Send chat directly even if session/run fails")

    sub.add_parser("quota", help="Check usage")

    sub.add_parser("export", help="Export all account tokens, one per line, for the CF Workers variable")

    args = p.parse_args()
    {
        "login": cmd_login,
        "show": cmd_show,
        "session": cmd_session,
        "chat": cmd_chat,
        "quota": cmd_quota,
        "tgsend": cmd_tgsend,
        "export": cmd_export,
    }[args.cmd](args)


if __name__ == "__main__":
    main()
