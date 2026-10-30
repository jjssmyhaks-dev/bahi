# Bahi Tally bridge agent

The bridge is the only component that talks to TallyPrime. Bahi never holds Tally
credentials and never writes vouchers itself: it signs commands into a queue, the
agent on the Tally PC pulls them, imports the XML, and acknowledges the result.

```
Bahi  ──poll/ack (HTTPS, bearer token)──▶  agent  ──XML over HTTP──▶  TallyPrime
```

## What it handles

| Command | What the agent does |
| --- | --- |
| `ping` | Round-trip health check. |
| `get_company_info` | Returns the open company and GSTIN. |
| `sync_masters` | Exports ledgers and stock items, ack carries them back to Bahi. |
| `post_voucher` | Imports a voucher, finds its voucher number, acks it. |
| `post_voucher_draft` | Same, but marks the voucher **Optional** in Tally. |
| `get_voucher_status` | Looks a voucher up by its `[BAHI:<key>]` narration. |
| `cancel_voucher` | Cancels an existing voucher by number. |

Every voucher carries `[BAHI:<idempotency-key>]` in the narration. Before a
create, the agent looks the narration up in Tally; if it already exists the
command is acknowledged without creating a duplicate. That is what makes retries
safe when a request times out after Tally has already imported the voucher.

## 1. Register an agent in Bahi

Settings → **Tally bridge agent** → enter an agent name and the **exact** Tally
company name → *Create agent token*. Copy the token: Bahi stores only its SHA-256
hash and cannot show it again.

## 2. Enable Tally's HTTP gateway

In TallyPrime: **F1 → Settings → Connectivity → Client/Server configuration**,
set *TallyPrime acts as* **Both** (or Server), and note the port (9100 for
recent releases, 9000 for many older setups). The agent posts XML to
`http://<host>:<port>`.

## 3. Run the agent

Node.js 20+ is enough.

```bash
BAHI_BASE_URL=https://your-bahi-host \
BAHI_BRIDGE_TOKEN=bhai_… \
TALLY_URL=http://localhost:9000 \
node bridge/bahi-bridge.mjs
```

Optional environment:

| Variable | Purpose |
| --- | --- |
| `BAHI_COMPANY` | Pin the company instead of taking it from the token. |
| `BRIDGE_SIGNING_SECRET` | Verify the HMAC on every poll response. Set the same value as the server. |
| `POLL_INTERVAL_MS` | Poll interval, default `3000`. |

Run it under Task Scheduler or NSSM so it restarts with Windows.

## Queue behaviour

- Commands are stored in the tenant schema (`bridge_commands`) with a unique
  `(agent_id, idempotency_key)` pair, so enqueueing the same write twice is a
  no-op.
- Polling leases a command for 2 minutes. If the agent dies mid-import, the
  command is redelivered and the narration check prevents a second voucher.
- When the network drops, the agent keeps unsent acknowledgements in memory and
  retries them before its next poll.
- A failed command moves the record back to **Needs review** with the Tally
  error as the destination note.
- `post_voucher_draft` is used while the workspace is in Draft autonomy mode, so
  approved records land in Tally as optional vouchers until autonomy is raised.

## Multi-company

One agent belongs to one company. Register an agent per company and run one
process per company (different `BAHI_BRIDGE_TOKEN`). Bahi routes each record to
the agent for the company name it was queued with.

## Endpoints

| Method | Path | Auth |
| --- | --- | --- |
| `POST` | `/api/bridge/poll` | `Authorization: Bearer <token>` |
| `POST` | `/api/bridge/ack` | same |
| `POST` | `/api/bridge/heartbeat` | same |

Responses are JSON with `cache-control: no-store`. When
`BRIDGE_SIGNING_SECRET` is set, poll responses include `signed: true` and an
HMAC-SHA256 `signature` over `{ issuedAt, commands }`; the agent refuses unsigned
batches.

## Verifying it works

1. Settings shows the agent **Online** within a minute of starting it.
2. Approve a record with the Tally destination.
3. Settings → Recent commands shows the `post voucher` command move from
   `queued` to `acked`; the record shows the voucher number Tally returned.
4. Use **Reverse** on the record to queue a cancellation.

Without an agent, Bahi still builds voucher XML for manual import from the record
page; it does not claim the voucher was posted.
