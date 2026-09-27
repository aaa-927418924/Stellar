# Stellar

A local Windows study app that turns questions into interactive lessons and quizzes with the OpenCode CLI.

Describe a topic you want to learn, explore the generated HTML lesson, ask follow-up questions, and revisit what you learned through a quiz library and daily review.

> [!NOTE]
> Stellar is under development. Features and data formats may change in future versions.
>
> **The application interface is currently available in Japanese only.** There is no downloadable GitHub release yet.

## Features

* Generate interactive HTML lessons from a chat prompt and revise them as you learn
* Ask questions about a lesson or use a question-only chat
* Create quizzes in chat, check answers, and keep an answer history
* Revisit lessons and retry quizzes from the library with empty answer fields
* Build a daily review from previous answers, with optional AI-generated variations
* Start additional review sessions after finishing the daily review
* Attach files, pin chats to the sidebar, and export lessons as standalone HTML files
* Check GitHub Releases for desktop updates and update from the app when a newer version is available

## What Makes Stellar Different

### Lessons You Can Explore

Stellar generates a self-contained HTML lesson that you can use alongside the conversation. You can interact with the lesson, ask for clarification, request changes, and save the HTML for use outside the app.

### Practice Based on Your History

Quiz answers are saved locally. The library lets you retry previous questions without carrying over earlier answers, while the daily review selects questions using your answer history and the time since you last practiced. You can turn AI-generated variations on or off.

### Local Data Storage

The app and its server run on your PC. Chat, lesson, and review data are stored separately from the executable:

| How you run Stellar | Data folder |
| --- | --- |
| Windows desktop executable | `%APPDATA%\Stellar\data` |
| From source | `data/` inside the repository |

The desktop edition also keeps its WebView profile under `%LOCALAPPDATA%\Stellar\webview` and unpacks its bundled server under `%LOCALAPPDATA%\Stellar\runtime`. Data from older builds in `%APPDATA%\StudyApp` is left in place but is not loaded automatically. Source runs and desktop runs use separate histories. The repository ignores `data/` and built files in `dist/`.

Stellar requires an internet connection for AI features. Prompts and attachments are sent to the provider of the model you select through OpenCode. Check important generated explanations and sources against other references.

## System Requirements

* Windows 10 or Windows 11
* [OpenCode CLI](https://opencode.ai/docs/) installed, with a model configured and authenticated (`npm install -g opencode-ai` if needed)
* Node.js 20 or later and Microsoft Edge or another browser when running from source
* Microsoft Edge WebView2 Runtime when running the desktop executable
* Node.js 20 or later and .NET 8 SDK when building the desktop executable

## Installation and Usage

### Running from Source

```powershell
git clone https://github.com/aaa-927418924/Stellar.git
cd Stellar
npm start
```

You can also double-click `start-stellar.cmd`. No `npm install` is needed for a normal source run. Closing its console stops the local server. The app opens in an Edge app window if available, or in your default browser.

### Building the Windows Executable

```powershell
npm run build:exe
npm run build:window
```

Run `dist\Stellar\Stellar.exe` by itself. It contains the server, extracts it into your local application data folder, and starts and stops it with the window. You can copy this single executable to another Windows PC with WebView2 Runtime installed. OpenCode CLI and your chosen model's authentication are still required for AI features.

### Using Stellar

1. Create a chat and enter a request such as “Teach me linear functions for middle school.” Choose **教材を作る** to create a lesson. You can attach up to five files.
2. Use the preview on the right. Choose **教材について質問** for a follow-up question or **教材を更新** to change the lesson. **HTMLを保存** exports it as a standalone file.
3. Ask for practice questions and submit your answers. Open **ライブラリ** to retry saved quizzes from blank fields.
4. Open **今日の復習** to review saved questions. Once complete, **もっと復習** lets you start additional sessions. You can choose whether to include AI-generated variations.

Right-click a chat in the sidebar to pin or unpin it. Generation continues when you switch chats, and you can cancel it from the chat view.

## Desktop Updates

On launch, the desktop app checks the latest published GitHub release. If it finds a newer version with a `Stellar-win-x64.zip` asset, an update button appears at the bottom of the sidebar. Clicking it downloads the ZIP, checks the app version, replaces the executable after Stellar closes, and restarts the app. The install folder must be writable. No release or automatic download is required to run the current version; source runs do not show an update notice.

For a future release, run both build commands and then `scripts/build-release.ps1`. Attach the resulting `dist\Stellar-win-x64.zip` to a GitHub release tagged with the same version as `package.json`, for example `v0.38.0`. The ZIP contains only `Stellar.exe` at its root.

## Development

```powershell
npm test
```

The frontend lives in `public/` (plain HTML, CSS, and JavaScript), the local Node.js API and storage logic in `server/`, and the WebView2 desktop window in `window/StudyWindow/`. The server listens on `127.0.0.1`; generated lessons are shown in a sandboxed iframe with network access restricted.

Set `STUDY_NO_BROWSER=1` to start only the server. Set `STUDY_OPENCODE_EXE` to an absolute path if OpenCode CLI is installed in a nonstandard location.
