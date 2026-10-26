# Verification

## Reproducible checks

Use Node.js 22.18+ and installed Google Chrome:

```sh
npm ci
npm run check
npm test
npm run build
```

Browser tests default to the `chrome` channel. Set `PLAYWRIGHT_CHANNEL` to another
installed Playwright-supported channel when needed. The harness builds its browser
fixture itself. Build the runtime before installing the project folder by
filesystem path in OpenChamber.

Focused commands:

```sh
node --test test/service.test.mjs
node --test test/tinfoil.test.mjs test/guidance.test.mjs
node --test test/panel.test.mjs
```

## Automated suite scope

The retained `test/` suite uses synthetic sessions, history, credentials, and
transport responses. It does not call real inference or send to user sessions.

- Service tests cover authentication including health, redacted configuration,
  bounded mutable history, isolated fetch failures, addressed dispatch,
  duplicate/conflicting request IDs, crash uncertainty, and targeted interruption.
- Streaming tests feed native event envelopes while committed history is empty.
  They check growing partial text, ordered blocks, stale-history reconciliation,
  selected-directory isolation, reconnect gaps, polling fallback, connection reset,
  long-poll deadlines, responsive stop, and cleanup.
- Inference tests cover exact model/schema checks, selected-context bounds,
  independent primary routing, ABORT/recovery validation, failed attestation,
  explanation constraints, management allowlists, and private multi-turn input.
  Fake attested transports verify enforcement paths, not real attestation or
  semantic model obedience.
- Guidance tests cover private persistence, optimistic revisions, concurrent
  writers, inference revision conflicts, proposal validation, and separation from
  dispatch/ledger data.
- Browser fixtures cover explicit selection versus unselected continuity,
  stale/hot recommendations, ABORT overrides, duplicate/in-flight sends, retaining
  newer drafts, uncertain delivery, management review, guidance conflicts, private
  follow-ups, safe Markdown, native session links, and mutable streamed snapshots.

Passing fixtures does not establish general routing quality, privacy enforcement,
or compatibility with every host/browser version.

## Recorded live evidence

Earlier authorized integration checks used OpenChamber desktop **2.5.1**,
reporting OpenCode **2.1.3**, SDK **2.5.0**, and Tinfoil **1.3.0**. These are
historical observations, not a claim that every current change has live coverage:

- A folder-installed Page mounted in the host sandbox and discovered sessions.
  Dedicated synthetic sessions established real addressed dispatch and history
  retrieval. Repeating the exact request ID returned the original receipt and
  left one copy of the user message; another test session remained empty.
- Attested `decision-large` returned a selected destination in the Page; attested
  `deepseek-v4-1-flash` returned a reviewable aside proposal. Review populated the
  form without creating or sending. These checks do not establish the complete
  live aside-creation outcome contract or the present multi-turn/guidance behavior.
- Real native text deltas grew the same assistant message across several
  `/updates` snapshots before committed history caught up. Targeted stop returned
  `stopped` during that generation. Only a dedicated test session was interrupted.
- Synthetic live requests verified EHBP initialization, discrete routing,
  management proposal shape, and the bundled service module's inference path.
  Model-catalog reads carried no prompt data. No real user conversation was used
  in these inference checks.

There is **no new live ABORT/recovery quality validation**. Current guidance,
explanation, and multi-turn contract coverage is synthetic; historical live
inference is not evidence that every prompt instruction is obeyed. Timing samples
are not performance guarantees. Mobile extension loading and other host versions
are not established by these checks.

## Manual acceptance for a release

Use explicitly named synthetic test sessions and verify outcomes in their original
provider history. Do not send to existing user work.

1. Merge two sessions, refresh without duplication, and preserve reading position
   unless already following the newest messages. Check a narrow viewport,
   keyboard access, legible source labels, and focused typing.
2. Cold-start Enter must not invent a destination. Unselected Enter requires the
   exact current settled recommendation to match the last accepted recipient.
   Ctrl+number, the dropdown, and Reply here only select; Enter then honors that
   selection despite model disagreement or unavailability. Stable slots do not
   silently renumber after updates/removal.
3. Verify duplicate keypresses, failed/uncertain delivery, and edits/selections
   made during an in-flight send. Success must not erase newer composition state.
4. Confirm selected-session partial streaming and targeted stop, then exercise
   explicit polling fallback and per-session history errors. A connection change
   must not carry an old runtime's destination or display context forward.
5. Review an aside's project/title/prompt, create it explicitly, and inspect all
   SDK outcome fields. Confirm it remains independently usable in OpenChamber.
6. Review guidance proposals separately from saving. Confirm stale/conflicting
   edits survive for reconciliation and guidance never enters dispatched text.
7. Confirm failed live operations remain failures, demo routing stays labeled,
   and release artifacts contain no local state, credentials, or transcripts.

The expected behavior is specified in [dispatch intent](dispatch-intent.md),
[backend](backend.md), [routing recovery](routing-recovery.md), and
[trusted inference](tinfoil.md). Record separately whether a release check reached
a real provider or only fixtures.
