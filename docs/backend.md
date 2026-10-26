# Provider connection and service API

Maxwell's auxiliary service addresses OpenCode V2 sessions through an explicitly
configured OpenChamber origin. Session creation/discovery uses the host SDK;
history, events, dispatch, and stop use this adapter. See
[integration](integration.md) for installation and process lifecycle.

## Configure host access

Obtain a dedicated revocable client token through an **authorized operator**
connection, using an authenticated UI session or a client whose stored kind is
`desktop-local`:

```http
POST /api/client-auth/clients
Content-Type: application/json

{"label":"Maxwell"}
```

HTTP 201 returns `{client,token}`. The secret field is `token`, not `clientToken`;
the host stores its hash and returns the raw secret at creation. Save the secret
directly to private configuration. Never print it, paste it into chat, or put it
in logs/source. Do not copy the desktop's private token or request `desktop-local`
for Maxwell. Omit `clientKind` and `dedupeKey` for an ordinary dedicated client.
Ordinary client bearers cannot mint clients (403); short-lived URL auth cannot
authorize creation. `DELETE /api/client-auth/clients/{id}` returns
`{revoked,client?}`; ordinary clients may revoke only themselves.

This token authorizes broad host API access. Maxwell's selected-session filter
does not narrow that authority. Removing a UI password does not necessarily
disable client authentication.

In the Page connection settings, supply the host origin and token. The service's
`POST /connection` takes `{endpoint,token?}` and persists it; `GET /connection`
probes `/api/info`. Both return configured/connected/status fields, the endpoint
when configured, and explicit errors, never the token. POST replaces the
configuration, so omitting the token does not preserve an old one. Endpoints must
be origins without paths, query strings, or embedded credentials. Plain HTTP is
allowed only on loopback; redirects are refused. Desktop ports can change after
restart: update the configured origin. A known origin's non-secret `/health`
can identify the host; it does not establish authenticated API access.

## Writable private state

Default state is `.local/connection.json` relative to the installed extension
root. Its adjacent files are `connection.json.dispatch.json`,
`connection.json.router.json`, and `connection.json.guidance.json`. `.local/` is
Git-ignored. New private files use mode 0600
and directories 0700. The directory must be writable. A controlled launcher can
set `MAXWELL_CONNECTION_FILE` to a writable external location for read-only
installs; keep that directory out of source control too. The ordinary host
launcher restricts inherited environment variables.

## History and live updates

All routes below use authenticated `host.serviceRequest` transport. A selection
is `{sessions:[{id,directory,projectId?}]}`, at most 24 sessions. `projectId` is
ignored by this adapter; ID plus directory identifies the selected session.

`POST /messages` returns `{messages,statuses}` from
`GET /api/session/{id}/message?limit=100&order=desc&directory=...`.
Messages have `{id,sessionId,directory,role,text,createdAt}`; timestamps are epoch
milliseconds. Only user/assistant text is projected, not reasoning, tools, system
events, or attachments. Output is chronological. Each status has session identity,
`status:'ok'|'error'`, and `truncated` or `error`. An error is not empty history.
`after` is accepted but ignored: these are mutable bounded snapshots, not append
pages. Full-history pagination and deletion/revert tombstones are not implemented.

`POST /updates` accepts the same selection plus optional `cursor`. It returns:

```ts
{
  cursor: string | null,
  changed: boolean,
  mode: 'events' | 'polling',
  streamStatus: string,
  messages: Message[],
  statuses: SessionStatus[],
  reset?: boolean
}
```

Run one sequential update loop per Page, independent of draft routing. Omit the
cursor initially and on selection/connection changes. Cursors are opaque,
selection-specific in-memory tokens, not provider event IDs or permissions.
Unknown/stale cursors obtain a current snapshot. On `changed:true`, upsert by
`(sessionId,directory,id)` and replace mutable text. Discard responses for an old
selection revision. On `changed:false`, empty arrays mean no update, not clear.

