# 0.3.0 validation

This release adds a CLI/npm distribution, multiple local/imported LaTeX projects, direct AI API execution and local TeX diagnostics. Original folders are edited in place; uploaded/dropped directories are copied into managed project storage. AI proposals continue to require acceptance before writing sources and support undo.

## Validation performed on November 4, 2026

- 85 automated tests passed, including existing review/compile/formula tests and new project/config/API/HTTP/CLI/environment checks.
- Mock HTTP requests verified OpenAI Chat Completions, OpenAI Responses, Anthropic Messages and Gemini generateContent formats. No paid provider request was made.
- A real browser connected to the Express app and verified project tree, PDF display, API settings and connection test against a local mock, whole-file paragraph polishing, accepted-source disk readback, undo disk readback, project switching and xelatex compilation.
- TeX Live 2025 on Windows generated PDF and SyncTeX files from isolated sample documents. No dissertation manuscript was compiled or changed.
- The final npm tarball installed 96 production packages into a fresh temporary directory with `--omit=dev`. No esbuild or pdfjs-dist package was installed for the consumer; bundled JavaScript and PDF.js resources loaded successfully.
- The installed CLI compiled a sample whose main file was in a nested directory and whose directory name contained spaces. Relative input, PDF output and source-to-PDF SyncTeX lookup passed.
- Earlier packed-install checks also booted with an empty PATH and no TeX installation, including a configuration with no open project.
- macOS and Linux directory/browser-launch behavior has unit coverage, but was not exercised on those operating systems.

## Publication

GitHub source publication and npm registry publication are separate. npm registry publication requires the maintainer to log in with `npm login`. Users can install the generated `.tgz` directly before registry publication.

```powershell
npm install -g ./latex-review-desk-0.3.0.tgz
latex-review-desk "D:/papers/example" --port 4320
```

The installed package requires Node 22.13 or newer. TeX is required for compiling papers, not for opening the app and configuring projects or AI.
