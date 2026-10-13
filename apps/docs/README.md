# egy-pay documentation site

This is the public documentation site for egy-pay, built with Next.js, Fumadocs, and local MDX content.

## Commands

Run these from the monorepo root:

- pnpm docs:dev starts the site locally.
- pnpm docs:build builds the production site.
- pnpm --filter @egy-pay/docs typecheck checks the app and generated MDX types.

## Content

Edit guide pages in content/docs. The sidebar order is defined by content/docs/meta.json. Copyable setup prompts for Codex, Claude Code, and OpenCode live under content/docs/ai-agents.

Fumadocs provides MDX rendering, the docs navigation, local search, table of contents, and machine-readable LLM routes. The theme and homepage are customized for egy-pay.

## Deployment

The app is intended to deploy as a Next.js project on Vercel. Configure the Vercel project root directory as apps/docs; keep the pnpm workspace lockfile at the repository root.
