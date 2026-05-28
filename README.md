# Fintech Radar

Reads **This Week in Fintech**, extracts funding signals with Claude, and builds a live map of companies, themes, and likely exits over time.

**Live at:** fintech-radar.ggglni.xyz

## How it works

A daily cron job reads TWIF emails, runs them through **Claude**, and updates the map automatically.

## Stack

Vercel · Upstash KV · Resend inbound · Anthropic Claude Sonnet

