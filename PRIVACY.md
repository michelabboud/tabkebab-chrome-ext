# Privacy Policy

**Last updated:** July 19, 2026

## The short version

TabKebab collects **zero** data. No telemetry, no analytics, no tracking, no cookies, no fingerprinting, no crash reports — nothing. We have no servers. We have no database. We don't even have a website that phones home. Everything stays on your machine unless you explicitly choose otherwise.

---

## Data we collect

None.

---

## Data stored locally on your device

All extension data lives inside your browser profile and never leaves it unless you take an explicit action (enable AI features, connect Google Drive, or export a file).

### Chrome local storage (`chrome.storage.local`)

| Data | What it contains |
|------|-----------------|
| **Sessions** | Snapshots of your open windows, tabs (URL, title, favicon URL, pinned state), and tab group metadata (name, color) |
| **Manual groups** | Custom tab groups you create (group name, color, tab URLs) |
| **Keep-awake domains** | The list of domains you protect from tab sleep (e.g. `gmail.com`) |
| **AI settings** | Your chosen provider, model, and encrypted API key (if AI features are enabled) |
| **AI response cache** | A local LRU cache (max 200 entries, 24-hour expiry) of AI responses keyed by a SHA-256 request identity to avoid redundant API calls |
| **Drive sync state** | Whether Google Drive sync is connected and last sync timestamp |
| **Install ID** | A random UUID generated once per browser profile, used as a fallback encryption key if you don't set a passphrase |

### Chrome session storage (`chrome.storage.session`)

Decrypted AI API keys are held in session storage while the extension is active. They survive an ordinary service-worker idle timeout or restart, so background suspension does not repeatedly lock the provider. Chrome clears extension session storage on a full browser restart, extension reload, extension update, or disable. Keys are never written to disk in plaintext.

### IndexedDB (`TabKebabStash`)

Stashed tabs are stored in an IndexedDB database on your device. Each stash contains the same kind of data as a session snapshot: tab URLs, titles, favicon URLs, pinned state, and group metadata.

### API key encryption

If you use AI features, your API key is encrypted with AES-GCM (256-bit) using PBKDF2 key derivation (100,000 iterations, SHA-256). You can use a passphrase you know or device protection backed by the random per-profile install ID. Changing protection for stored keys requires entering every affected key so all ciphertext is replaced atomically. The plaintext key is never persisted to disk.

Only a secret-free public projection of AI settings crosses ordinary runtime responses. A newly entered key and passphrase exist in one panel-to-worker save request solely so the worker can validate and encrypt them; neither value is echoed in a response or logged. The encrypted settings commit occurs once, and the session cache is updated only afterward. A session-cache failure leaves valid encrypted settings committed but locked.

---

## Data that leaves your device

### AI providers (opt-in only)

If — and only if — you enable AI features and use a network-backed provider, the extension sends requests to your chosen provider. OpenAI, Claude, and Gemini require an API key; a Custom endpoint may be configured with or without one:

- **OpenAI** (`api.openai.com`)
- **Anthropic Claude** (`api.anthropic.com`)
- **Google Gemini** (`generativelanguage.googleapis.com`)
- **Custom endpoint** (a remote HTTPS URL you configure, or an HTTP loopback development URL such as local Ollama)
- **Chrome Built-in AI** — runs entirely on-device, nothing sent over the network

**What is sent:** A prompt containing tab titles, simplified URLs (hostname + path), and/or your natural-language command. When a key is configured, it is sent in a request header for authentication. Google Gemini uses the `x-goog-api-key` header; credentials are not placed in request URLs.

**What is NOT sent:** Browsing history, page content, cookies, passwords, form data, or any data beyond tab titles and URLs relevant to the specific AI request.

Each provider has its own privacy policy that governs how they handle the data you send them. We have no control over that.

Remote Custom endpoints must use HTTPS. HTTP is allowed only for loopback hosts; URLs containing embedded credentials, query strings, or fragments are rejected. Changing a stored Custom endpoint to another origin requires a replacement key, and portable import cannot redirect a preserved local key across origins. Provider failures are reduced to safe typed errors, and both successful and cached responses are rejected if they reflect a submitted credential. Legacy response-cache entries are cleared on extension update.

### Google Drive sync (opt-in only)

If you connect Google Drive, the extension creates a **TabKebab** folder in your Drive and may store sync data, settings, exported sessions and stashes, bookmark snapshots, portable exports, and optional bookmark HTML pages there. The folder is fully visible in your Drive — you can browse, back up, or delete the files yourself. The sync uses a `drive.file` OAuth scope — the extension can only access files it created, never any other file in your Drive. This also lets you sync across multiple computers logged into the same Google account.

Google's own privacy practices apply to data stored on Google Drive.

### Chrome itself

Chrome may collect its own telemetry, sync data, or diagnostics depending on your browser settings. That is between you and Google and is entirely outside the scope of this extension.

### Export files

When you export data, a JSON file is downloaded to your computer. A full backup can contain tab URLs and titles from sessions and stashes, custom groups, keep-awake domains, local bookmark snapshots, general settings, Focus preferences/history, and non-secret AI provider/model configuration. Individual session, stash, and settings exports contain only their named section.

Portable files never include API keys (encrypted or plaintext), passphrase metadata, decrypted-key session caches, OAuth tokens/state, Drive connection/profile state, install identifiers, active Focus state, or AI response caches. Import files are still untrusted input: TabKebab enforces a 25 MiB file limit, validates the complete document in both the panel and service worker, and changes only the repositories named by the file kind.

Exporting does not upload the file anywhere. Where the downloaded file goes after that is up to you, so treat a full backup as sensitive because it can contain browsing URLs, titles, and Focus history.

### Release verification evidence

The repository's CI/GitHub release-candidate archive contains only the manifest,
service worker, runtime `core/` and `sidepanel/` sources, and icons. It never contains tests,
documentation, browser profiles, credentials, or smoke-test evidence. Release
verification records only redacted identities and counters such as the release
commit, package hash, browser/OS version, expected versus actual outcome, and
cleanup status. It must not record browsing history, API keys or passphrases,
OAuth tokens, authorization headers, private Drive payloads, or private prompt
content.

---

## Data we send to ourselves

Nothing. There is no "home" to phone. No analytics endpoint, no error reporting service, no update pinger, no usage counter. The extension has no backend infrastructure of any kind.

---

## Third-party services

TabKebab does not embed any third-party SDKs, tracking pixels, ad networks, or analytics libraries. The only external network calls are the ones described above (AI providers and Google Drive), both of which require your explicit opt-in.

---

## Children's privacy

We don't collect data from anyone, including children.

---

## Changes to this policy

If this policy changes, the update will be committed to this repository with a clear diff.

---

## Disclaimer

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NONINFRINGEMENT.

IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT, OR OTHERWISE, ARISING FROM, OUT OF, OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR INABILITY TO USE THE SOFTWARE.

**Use TabKebab entirely at your own risk.** The authors take no responsibility for any data loss, tab loss, browser issues, API charges from third-party providers, or any other consequences arising from the use of this extension.
