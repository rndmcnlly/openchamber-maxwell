# Independent routing and recovery advice

`POST /recommend` evaluates all active (selected) sessions as equal candidates.
Its `decision-large` input contains selected metadata, bounded recent activity
(including timestamps), and the exact draft. Neither `lastOutgoing` nor
`humanSelection` enters routing inference. The former remains accepted for API
compatibility, including the exported `routingBody` argument. Recency can therefore
remain a separate UI heuristic for meaningful comparison with the model.

The primary `destination` choice allows each active session ID, `abort`, and
`none`. These last two IDs are reserved and cannot identify selected sessions.
`none` means insufficient evidence. `abort` explicitly recommends pausing the
draft as composed, under applicable guidance. It is advice, not a veto.

## Recommendation response

Responses include revision, guidanceRevision, model, nullable sessionId, reason,
latencyMs, outcome and recovery. Successful inference also includes verified,
primary confidence, margin and probabilities:

```ts
outcome: 'destination' | 'abort' | 'uncertain';
recovery: { action: 'revise' } | { action: 'reroute'; sessionId: string } | null;
```

- A confident destination has its primary `sessionId`, `reason: 'selected'`, and
  `recovery: null`.
- A confident abort has `sessionId: null`, `reason: 'abort'`, and optional recovery.
- Uncertainty has `sessionId: null`, `reason: 'ambiguous'`, and `recovery: null`.
  Empty drafts or no selected sessions use `reason: 'empty'` and make no call.

Confidence requires probability ≥ 0.7 and margin ≥ 0.2. Low-confidence abort is
uncertainty, never an explicit abort. Every probability distribution must cover
exactly its allowlist with finite probabilities in [0, 1], total within 0.02 of
one, and a winning choice consistent with the probabilities.

Only confident abort triggers a second `decision-large` call. Its `recovery`
choice allows `revise`, `reroute:<active session id>`, and `none`, using identical
draft/context and guidance. The same validation and confidence thresholds apply.
Uncertain recovery returns null. Invalid or failed inference rejects the whole
request (502), with no fallback or successful abort response. Guidance revision
checks follow both calls; a change during either rejects the request (409).

Recovery never populates primary `sessionId`, arms Enter, authorizes dispatch, or
changes selection. Clients must present it as advice to revise or review another
session. Ordinary destinations and uncertainty require only one decision call.

## Optional explanation context

`POST /explain-route` accepts optional `routingOutcome` (the same three values)
and `recovery` (the shape above, or null). Existing clients may omit both.
When present, `destination` requires non-null `recommendationSessionId`; `abort`
and `uncertain` require null. Non-null recovery requires explicit `abort` and an
exact object shape; reroute IDs must be active selected sessions. Invalid context
is rejected (400) before history retrieval or inference.

The explanation model receives these fields as reported advice, never authority
or evidence of human intent. Instructions distinguish explicit pause advice from
uncertainty, permit grounded revision/reroute suggestions, and prohibit invented
certainty, privacy guarantees, or unnecessary repetition of sensitive details.
The explanation response shape is unchanged.

See [inference setup and shared context](tinfoil.md),
[dispatch intent](dispatch-intent.md), and [verification scope](verification.md).
The ABORT/recovery contract has synthetic fixture coverage, not live quality validation.