The service shares a lazy authenticated `GET /api/event` SSE feed. Native
`session.step.started` establishes assistant ID/time; `session.text.started`,
`.delta`, and `.ended` build ordinal-ordered text blocks. `.ended` supplies
complete block text. `session.step.ended` permits reconciliation with committed
history. Thus partial text appears even while history contains an empty assistant
shell. Stale history cannot erase known live text. Content requires an exact
selected directory; location-less activity only invalidates selected histories.
Unselected event contents and reasoning/tool text are not cached or displayed.

Updates coalesce for 150 ms. Durable activity refreshes dirty histories; healthy
idle feeds do not poll history. Unchanged long polls finish within 12 seconds;
initial snapshot reads have a five-second timeout. Snapshots contain at most 100
recent committed messages per session plus known overlays. Events are volatile:
reconnect refreshes history, preserves known prefixes, and never concatenates a
delta across an unseen gap. A watch joining mid-step waits for repair rather than
inventing missing text. There is no replay guarantee.

Unavailable streaming returns `mode:'polling'`, `changed:false`, empty arrays,
and an explicit stream status. Label this as polling, fetch `/messages` at a
modest interval, and retry `/updates` with backoff. Configuration changes wake
polls with `reset:true`, `cursor:null`, and `streamStatus:'configuration-changed'`:
discard old-backend display context. Empty selections return `idle` without a feed.

Limits are 16 watches, four active requests per watch, 2 MiB cached JSON per
watch, 1 MiB SSE frames, 100 live assistant messages per watch, and 256 text blocks
per message. Oversized snapshots report errors; live overflow enters explicit
polling fallback. Watches expire after 30 idle seconds; no watches means no feed.
Reconnect backoff is 1–30 seconds. Shutdown and disconnected clients release waits
and timers. Stop and dispatch do not wait behind long polls. HTTP bodies are
limited to 256 KiB. Event/message contents and credentials are not logged.

## Dispatch and interruption

`POST /dispatch` takes `{requestId,sessionId,directory,text}`. Request IDs use
1–160 letters, digits, underscores, or hyphens. The adapter verifies the addressed
session, then posts only `{text}` to `/api/session/{id}/prompt?directory=...`.
It returns `{requestId,sessionId,directory,status,inboxId?,error?}` with
`status:'accepted'|'uncertain'`. Accepted means queued, not model completion.

The serialized ledger persists a fingerprint and pending outcome before attempted
delivery, without prompt text. Reusing an ID with the same payload/endpoint returns
the recorded outcome; a different payload/endpoint returns 409. Pending entries
become uncertain after restart. Lost responses and upstream errors after attempted
send are not proof of rejection: inspect the original session before deciding to
use a new request ID. Never automatically resend uncertain delivery. Retention is
unbounded; deleting ledger entries removes duplicate protection. This is not an
upstream transactional exactly-once guarantee.

`POST /stop` takes `{sessionId,directory}`, verifies the exact destination, and
calls `/api/session/{id}/interrupt` without a body. It returns `stopped`, `idle`,
or `stop-requested` (204 acknowledgement). It neither retracts input nor undoes
tool effects. Errors remain explicit, with no retry or active-chat fallback.
See [dispatch intent](dispatch-intent.md) for Page send-time checks.

## Guidance

`GET /guidance` returns `{revision,text}`, initially `{revision:0,text:""}`.
`PUT /guidance` (also POST) accepts exactly that shape, compares the saved revision,
and returns the document with revision incremented. Text can be empty and is
limited to 16,000 JavaScript characters. HTTP 409 means a conflict or writer lock:
retain unsaved editor text, reload, and reconcile rather than silently overwriting
or retrying against a newer revision.

Writes use an exclusive adjacent `.lock`, a synced private temporary file, and
atomic rename. A crash-left lock fails closed. To recover, stop all service
instances that could write this guidance file, verify no writer remains, then
remove **only that guidance file's adjacent `.lock`** and restart. Do not delete
the guidance document or dispatch ledger. Corrupt guidance fails closed without
logging its contents.

Saving invalidates service context caches. The Page also invalidates recommendation,
settling, and explanation state. Inference returns `guidanceRevision`; a change
during inference yields 409. Guidance is privileged Maxwell state, never provider
history, SDK notes, dispatch text, or ledger content. See
[guidance inference and proposals](tinfoil.md#guidance-and-management).
