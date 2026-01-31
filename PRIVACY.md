# Privacy Policy

**Last updated:** January 31, 2026

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
| **AI response cache** | A local LRU cache (max 200 entries, 24-hour expiry) of AI responses to avoid redundant API calls |
| **Drive sync state** | Whether Google Drive sync is connected and last sync timestamp |
| **Install ID** | A random UUID generated once per browser profile, used as a fallback encryption key if you don't set a passphrase |

### Chrome session storage (`chrome.storage.session`)

Decrypted AI API keys are held in session storage while the extension is active. This storage is automatically wiped every time Chrome's service worker restarts (browser restart, idle timeout, etc.). Keys are never written to disk in plaintext.

### IndexedDB (`TabKebabStash`)

Stashed tabs are stored in an IndexedDB database on your device. Each stash contains the same kind of data as a session snapshot: tab URLs, titles, favicon URLs, pinned state, and group metadata.

### API key encryption

If you use AI features, your API key is encrypted with AES-GCM (256-bit) using PBKDF2 key derivation (100,000 iterations, SHA-256). You can optionally set a passphrase for encryption; otherwise the per-profile install ID is used. The plaintext key is never persisted to disk.

---

## Data that leaves your device

### AI providers (opt-in only)

If — and only if — you enable AI features and configure an API key, the extension sends requests to your chosen provider:

- **OpenAI** (`api.openai.com`)
- **Anthropic Claude** (`api.anthropic.com`)
- **Google Gemini** (`generativelanguage.googleapis.com`)
- **Custom endpoint** (whatever URL you configure, e.g. a local Ollama instance)
- **Chrome Built-in AI** — runs entirely on-device, nothing sent over the network

**What is sent:** A prompt containing tab titles, simplified URLs (hostname + path), and/or your natural-language command. Your API key is sent in the request header for authentication.

**What is NOT sent:** Browsing history, page content, cookies, passwords, form data, or any data beyond tab titles and URLs relevant to the specific AI request.

Each provider has its own privacy policy that governs how they handle the data you send them. We have no control over that.

### Google Drive sync (opt-in only)

If you connect Google Drive, the extension creates a **TabKebab** folder in your Drive and stores JSON files there (sync data, exported sessions, exported stashes). The folder is fully visible in your Drive — you can browse, back up, or delete the files yourself. The sync uses a `drive.file` OAuth scope — the extension can only access files it created, never any other file in your Drive. This also lets you sync across multiple computers logged into the same Google account.

Google's own privacy practices apply to data stored on Google Drive.

### Chrome itself

Chrome may collect its own telemetry, sync data, or diagnostics depending on your browser settings. That is between you and Google and is entirely outside the scope of this extension.

### Export files

When you export sessions or stashes, a JSON file is downloaded to your computer. Where that file goes after that is up to you.

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
