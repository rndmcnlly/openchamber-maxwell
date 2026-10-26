# Trusted inference

Maxwell pins `tinfoil@1.3.0` and uses `SecureClient({transport:'ehbp'})`.
It awaits `ready()` and requires `securityVerified:true` before transmitting
inference input. There is no raw-HTTPS inference fallback, alternate provider or
model, or automatic inference retry. Failed initialization stays failed until
router configuration resets the client or the service restarts.

| Purpose | Exact model | Endpoint |
| --- | --- | --- |
| Primary routing and recovery | `decision-large` | `/v1/decisions` |
| Explanations and management | `deepseek-v4-1-flash` | `/v1/chat/completions` |

These names are fixed in code; changing provider/model requires implementation
changes. See [verification](verification.md) for tested versions and evidence.

## Configuration

Through authenticated `host.serviceRequest`, `POST /router` with
`{"keyFile":"/absolute/path/to/inference-key"}` (or a `~/` path) references an
external file containing only a regular `tk_...` inference key. Do not use shell
assignments or an admin key, copy the key into the repository, or print it.
Only the path is saved in the adjacent router configuration described in
[backend storage](backend.md#writable-private-state).

An explicitly controlled launcher may provide `TINFOIL_API_KEY`; the ordinary
host-managed environment does not inherit it. A configured file takes precedence.
GET/POST `/router` returns `{configured,routingModel,managementModel,
transport:'attested-ehbp',verified}` without the key or its path. `configured`
means a regular credential can be read, not that quota/network access works.
`verified` reflects SDK initialization. Host connection readiness is separate.

## Input and authority

Routing, explanations, and management disclose selected metadata (IDs, titles,
directories, projects, stable slots), the latest four user/assistant messages per
selected session (500 trailing characters each, with timestamps), and the current
draft/request to trusted inference. They also receive Maxwell's private guidance
as separate privileged instruction context. Management additionally receives its
private conversation turns and authorized project list. Explanations receive
candidate/recommendation IDs and reported advice.

Selected session IDs and slots must be unique, with slots 1–24 and at most 24
sessions; `abort` and `none` are reserved IDs. Metadata is canonicalized by slot.
History failure for any selected session fails the request rather than advising
from incomplete context. Shared selected-context caching lasts one second and is
invalidated by connection changes, accepted dispatch, stop, and guidance saves.

Source history, titles, and draft are untrusted data. Guidance can advise but
cannot expand allowlists, change fixed tools/models, or veto explicit human
selection. A guidance reference to an unselected destination calls for abstention.
Selected context is a request-level disclosure boundary, not restricted token
authority or an enforced privacy bubble. No mixed context or guidance is appended
to a provider dispatch or an aside's initial message.

## Recommendations

`POST /recommend` takes `{draft,revision,sessions,lastOutgoing?}`. Drafts are at
most 10,000 characters; revision is a nonnegative safe integer. A session has
`{id,title,directory,slot,projectId?}`. `lastOutgoing` is accepted for compatibility
but **does not enter primary routing inference**; neither does human selection.
All active sessions are equal candidates.

See [routing and recovery](routing-recovery.md) for the complete response,
probability validation, ABORT second-stage decision, and error semantics. The
Decisions request uses `{model,input,questions:[{type:'choice',name,instructions,
choices:[{value},...]}]}`; it is not a chat-completions JSON prompt or OpenRouter
Decisions schema. Blank drafts/selections make no inference call.

The Page debounces about 300 ms, uses increasing draft revisions, and rejects
stale draft/source results. It independently enforces the settling hold and
[dispatch intent](dispatch-intent.md). Service revision echoes do not establish
global freshness across Page instances. Unavailability never activates unlabeled
deterministic routing.

## Route explanations

`POST /explain-route` takes `{draft,revision,sessions,lastOutgoing?,
candidateSessionId,recommendationSessionId,routingOutcome?,recovery?}`. Draft must
be nonblank and at most 10,000 characters. Candidate must be selected;
recommendation must be selected or explicitly null, not missing. An unselected
last outgoing normalizes to null. Optional outcome/recovery consistency rules
are defined in [routing recovery](routing-recovery.md#optional-explanation-context).

The response is `{revision,guidanceRevision,candidateSessionId,
recommendationSessionId,text,model,verified,latencyMs}`. Only a single completed
`stop` response from the exact explanation model with nonblank text at most 2,000
characters and no tool calls is accepted. Inference requests use no tools,
`temperature:0`, `max_tokens:512`, and `chat_template_kwargs:{thinking:false}`.

Explanations are on-demand advisory prose, requested as 1–3 evidence-grounded
sentences. Null recommendations must not invent certainty; agreement must not
invent disagreement. Explanations cannot change selection, recommend a new
primary route, dispatch, or claim privacy enforcement. Render their text safely.
Prompt constraints are not proof of model compliance.

There is no service-side explanation-result cache. Page caches are bounded and
tied to exact draft/revision, selected metadata/context generation, guidance,
candidate, recommendation, last outgoing, and reported recovery advice. Discard
stale responses and invalidate on source/activity changes, not just typing.

## Guidance and management

The [guidance API](backend.md#guidance) owns durable `{revision,text}` state.
All three inference routes return `guidanceRevision` and reject guidance changes
during inference with 409. Saving guidance never authorizes dispatch.

`POST /manage` takes `{text,sessions,projects,conversation?}`. `text` is nonblank
and at most 10,000 characters; projects are unique `{id,name}` entries, at most
100, authorized by the operator for this action. Optional conversation is an
ordered array of exact `{role:'user'|'assistant',text}` objects: at most 20 turns,
16,000 characters per turn, and 48,000 characters total. System/tool roles and
extra fields are rejected before history retrieval or inference.

Ask Maxwell retains this short private conversation until Page reload or **New
conversation**. Follow-up clarification can refer to earlier intent. Historical
assistant text, including proposal summaries, is not consent, an execution
receipt, or authority to expand current allowlists. The transcript must never be
forwarded to a provider session or copied into `initialText`.

Responses contain `{model,guidanceRevision,text,proposals,latencyMs,verified}`.
Ordinary questions can return prose and an empty list. At most four proposals
are accepted, with exact argument fields and allowlisted identities:

- `propose_start_aside`: `{projectId,title,initialText}`, title 1–200 characters,
  initial text 1–10,000 characters, both nonblank. Human review precedes the
  separate [SDK creation action](integration.md#aside-creation).
- `propose_select_session`: `{sessionId}` from selected sessions. Human acceptance
  selects a destination; it does not send.
- `propose_guidance_update`: model arguments are exactly `{text}`, the entire
  replacement document, preserving unrelated guidance. The backend attaches
  `baseRevision` from its snapshot. Review and a separate **Save guidance** action
  submit `{revision:baseRevision,text}` to `/guidance`. A proposal never saves itself.

Guidance proposals are instructed to require an explicit request to remember,
set, or change guidance; that intent interpretation is model-based, not a
deterministic classifier. Management uses function schemas, `tool_choice:'auto'`,
`temperature:0`, `max_tokens:8192`, and `chat_template_kwargs:{thinking:false}`.
Wrong models, malformed/truncated output, and unauthorized calls fail closed.
Validated proposals still require human action and are never action receipts.

## Attestation and cache limits

The SDK manages a stable random `user_cache_secret` in
`~/.tinfoil/user_cache_secret`. Maxwell neither logs it nor derives it from an API
key, and does not regenerate it per request. Documented automatic caching covers
eligible chat-completions calls, not Decisions: no decision-prefix cache hits are
claimed. Multi-user hosting would require distinct stable secrets and a genuine
user boundary, which this single-user process does not provide.

The pinned JavaScript verifier checks AMD SEV-SNP attestation, code provenance,
measurement match, and key binding. Official documentation notes it lacks Go V3
freshness, revocation, and Intel TDX checks. `verified:true` is not a freshness
bound or complete rollback-resistance guarantee.

References: [JavaScript SDK](https://docs.tinfoil.sh/sdk/javascript-sdk),
[decision outputs](https://docs.tinfoil.sh/guides/decision-outputs), and
[prompt caching](https://docs.tinfoil.sh/sdk/prompt-caching).
