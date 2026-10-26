# Contributor integration guide

Maxwell is an OpenChamber Page plus a host-managed auxiliary service. Original
messages stay in provider sessions; the merged view references them. Reading or
dispatching never copies mixed scrollback into a destination prompt.

## Build, test, and install

Use Node.js **22.18+** and npm. Browser tests
use installed Google Chrome by default; `PLAYWRIGHT_CHANNEL` selects another
installed Playwright-supported channel, such as `msedge`.

```sh
npm ci
npm run check
npm test
npm run build
```

Build produces the browser and service bundles in place; generated bundles and
local runtime state are Git-ignored. See [verification](verification.md) for
coverage and live-test limits.

In OpenChamber **Settings → Extensions → Add**, choose the built project folder
by filesystem path and approve the requested capabilities. Keep the checkout in
place while installed. Open the Maxwell Page;
configure the [provider connection](backend.md) and [Tinfoil key](tinfoil.md).
The manifest requires OpenChamber 2.5.0+; the checked desktop host is 2.5.1.
Desktop/web Pages are supported; mobile extension loading is not supported by
the checked host contract.

For a synthetic preview, run `npm run build`, then `npm run dev`, and open
`http://127.0.0.1:4318/?demo=1`. The preview requires built bundles, has no watch
mode, and provides no host connection or real inference. After folder-install
edits, rebuild and reload the Page. For service edits, also pause/resume the
extension in Settings to restart its process.

## Boundaries and source layout

```text
panel/ → host.serviceRequest() → OpenChamber proxy → service/
```

- `panel/main.ts` owns the merged view, selection, composer, and management UI.
  The public SDK discovers projects/sessions and creates new sessions.
- `service/main.ts` owns explicitly configured OpenCode V2 history, addressed
  dispatch, interruption, and authenticated HTTP endpoints.
- `service/updates.ts` maintains upstream events and bounded selected snapshots.
- `service/tinfoil.ts` handles attested recommendations, explanations, and
  management proposals; `service/guidance.ts` persists revisioned guidance.

The host owns process lifecycle and authenticated transport; Maxwell owns the
provider adapter. This separation avoids a second manually managed daemon.
The first approved service request starts the process lazily. The host supplies
`OPENCHAMBER_SERVICE_PORT` and `OPENCHAMBER_SERVICE_TOKEN`; the service binds
loopback and authenticates every route, including health. The Page sees neither
that token nor the service port. Request bodies passed to `serviceRequest` are
JSON strings. The host bridge is request/response, not Page-facing SSE.

Host-managed services have the OS user's access, not a sandbox. Restricted
environment inheritance does not supply provider credentials. There is no generic
authenticated session callback supplied automatically: configure the service's
host API connection explicitly. Never dispatch by switching the host's active
chat. Session identity includes provider/runtime and directory, not just title.
Connection changes invalidate old display and routing context.

## Aside creation

An aside is an independent session, not a history fork. The Page calls
`host.startSession` with `projectId`, `providerId:'maxwell'`, a unique `id`,
`title`, `url:''`, optional initial `text`, and `navigation:'preserve'`.
The SDK attachment-shaped request also creates linked metadata. Nonempty `text`
becomes the initial user message through the host's normal send path. A leading
slash may invoke host commands; standing project knowledge or goal context may
also apply. Maxwell adds neither mixed history nor its private guidance.

The SDK cannot select model/agent in this request. The host captures its default
send selection before creation: configured defaults, then current/last-used model
and available agent fallbacks. It is not necessarily the destination project's
preference. The initial title includes the request ID and title.

Inspect `{sessionId,directory,sent,linked,worktree?,failure?}`. `sent` can be
`sent`, `no-model`, `skipped`, or `failed`; a failed first send does not undo
creation, and `linked:false` does not mean no session exists. A timeout is not
rollback. Inspect the returned session before repeating creation.

## Operator installation API

The Settings UI is the ordinary setup path. An authorized operator can instead
use `POST /api/guests` with `{"path":"/absolute/path/to/built-extension"}`.
HTTP 201 returns `{guest}` and registers the folder in place. Use its returned
`guest.id`. After human approval, `PUT /api/guests/{id}/capabilities` with
`{"granted":guest.capabilities.requested}` grants the complete requested list
(currently sessions, prompt, and implicitly service). Partial/extra grants fail;
an empty list revokes approval and stops the service. `PUT /api/guests/{id}/enabled`
with `{"enabled":true}` enables it; `GET /api/guests` lists installations.
Conflicts return 409. `replace:true` permits replacement but has uninstall
semantics for a different installation with the same ID.

## Upstream reference scope

The integration uses `@openchamber/sdk` 2.5.0 and OpenCode V2, not V1.
Host contracts were checked against OpenChamber commit
`57281dba9b2f89ddf8e777354f932b12b2e3df85`, particularly
`packages/ui/src/lib/guests/start-session.ts`, `defaultSendSelection.ts`, and
`packages/web/server/lib/{guests,opencode,client-auth}`.
See the [extension guide](https://docs.openchamber.dev/sdk/),
[host SDK](https://docs.openchamber.dev/sdk/host/), and
[OpenCode V2 API](https://opencode.ai/v2/docs/api). A newer upstream feature
does not establish support in an installed host.
