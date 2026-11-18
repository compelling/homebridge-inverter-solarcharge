# Instructions

- Never create git commits, and never ask whether to commit. The user handles all commits.
- **Homebridge runs on Raspberry Pi, not locally.** Never search the local filesystem for Homebridge config.json or other runtime files. Always ask the user to SSH into the Pi if you need to inspect runtime state.
- **TypeScript code style:** Use single quotes (`'`) for strings, not double quotes (`"`). This applies to string literals in code and in JSDoc comments.

