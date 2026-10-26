# Working on Maxwell

Maxwell is a conversation window manager, not a universal conversational persona.
Read README.md and docs/integration.md before changing the provider boundary.

## Product invariants

- Original messages belong to provider sessions. Maxwell's merged view references
  them; it does not copy mixed scrollback into destination model prompts.
- Session identity includes provider/runtime and directory context, not just a
  human-readable title. Never dispatch by switching the host's active chat.
- An aside is fast to start and may become long-lived. It is not a history fork.
- Human selection and model recommendation are independent: clicking a destination
  or Ctrl+number selects without sending. Enter sends to an explicitly selected
  destination regardless of model disagreement. Without selection, it requires
  the current settled recommendation to match the last successful destination.
  See docs/dispatch-intent.md; stable slots never silently re-rank.
- Send-time checks use the exact draft revision. Model completion or elapsed time
  alone is not permission to dispatch. An uncertain network result is not proof
  that no message was delivered; do not automatically retry it.
- Clearly label deterministic routing and illustrative demo data. Never silently
  replace failed live operations with simulated success.
- This PoC does not enforce privacy bubbles. Model/project differences are not an
  information-flow control system. The privileged auxiliary service runs with the
  OS user's access, per the OpenChamber service contract.

## Implementation

Keep the implementation small and readable. The Page lives in panel/, the
host-managed provider service in service/. Use the SDK for host discovery and
session creation, serviceRequest for the auxiliary process, and the host theme
and UI kit for controls. Avoid a separate application framework for this PoC.

Build with `npm run build`, typecheck with `npm run check`, and run focused tests
with `npm test`. Install the built project folder by filesystem path in
OpenChamber. Generated browser/service bundles are not committed.

## Public-repository hygiene

Treat this directory as future public source. Do not commit local endpoint
credentials, conversation exports, screenshots of real user messages, personal
project inventories, or machine-specific configuration. Keep local runtime state
under ignored .local/ when needed. Document portable setup, not this user's paths.
Do not publish or choose a license without the user's direction.

Browser tests use synthetic fixtures. Live tests must create clearly named test
sessions rather than send to existing user work. Record what was actually tested,
including whether dispatch reached a real provider or only a fake backend.
