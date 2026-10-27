# AGENTS.md - Monthly Monitoring Testing System

This repository is one reusable audit engine with one config file per client project.
Read these, in order, before changing anything:

1. `CLAUDE.md` - how a monthly run is requested and delivered, and the safety rules.
2. `docs/DEVELOPER_GUIDE.md` - what every folder and file does, and where to change things.
3. `docs/PROJECT_CONTEXT.md` - client background, preferences and per-project facts.

Run an audit: `node engine/run-audit.js --url <url> --month <YYYY-MM> --outputs technical,client`.
Run the tests: `npm test`.
