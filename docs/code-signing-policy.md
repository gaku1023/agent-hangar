# Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

Status: agent-hangar has applied to SignPath Foundation for code signing of its Windows releases.
Until signing starts, the Windows installer is unsigned, as described in the [README](../README.md#入れる).
This page states the rules that apply once the Windows releases are signed.

## What is signed

Only Windows files built from this repository's source code are signed with the SignPath Foundation certificate.

| File | What it is |
| --- | --- |
| `Hangar-vX.Y.Z-windows-x64-setup.exe` | The Windows installer (NSIS), published on [GitHub Releases](https://github.com/gaku1023/agent-hangar/releases). |
| `hangar-desktop.exe` | The desktop app installed by the installer. |

The installer also contains prebuilt binaries of upstream open source projects (for example, native Node.js modules used by the bundled server).
They are included as published by their projects and are not signed with this certificate.

macOS builds are not covered by this policy.
They are signed with the project's own certificate, as described in [signing.md](signing.md).

## How releases are built

- Every release is built from a tagged commit of this repository on GitHub-hosted runners, by the public workflow [`.github/workflows/release.yml`](../.github/workflows/release.yml).
  The Windows installer is built by [`.github/actions/windows-installer`](../.github/actions/windows-installer/action.yml), the same steps that CI runs on every change.
- Before building, the workflow checks that the CI run for the tagged commit has passed.
- Build scripts, the workflow files and the lockfiles (`package-lock.json`, `apps/desktop/src-tauri/Cargo.lock`) are part of the repository, so anyone can rebuild a release from its tag and compare.
- Updates installed by the app are also checked against the updater signature published with each release.

## Team roles and members

agent-hangar is maintained by one person.

| Role | Members |
| --- | --- |
| Committers and reviewers | [gaku1023](https://github.com/gaku1023) |
| Approvers | [gaku1023](https://github.com/gaku1023) |

- Changes reach `main` through pull requests, which the maintainer reviews and merges.
  Some changes are prepared with AI coding assistants; they go through the same pull requests and review.
- Every release is signed only after the approver manually approves the signing request in SignPath.
- All team members use multi-factor authentication for GitHub and SignPath.

## Privacy policy

agent-hangar does not transfer information to other networked systems unless it is requested by the user or the person installing or operating it, with the exceptions listed below.
Each exception can be turned off.

There is no telemetry.
agent-hangar has no usage analytics, crash reporting or advertising, and does not load fonts or other resources from outside services.
The local server listens on `127.0.0.1` only (`packages/server/src/boot/http.ts`), and its connections to Codex, opencode and the default summary engine stay on `127.0.0.1`.

### Enabled by default

**Update check (GitHub).**
The desktop app downloads the update manifest `latest.json` from this repository's GitHub Releases when it starts and every 6 hours after that.
The request URL contains no user or device data.
An update is downloaded only when you choose to install it, and its signature is verified before installing.
The app also checks once when it fails to start, so that a broken version can still be replaced.
To turn off the automatic checks, switch off **Settings › About Hangar › Notify about updates**.
The single check after a failed start is not controlled by this switch.
(`apps/desktop/src-tauri/tauri.conf.json`, `packages/ui/src/runtime/updater.ts`, `apps/desktop/src-tauri/src/lib.rs` `check_update_after_failure`)

**Remote Control for Claude Code.**
agent-hangar itself does not connect anywhere for this.
When it starts Claude Code for an account signed in with claude.ai, it adds the `--remote-control` option, so that the conversation can also be continued from the Claude app or claude.ai/code.
Claude Code then handles that connection with Anthropic under your account.
To stop adding the option, switch off **Settings › Claude Code › Start with Remote Control**.
(`packages/server/src/config/paths.ts`, `packages/server/src/boot/runs.ts`)

### Off by default

**Cloud sync, the phone page and other PCs.**
Nothing is sent until you set up cloud sync with `hangar setup cloud` or join an existing cloud.
The destination is a Cloudflare Worker that you deploy to your own Cloudflare account.
Session transcripts, settings, rows such as session titles and project paths, requests to start sessions on your other PCs, and each PC's status (including its LAN IP addresses and SSH host key fingerprint) are encrypted on your devices before they are sent.
The Worker sees plaintext metadata only: key names, sequence numbers, timestamps, device IDs, key generation numbers and sizes.
Details are in [cloud-sync.md](cloud-sync.md).
If you pair a phone, the Worker sends notifications to the phone through its browser's Web Push service; the content is encrypted with the phone's key and the Worker cannot read it.
If you add a read-only Cloudflare API token for the usage view, the Worker queries `api.cloudflare.com` for usage and billing figures.
To stop, pause sync in **Settings › Cloud sync** or run `hangar cloud leave`.
Phone notifications can be turned off separately in the notification rules in Settings.
(`packages/server/src/boot/sync.ts`, `packages/server/src/sync/client.ts`, `packages/server/src/mobile/bell.ts`, `packages/cloud/src/push.ts`, `packages/cloud/src/usage.ts`)

Other PCs are reached only through your Worker.
A direct SSH connection between PCs exists in the code but is disabled (`packages/server/src/peer/ssh/enabled.ts`).

**Event triggers.**
Nothing is registered until you create an event on the Schedules screen, or approve one that your agent drafted.
Events need cloud sync, and their inbox URLs point to your own Worker.
For a GitHub event, agent-hangar uses your GitHub CLI (`gh api`) to add a webhook to the repository you choose, and removes it when you delete the event.
When a CI run of that repository finishes, it also uses `gh api` to read the check suites of the commit.
GitHub, or an outside service you give an inbox URL to, posts deliveries to your Worker.
The Worker encrypts each delivery with your PC's inbox key before storing it, so it cannot read the content.
To stop, delete the events on the Schedules screen; leaving cloud sync also stops them.
(`packages/server/src/event/githubHooks.ts`, `packages/server/src/event/puller.ts`, `packages/cloud/src/inbox.ts`)

**Summaries.**
The summary engine is off by default.
If you choose **Claude**, agent-hangar runs `claude -p`, and the transcript goes to Anthropic through your own Claude Code.
If you choose an **OpenAI-compatible URL**, only addresses on this computer are accepted unless you turn on **Allow external summary engines**.
(`packages/server/src/config/paths.ts`)

**Reports to the author.**
When you ask your agent to report a bug or request a feature, it uses the hangar MCP tools to draft a GitHub issue for this repository.
Private information such as your home directory, user name, host name and project names is masked in the draft.
While drafting, agent-hangar searches GitHub's public issue search for similar open issues, using up to six words of the masked title.
The draft is submitted only after you approve it: with the GitHub CLI signed in, it creates the issue under your GitHub account; otherwise it opens the prefilled GitHub page in your browser, where you submit it yourself.
(`packages/server/src/report/github.ts`, `packages/server/src/report/service.ts`, `packages/server/src/report/real.ts`)

### Programs that agent-hangar starts

Claude Code, Codex, opencode, git, the GitHub CLI and wrangler communicate on their own, according to their own settings.
That communication is not covered by this policy.

A Japanese description of the files agent-hangar writes and the places it connects to is in [files-and-network.md](files-and-network.md).
