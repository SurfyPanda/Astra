# ASTRA — current stabilization state

Updated October 5, 2026.

## Completed in this revision

- Reworked the frontend into a cleaner personal-AI workspace with a focused conversation view, presence panel, core status, quick actions, and a redesigned composer.
- Made the manual microphone the primary reliable voice interface for now.
- Removed manual-mic dependence on the experimental wake-word controller from the active UI path.
- Added microphone permission checking before starting speech recognition.
- Made one-shot speech recognition lifecycle deterministic: one recognizer, explicit generation guard, duplicate-submit protection, clear start/end/error states.
- Improved voice error messages and visible voice state.
- Fixed the React streaming-message race by updating assistant output through stable message IDs instead of stale array indexes.
- Added stable IDs to chat messages so React does not reuse message rows by array index.
- Preserved the existing experimental wake-word code in the repository, but it is intentionally paused in the current frontend.

## Current product state

- Text chat UI: ready, subject to the configured backend model.
- Manual microphone: primary voice path.
- Browser wake word: paused/experimental.
- External model API: not added by this revision.
- Desktop automation: retained in the backend.

## Verification

Frontend source files were syntax-checked successfully with the TypeScript compiler parser.

A full Vite production build could not be completed in this Linux environment because the archived `node_modules` lacks the Linux Rollup optional native package, and reinstalling packages requires network access. The backend could not be compiled here because the .NET SDK is not installed in the environment.

Before deployment, run:

```bash
cd frontend
npm install
npm run build
```

and, on a machine with the .NET SDK:

```bash
dotnet build backend
```
