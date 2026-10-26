# Dispatch intent

## Independent state

- `humanSelection`: an explicit destination assertion for this composition.
- `recommendation`: model advice tied to the exact draft revision and source set.
- `lastOutgoing`: destination of the previous successfully accepted submission.

Clicking a destination pill or pressing Ctrl+number only selects a destination;
it never sends. A selection persists as the user edits this composition. It is
cleared after successful dispatch of that composition, not after a model update.
If an older draft is sent while a new draft is being typed, completion must not
erase the new text or a newer explicit selection.
Track selection identity/version separately from text revision: completion clears
the submitted selection unless the user has made a newer selection in the interim.
Offer a small way to clear an override and return to recommendation-led behavior.

## Enter and Send

1. With an explicit human selection, send to that selected destination. Model
   disagreement, recommendation latency, or a hot/failed recommendation cannot
   veto the user's assertion. Provider errors, removed destinations, duplicate
   sends and unresolved delivery still require correct handling.
2. Without one, Enter sends only when a current, settled recommendation equals
   the previous successfully accepted destination. Otherwise ask the user to
   choose. A fresh composition begins without a human selection.

The one-second hold applies to model recommendations, not explicit human intent. The
ordinary Send button follows the same conditions as Enter. Accepting a different
recommended destination therefore takes selection followed by Send/Enter.

Repeated advice for the same destination/outcome/recovery preserves its stability
age, but editing still requires advice for the exact current draft. Neither elapsed
time nor inference completion alone authorizes sending. Existing destination slots
never silently re-rank as sources or advice change. Cold-start Enter has no previous
accepted recipient to agree with.

An in-flight send blocks duplicates. Failed or uncertain delivery retains the
draft; unresolved delivery blocks new payloads until inspected and acknowledged.
An exact-payload retry reuses the protected request ID rather than creating another
send. See [dispatch persistence](backend.md#dispatch-and-interruption).

## Advice remains visible

The ordinary composer has no persistent destination-pill bar. The send control
names the explicitly selected destination, or otherwise the last successfully
submitted recipient. A separate destination dropdown selects without sending.
Reply here sits below a conversation run and makes the same explicit selection.
Incoming messages do not silently change the implied recipient.

The discrete router evaluates all active sources independently. The last outgoing
recipient is a UI continuity heuristic, not an input preference to that decision.
Only agreement between these independently obtained destinations arms unselected
Enter. A confident ABORT is distinct from uncertainty. After ABORT a second
discrete decision can advise REVISE or REROUTE to a specific active session.
Recovery advice never supplies primary agreement or arms Enter; human selection
remains an explicit override, including after ABORT.

When settled model advice disagrees with that destination, show a contextual
explanation and the recommended active destination. The human can revise the
draft or select another destination; selecting still never sends. Agreement
needs no explanatory banner. Model uncertainty is labeled as uncertainty.

Never relabel a manual selection as the model's recommendation. Show a compact
selected-by-you state and retain visible disagreement. If the router recommends
a different recipient, alternate destination choices offer draft-specific
explanations of why they are not recommended. These are advisory, evidence-grounded
attempts to dissuade a mistaken override, not invented permission prohibitions.

Generate [freeform explanations](tinfoil.md#route-explanations) on demand, cache
within the exact draft/context, and discard stale results. Explanations must not
pretend the model has enforced a privacy boundary or performed a tool action.
See [routing recovery](routing-recovery.md) for the discrete ABORT contract.

## Maxwell-owned guidance

Human-authored routing guidance is privileged Maxwell state: it can name and
relate multiple private conversations. It is not a message in any provider
session. The trusted routing, explanation and management calls receive it as a
separate guidance document, distinct from untrusted conversation excerpts.
Dispatch never appends that document. Guidance advises rather than vetoes the
human's explicit destination selection. Updates invalidate stale model advice.
See [guidance storage and editing](backend.md#guidance) and
[inference disclosure](tinfoil.md#input-and-authority).
