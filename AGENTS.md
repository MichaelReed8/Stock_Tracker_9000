# Agent instructions

Read PROJECT_HANDOFF.md before starting implementation. It distinguishes accepted requirements from proposals and unverified vendor details.

## Local credentials

- Never read, search, display, copy, or include the contents of `.env.local` or any other actual credential file in model context, tool output, logs, documentation, commits, or browser assets.
- Exclude `.env` and `.env.*` from content searches. `.env.example` is a blank template and may be read.
- Do not overwrite or edit `.env.local`; the user manages it. If configuration changes are needed, update the blank template and documentation instead.
- Backend processes may load `FMP_API_KEY` at runtime from `.env.local`. The agent may run those processes without inspecting the secret. Output only sanitized results and configuration-presence status.
- Do not place a secret in a command argument, generated command text, source constant, or frontend environment variable. FMP uses an API-key query parameter: never print full authenticated request URLs or raw HTTP errors that might contain it.
- Keep the local environment file ignored by Git. Never force-add it.

These instructions and Git ignore rules are handling safeguards, not an enforced filesystem access restriction. Do not claim that they make a local secret file technically unreadable to an agent.
