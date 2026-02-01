# Google Drive Sync — Setup Guide

Step-by-step instructions to enable Google Drive sync for TabKebab.

---

## Step 1: Create a Google Cloud project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click the project dropdown (top left) > **New Project**
3. Name it `TabKebab` (or anything you like)
4. Click **Create**, then select it as the active project

## Step 2: Enable the Google Drive API

1. In the Cloud Console, go to **APIs & Services** > **Library**
2. Search for **Google Drive API**
3. Click it, then click **Enable**

## Step 3: Configure the OAuth consent screen

1. Go to **APIs & Services** > **OAuth consent screen**
2. Select **External** (unless you have a Google Workspace org), click **Create**
3. Fill in:
   - **App name:** `TabKebab`
   - **User support email:** your email
   - **Developer contact email:** your email
4. Click **Save and Continue**
5. On the **Scopes** page, click **Add or Remove Scopes**
   - Search for `drive.file` and check it
   - Or manually add: `https://www.googleapis.com/auth/drive.file`
   - Click **Update**, then **Save and Continue**
6. On the **Test users** page:
   - Add your own Google email for testing
   - Click **Save and Continue**
7. Review and click **Back to Dashboard**

## Step 4: Create OAuth 2.0 credentials

1. Go to **APIs & Services** > **Credentials**
2. Click **Create Credentials** > **OAuth client ID**
3. Select **Chrome Extension** as the application type
4. Enter the **Item ID** of your extension:
   - For local dev: go to `chrome://extensions`, find TabKebab, copy the ID (e.g., `abcdefghijklmnopqrstuvwxyzabcdef`)
   - For Web Store: use the ID from your Chrome Web Store listing
5. Click **Create**
6. Copy the **Client ID** (looks like `123456789-xxxxx.apps.googleusercontent.com`)

## Step 5: Add the Client ID to manifest.json

Open `manifest.json` and replace the placeholder:

```json
"oauth2": {
  "client_id": "YOUR_ACTUAL_CLIENT_ID.apps.googleusercontent.com",
  "scopes": [
    "https://www.googleapis.com/auth/drive.appdata"
  ]
}
```

## Step 6: Test locally

1. Reload the extension in `chrome://extensions`
2. Open TabKebab side panel
3. Go to the sync/settings area and click **Connect Google Drive**
4. A Google sign-in popup should appear
5. Grant access to the `drive.appdata` scope
6. Sync should now work

## Step 7: Publish the consent screen (before Web Store release)

While in testing mode, only the test users you added can authorize.
Before publishing to the Chrome Web Store:

1. Go to **OAuth consent screen**
2. Click **Publish App**
3. Google may require a verification review if you have sensitive scopes
   - `drive.file` is a **recommended scope** — less restrictive review than `drive.appdata`
   - You may still need to provide: privacy policy URL and homepage
   - Review typically takes **a few days**

## Notes

- The `drive.file` scope only allows access to files the extension itself created. TabKebab cannot see, read, or modify any other files in the user's Drive.
- The extension creates a visible **TabKebab** folder in the user's Drive root containing: `tabkebab-sync.json` (sessions + groups) and any exported files.
- Users can browse, back up, or delete these files directly in Google Drive.
- Syncing works across multiple computers logged into the same Google account.
- If you want to skip Drive sync entirely, remove the `identity` permission and `oauth2` block from manifest.json.
